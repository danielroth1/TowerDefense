import Phaser from 'phaser';
import type { EconomyBuildingType, EconomyResource } from '../data/economy';
import {
  ECO_BUILDING_DEFS,
  WAREHOUSE_CAPACITY,
  DELIVERY_TARGETS,
  WAREHOUSE_OUTBOUND_TARGETS,
  WAREHOUSE_DISPATCH_INTERVAL,
  RESOURCE_GOLD_VALUES,
} from '../data/economy';
import type { EconomyBuilding } from '../entities/EconomyBuilding';
import { FisherShip } from '../entities/FisherShip';
import type { EconomyManager } from './EconomyManager';
import type { TransportSystem } from './TransportSystem';

/*
 * ─── Economy Simulation System ───────────────────────────────────────────
 *
 * Drives the player economy — production cycles, delivery dispatch, and
 * warehouse-to-market distribution.
 *
 * Config-driven: all delivery rules live in src/data/economy-config.json.
 *
 *   - Producers tick cycle timers → produce goods into inventory
 *   - processConsumption() dispatches carts to valid targets (config-defined)
 *   - Reservation system: goods in transit count against receiver capacity
 *   - Closest-first target selection, falls back to next closest if full
 *   - Warehouses actively dispatch carts to markets (no bulk-wait)
 *   - TransportSystem handles pathfinding and cart movement
 */

// ─── Public types ───────────────────────────────────────────────────────────

export interface EconomyEvent {
  type: 'produced' | 'consumed' | 'delivered' | 'gold';
  buildingType: EconomyBuildingType;
  resource: EconomyResource | null;
  amount: number;
  /** Pixel position for visual effects (floating text, carts). */
  pixelX?: number;
  pixelY?: number;
}

export type DeliveryType = 'consumer' | 'warehouse' | 'market';

/** Which resource each building produces. */
function getProduces(type: EconomyBuildingType): EconomyResource | null {
  return ECO_BUILDING_DEFS[type].produces;
}

// ─── Main simulation ────────────────────────────────────────────────────────

export class EconomySimulation {
  private buildings: EconomyBuilding[] = [];
  private economy: EconomyManager;
  private scene: Phaser.Scene;
  private eventListeners: Array<(e: EconomyEvent) => void> = [];

  /** Transport system for dispatching carts (set after construction). */
  private transportSys?: TransportSystem;

  /** Tracks what resource type each warehouse is storing (by building reference). */
  private warehouseResources = new WeakMap<EconomyBuilding, EconomyResource>();

  /** FIFO queue of resource types held by each market (one entry per inventory unit). */
  private marketResources = new WeakMap<EconomyBuilding, EconomyResource[]>();

  /** Fisher ships per fishery building (upgraded fisheries get 2 ships). */
  private fisherShips = new Map<EconomyBuilding, FisherShip[]>();

  /** Map grid reference for ship pathfinding. */
  private grid: { type: string }[][] = [];

  /** Per-warehouse dispatch timer (ms since last cart sent to market). */
  private warehouseTimers = new WeakMap<EconomyBuilding, number>();

  constructor(economy: EconomyManager, scene: Phaser.Scene) {
    this.economy = economy;
    this.scene = scene;
  }

  /** Set the transport system for dispatching delivery carts. */
  setTransportSystem(ts: TransportSystem): void {
    this.transportSys = ts;
  }

  /** Set the map grid for fisher ship pathfinding. */
  setGrid(grid: { type: string }[][]): void {
    this.grid = grid;
  }

  // ─── Building management ────────────────────────────────────────────────

  addBuilding(building: EconomyBuilding): void {
    this.buildings.push(building);
    if (ECO_BUILDING_DEFS[building.buildingType].isStorage) {
      building.maxInventory = WAREHOUSE_CAPACITY;
      this.warehouseTimers.set(building, 0);
    }
    if (building.buildingType === 'fishery' && this.grid.length > 0) {
      const ship = new FisherShip(this.scene, building, this.grid, 0);
      ship.setFishingDuration(building.cycleTime);
      this.fisherShips.set(building, [ship]);
    }
  }

