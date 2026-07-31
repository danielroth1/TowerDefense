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

  /** Tracks what resource type each market is holding (by building reference). */
  private marketResources = new WeakMap<EconomyBuilding, EconomyResource>();

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
        const resource = this.marketResources.get(b);
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
   * For each producer with inventory, find a valid target from the config.
   * Target types are tried in priority order (array order in config).
   * Within each type, the closest building with free capacity is chosen.
   */
  private processConsumption(): void {
    if (!this.transportSys) return;

    for (const producer of this.buildings) {
      if (producer.inventory <= 0) continue;

      const resource = getProduces(producer.buildingType);
      if (!resource) continue;

      const targetTypes = DELIVERY_TARGETS[resource];
      if (!targetTypes || targetTypes.length === 0) continue;

      // Try target types in priority order (array order = priority).
      // Within each type, pick the closest building with free capacity.
      for (const targetType of targetTypes) {
        const candidates = this.buildings
          .filter(b => b.buildingType === targetType)
          .filter(b => this.hasFreeCapacity(b, resource))
          .sort((a, b) => this.distSq(producer, a) - this.distSq(producer, b));

        if (candidates.length === 0) continue; // No capacity in this type, try next

        const target = candidates[0];
        const deliveryType = this.getDeliveryType(target.buildingType);

        this.reserveCapacity(target, deliveryType);

        const accepted = this.transportSys.requestDelivery(producer, target, resource, deliveryType);
        if (accepted) {
          producer.inventory--;
          producer.redraw();
        } else {
          this.releaseReservation(target, deliveryType);
        }
        break; // Dispatched to this type, move to next producer
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
   * Tries consumer buildings first (from DELIVERY_TARGETS), then markets.
   * Dispatch interval scales with warehouse level (higher = faster).
   */
  private dispatchWarehouses(delta: number): void {
    if (!this.transportSys) return;

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

      this.warehouseTimers.set(warehouse, newTimer - interval);

      const resource = this.warehouseResources.get(warehouse) ?? 'goods';

      // Build priority-ordered target list: consumers first, then markets
      const deliveryTargets = DELIVERY_TARGETS[resource];
      const targetTypes = deliveryTargets
        ? [...deliveryTargets.filter(t => t !== 'warehouse'), ...WAREHOUSE_OUTBOUND_TARGETS]
        : [...WAREHOUSE_OUTBOUND_TARGETS];

      // Try each target type in priority order, closest-first within each type
      let target: EconomyBuilding | undefined;
      let targetDeliveryType: DeliveryType = 'market';
      for (const targetType of targetTypes) {
        const candidates = this.buildings
          .filter(b => b.buildingType === targetType)
          .filter(b => this.hasFreeCapacity(b, resource))
          .sort((a, b) => this.distSq(warehouse, a) - this.distSq(warehouse, b));

        if (candidates.length > 0) {
          target = candidates[0];
          targetDeliveryType = this.getDeliveryType(targetType);
          break;
        }
      }

      if (!target) continue;

      // Reserve capacity
      this.reserveCapacity(target, targetDeliveryType);

      const accepted = this.transportSys.requestDelivery(warehouse, target, resource, targetDeliveryType);
      if (accepted) {
        warehouse.inventory--;
        warehouse.redraw();
      } else {
        this.releaseReservation(target, targetDeliveryType);
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
    if (deliveryType === 'warehouse') {
      receiver.reservedInventory = Math.max(0, receiver.reservedInventory - 1);
      receiver.inventory++;
      this.warehouseResources.set(receiver, resource);
    } else if (deliveryType === 'market') {
      receiver.reservedInventory = Math.max(0, receiver.reservedInventory - 1);
      receiver.inventory++;
      this.marketResources.set(receiver, resource);
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