  removeBuilding(building: EconomyBuilding): void {
    const idx = this.buildings.indexOf(building);
    if (idx >= 0) this.buildings.splice(idx, 1);
    const ships = this.fisherShips.get(building);
    if (ships) { ships.forEach(s => s.destroy()); this.fisherShips.delete(building); }
    this.warehouseTimers.delete(building);
    this.marketResources.delete(building);
    building.destroy();
  }

  getFisherShip(building: EconomyBuilding): FisherShip | undefined {
    return this.fisherShips.get(building)?.[0];
  }

  /** Get all fisher ships for a building (for UI camera ignore). */
  getAllFisherShips(building: EconomyBuilding): FisherShip[] {
    return this.fisherShips.get(building) ?? [];
  }

  /** Called when a fishery is upgraded — spawns an additional ship (level 2 = 2 ships). */
  onFisheryUpgraded(building: EconomyBuilding): void {
    if (building.buildingType !== 'fishery') return;
    const ships = this.fisherShips.get(building);
    if (!ships) return;
    // Level 2 gets 2 ships; higher levels could get more in the future
    const targetCount = building.level;
    while (ships.length < targetCount) {
      const ship = new FisherShip(this.scene, building, this.grid, ships.length);
      ship.setFishingDuration(building.cycleTime);
      ships.push(ship);
    }
  }

  getBuildings(): readonly EconomyBuilding[] {
    return this.buildings;
  }

  countOfType(type: EconomyBuildingType): number {
    return this.buildings.filter(b => b.buildingType === type).length;
  }

  onEvent(fn: (e: EconomyEvent) => void): void {
    this.eventListeners.push(fn);
  }

  private emit(e: EconomyEvent): void {
    for (const fn of this.eventListeners) fn(e);
  }

  // ─── Update loop ────────────────────────────────────────────────────────

  update(delta: number): void {
    // ── 1. Tick production cycles ──────────────────────────────────────
    for (const b of this.buildings) {
      const def = ECO_BUILDING_DEFS[b.buildingType];
      if (!def.produces) continue;
      if (b.inventory >= b.maxInventory) continue;
      if (def.consumes && b.inputStock <= 0) continue;

      if (b.buildingType === 'fishery') {
        this.updateFishery(b, delta);
        continue;
      }

      b.cycleTimer += delta;
      if (b.cycleTimer >= b.cycleTime) {
        b.cycleTimer -= b.cycleTime;
        if (def.consumes) b.inputStock--;
        b.inventory++;
        b.redraw();
        this.emit({ type: 'produced', buildingType: b.buildingType, resource: def.produces, amount: 1 });
      }
    }

    // ── 2. Fisher ships ────────────────────────────────────────────────
    for (const [building, ships] of this.fisherShips) {
      for (const ship of ships) {
        const fishReady = ship.updateShip(delta);
        if (fishReady) {
          building.inventory++;
          building.redraw();
          this.emit({ type: 'produced', buildingType: 'fishery', resource: 'fish', amount: 1 });
        }
      }
    }

    // ── 3. Dispatch producer goods via carts ───────────────────────────
    this.processConsumption();

    // ── 4. Warehouse → market dispatch ─────────────────────────────────
    this.dispatchWarehouses(delta);

    // ── 5. Market gold conversion ──────────────────────────────────────
    this.tickMarkets(delta);
  }

  // ─── Fishery ────────────────────────────────────────────────────────────

  private updateFishery(building: EconomyBuilding, _delta: number): void {
    const ships = this.fisherShips.get(building);
    if (!ships || ships.length === 0) return;
    for (const ship of ships) {
      ship.setFishingDuration(building.cycleTime);
      if (ship.isIdle()) ship.startTrip();
    }
  }

  // ─── Markets ────────────────────────────────────────────────────────────

  private tickMarkets(delta: number): void {
    for (const b of this.buildings) {
      if (!ECO_BUILDING_DEFS[b.buildingType].isEndpoint) continue;
      if (b.buildingType !== 'market') continue;
      if (b.inventory <= 0) continue;

      b.cycleTimer += delta;
      if (b.cycleTimer >= b.cycleTime) {
        b.cycleTimer -= b.cycleTime;
        b.inventory--;
        b.redraw();

        const def = ECO_BUILDING_DEFS[b.buildingType];
        const resource = this.marketResources.get(b)?.shift();
        const baseValue = resource ? RESOURCE_GOLD_VALUES[resource] : def.goldPerUnit;
        const gold = Math.floor(baseValue * b.valueMultiplier);
        this.economy.earnFromEconomy(gold);
        this.emit({
          type: 'delivered',
          buildingType: b.buildingType,
          resource: resource ?? def.consumes ?? def.produces,
          amount: gold,
          pixelX: b.pixelX,
          pixelY: b.pixelY,
        });
      }
    }
  }

  // ─── Consumption / cart dispatch ────────────────────────────────────────

  /**
   * Two-pass global closest-first delivery assignment.
   *
   * Pass 1 — All produced goods decide their next destination. For each target
   *          type, every (producer, target) pair is sorted by distance so the
   *          globally closest producer always claims limited capacity first.
   * Pass 2 — After Pass 1 reservations are made, some producing buildings may
   *          now have free room (e.g. a mill dispatched flour → inventory slot
   *          freed → can receive more wheat). Retry any remaining inventory.
   */
  private processConsumption(): void {
    if (!this.transportSys) return;

    // Pass 1: Global closest-first assignment
    this.assignDeliveriesClosestFirst();

    // Pass 2: Retry remaining inventory — some targets may have received
    // reservations in Pass 1, and some producing buildings dispatched goods
    // freeing capacity that wasn't available before.
    this.assignDeliveriesClosestFirst();
  }

  /**
   * Global closest-first delivery assignment.
   *
   * For each target type (in config priority order), builds all valid
   * (producer, target) pairs, sorts by distance ascending, and greedily
   * dispatches the closest pairs first.  This guarantees that when multiple
   * producers compete for limited capacity at the same target type, the
   * closest producer always wins — regardless of iteration order.
   */
  private assignDeliveriesClosestFirst(): void {
    if (!this.transportSys) return;

    // Collect producers that have inventory and a valid resource
    const producers = this.buildings.filter(b => {
      if (b.inventory <= 0) return false;
      const resource = getProduces(b.buildingType);
      if (!resource) return false;
      const targetTypes = DELIVERY_TARGETS[resource];
      return targetTypes && targetTypes.length > 0;
    });
    if (producers.length === 0) return;

    // Determine which target types are relevant and their priority order.
    // Priority = index in the DELIVERY_TARGETS array (lower = higher priority).
    // If a target type appears for multiple resources, use the best priority.
    const targetTypePriority = new Map<EconomyBuildingType, number>();
    for (const producer of producers) {
      const resource = getProduces(producer.buildingType)!;
      const targetTypes = DELIVERY_TARGETS[resource];
      if (!targetTypes) continue;
      for (let i = 0; i < targetTypes.length; i++) {
        const existing = targetTypePriority.get(targetTypes[i]);
        if (existing === undefined || i < existing) {
          targetTypePriority.set(targetTypes[i], i);
        }
      }
    }

    // Process target types in priority order (highest → lowest)
    const sortedTargetTypes = [...targetTypePriority.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([type]) => type);

    // Track remaining inventory per producer so we don't double-assign
    const remaining = new Map<EconomyBuilding, number>();
    for (const p of producers) remaining.set(p, p.inventory);

    for (const targetType of sortedTargetTypes) {
      // Eligible producers that can deliver to this target type
      const eligible = producers.filter(p => {
        if ((remaining.get(p) ?? 0) <= 0) return false;
        const resource = getProduces(p.buildingType)!;
        return (DELIVERY_TARGETS[resource] ?? []).includes(targetType);
      });
      if (eligible.length === 0) continue;

      // Targets of this type
      const targets = this.buildings.filter(b => b.buildingType === targetType);
      if (targets.length === 0) continue;

      // Build all valid (producer, target) pairs, sorted by distance
      interface Pair { producer: EconomyBuilding; target: EconomyBuilding; resource: EconomyResource; dist: number }
      const pairs: Pair[] = [];
      for (const producer of eligible) {
        const resource = getProduces(producer.buildingType)!;
        for (const target of targets) {
          if (this.hasFreeCapacity(target, resource)) {
            pairs.push({ producer, target, resource, dist: this.distSq(producer, target) });
          }
        }
      }

      // Sort closest-first — this is the key: closest producer always wins
      pairs.sort((a, b) => a.dist - b.dist);

      for (const { producer, target, resource } of pairs) {
        const inv = remaining.get(producer) ?? 0;
        if (inv <= 0) continue;
        if (!this.hasFreeCapacity(target, resource)) continue;

        const deliveryType = this.getDeliveryType(target.buildingType);
        this.reserveCapacity(target, deliveryType);

        const accepted = this.transportSys!.requestDelivery(producer, target, resource, deliveryType);
        if (accepted) {
          remaining.set(producer, inv - 1);
          producer.inventory--;
          producer.redraw();
        } else {
          this.releaseReservation(target, deliveryType);
        }
      }
    }
  }

  /** Map building type to delivery type for reservation tracking. */
  private getDeliveryType(type: EconomyBuildingType): DeliveryType {
    const def = ECO_BUILDING_DEFS[type];
    if (def.isStorage) return 'warehouse';
    if (def.isEndpoint) return 'market';
    return 'consumer';
  }

  // ─── Warehouse → market dispatch ────────────────────────────────────────

  /**
   * Warehouses actively dispatch carts when they have inventory.
   * Uses global closest-first assignment: when multiple warehouses compete
   * for the same target, the closest warehouse always gets priority.
   * Tries consumer buildings first (from DELIVERY_TARGETS), then markets.
   * Dispatch interval scales with warehouse level (higher = faster).
   */
  private dispatchWarehouses(delta: number): void {
    if (!this.transportSys) return;

    // ── Tick timers and collect ready warehouses ───────────────────────
    interface ReadyWarehouse {
      warehouse: EconomyBuilding;
      resource: EconomyResource;
    }
    const ready: ReadyWarehouse[] = [];

    for (const warehouse of this.buildings) {
      if (!ECO_BUILDING_DEFS[warehouse.buildingType].isStorage) continue;
      if (warehouse.inventory <= 0) continue;

      const timer = this.warehouseTimers.get(warehouse) ?? 0;
      const interval = WAREHOUSE_DISPATCH_INTERVAL / warehouse.level;
      const newTimer = timer + delta;

      if (newTimer < interval) {
        this.warehouseTimers.set(warehouse, newTimer);
        continue;
      }

      // Warehouse is ready to dispatch
      this.warehouseTimers.set(warehouse, newTimer - interval);
      const resource = this.warehouseResources.get(warehouse) ?? 'goods';
      ready.push({ warehouse, resource });
    }

    if (ready.length === 0) return;

    // ── Build combined target type priority list ───────────────────────
    // Use the first ready warehouse's resource to determine target types
    // (all warehouses store the same resource type in practice)
    const deliveryTargets = DELIVERY_TARGETS[ready[0].resource];
    const targetTypes = deliveryTargets
      ? [...deliveryTargets.filter(t => t !== 'warehouse'), ...WAREHOUSE_OUTBOUND_TARGETS]
      : [...WAREHOUSE_OUTBOUND_TARGETS];

    // ── Track remaining inventory ─────────────────────────────────────
    const remaining = new Map<EconomyBuilding, number>();
    for (const r of ready) remaining.set(r.warehouse, r.warehouse.inventory);

    // ── Global closest-first per target type ──────────────────────────
    for (const targetType of targetTypes) {
      const targets = this.buildings.filter(b => b.buildingType === targetType);
      if (targets.length === 0) continue;

      // Build all valid (warehouse, target) pairs for this target type
      interface Pair { warehouse: EconomyBuilding; target: EconomyBuilding; resource: EconomyResource; dist: number }
      const pairs: Pair[] = [];
      for (const r of ready) {
        if ((remaining.get(r.warehouse) ?? 0) <= 0) continue;
        for (const target of targets) {
          if (this.hasFreeCapacity(target, r.resource)) {
            pairs.push({ warehouse: r.warehouse, target, resource: r.resource, dist: this.distSq(r.warehouse, target) });
          }
        }
      }

      // Sort closest-first — closest warehouse always wins the slot
      pairs.sort((a, b) => a.dist - b.dist);

      for (const { warehouse, target, resource } of pairs) {
        const inv = remaining.get(warehouse) ?? 0;
        if (inv <= 0) continue;
        if (!this.hasFreeCapacity(target, resource)) continue;

        const deliveryType = this.getDeliveryType(target.buildingType);
        this.reserveCapacity(target, deliveryType);

        const accepted = this.transportSys!.requestDelivery(warehouse, target, resource, deliveryType);
        if (accepted) {
          remaining.set(warehouse, inv - 1);
          warehouse.inventory--;
          warehouse.redraw();
        } else {
          this.releaseReservation(target, deliveryType);
        }
      }
    }
  }

  // ─── Capacity & reservation ─────────────────────────────────────────────

  /** Check if a building has free capacity for an incoming delivery, including reservations. */
  private hasFreeCapacity(building: EconomyBuilding, resource: EconomyResource): boolean {
    const def = ECO_BUILDING_DEFS[building.buildingType];

    if (def.isStorage) {
      // Warehouse: check inventory + reserved, and resource type match
      const stored = this.warehouseResources.get(building);
      if (stored !== undefined && stored !== resource) return false;
      return (building.inventory + building.reservedInventory) < building.maxInventory;
    }

    if (def.isEndpoint) {
      // Market / endpoint: stores goods in inventory, not inputStock
      return (building.inventory + building.reservedInventory) < building.maxInventory;
    }

    // Consumer (production building like mill, bakery, harbor): uses inputStock
    return (building.inputStock + building.reservedInput) < building.maxInventory;
  }

  /** Increment the appropriate reservation counter. */
  private reserveCapacity(building: EconomyBuilding, deliveryType: DeliveryType): void {
    if (deliveryType === 'warehouse' || deliveryType === 'market') {
      building.reservedInventory++;
    } else {
      building.reservedInput++;
    }
  }

  /** Decrement reservation (called when cart dispatch fails). */
  private releaseReservation(building: EconomyBuilding, deliveryType: DeliveryType): void {
    if (deliveryType === 'warehouse' || deliveryType === 'market') {
      building.reservedInventory = Math.max(0, building.reservedInventory - 1);
    } else {
      building.reservedInput = Math.max(0, building.reservedInput - 1);
    }
  }

  /**
   * Called by TransportSystem when a cart arrives.
   * Releases the reservation and transfers goods into actual stock.
   */
  completeDelivery(
    receiver: EconomyBuilding,
    resource: EconomyResource,
    deliveryType: DeliveryType,
  ): void {
    // The destination building may have been sold/removed while the cart was
    // in transit. Bail out without touching its (possibly destroyed) state —
    // the caller will simply discard the cart.
    if (this.buildings.indexOf(receiver) < 0) return;

    if (deliveryType === 'warehouse') {
      receiver.reservedInventory = Math.max(0, receiver.reservedInventory - 1);
      receiver.inventory++;
      this.warehouseResources.set(receiver, resource);
    } else if (deliveryType === 'market') {
      receiver.reservedInventory = Math.max(0, receiver.reservedInventory - 1);
      receiver.inventory++;
      const queue = this.marketResources.get(receiver) ?? [];
      queue.push(resource);
      this.marketResources.set(receiver, queue);
    } else {
      // consumer
      receiver.reservedInput = Math.max(0, receiver.reservedInput - 1);
      receiver.inputStock++;
    }
    receiver.redraw();
    this.emit({
      type: 'consumed',
      buildingType: receiver.buildingType,
      resource,
      amount: 1,
      pixelX: receiver.pixelX,
      pixelY: receiver.pixelY,
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private distSq(a: EconomyBuilding, b: EconomyBuilding): number {
    const dx = b.pixelX - a.pixelX;
    const dy = b.pixelY - a.pixelY;
    return dx * dx + dy * dy;
  }
}
