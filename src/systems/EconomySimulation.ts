import Phaser from 'phaser';
import type { EconomyBuildingType, EconomyResource } from '../data/economy';
import { ECO_BUILDING_DEFS, CHAIN_BONUS_MULTIPLIER, WAREHOUSE_CAPACITY, WAREHOUSE_BULK_BONUS } from '../data/economy';
import type { EconomyBuilding } from '../entities/EconomyBuilding';
import { FisherShip } from '../entities/FisherShip';
import type { EconomyManager } from './EconomyManager';

/*
 * ─── Economy Simulation System ───────────────────────────────────────────
 *
 * Manages all player-placed economy buildings and their production cycles.
 *
 *   - Ticks each building's cycle timer
 *   - When a producer finishes, tries to push goods to a connected consumer
 *   - Transport is immediate for now (cart visuals come in Phase 4)
 *   - Chain bonus: if goods pass through 3+ buildings, apply multiplier
 *   - Warehouse: buffers up to WAREHOUSE_CAPACITY goods, bulk-delivers
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

// ─── Production chain graph ─────────────────────────────────────────────────

/**
 * Which building consumes which resource.
 * 'goods' has no direct consumer — they go to warehouse, which
 * bulk-delivers to markets.
 */
const CONSUMER_MAP: Partial<Record<EconomyResource, EconomyBuildingType>> = {
  wheat: 'mill',
  flour: 'bakery',
  fish:  'harbor',
};

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

  /** Tracks what resource type each warehouse is storing (by building reference). */
  private warehouseResources = new WeakMap<EconomyBuilding, EconomyResource>();

  /** Fisher ships per fishery building. */
  private fisherShips = new Map<EconomyBuilding, FisherShip>();

  /** Map grid reference for ship pathfinding. */
  private grid: { type: string }[][] = [];

  constructor(economy: EconomyManager, scene: Phaser.Scene) {
    this.economy = economy;
    this.scene = scene;
  }

  /** Set the map grid for fisher ship pathfinding. */
  setGrid(grid: { type: string }[][]): void {
    this.grid = grid;
  }

  // ─── Building management ────────────────────────────────────────────────

  addBuilding(building: EconomyBuilding): void {
    this.buildings.push(building);
    // Set warehouse max inventory and clear stored resource
    if (ECO_BUILDING_DEFS[building.buildingType].isStorage) {
      building.maxInventory = WAREHOUSE_CAPACITY;
    }
    // Create a fisher ship for fishery buildings
    if (building.buildingType === 'fishery' && this.grid.length > 0) {
      const ship = new FisherShip(this.scene, building, this.grid);
      ship.setFishingDuration(building.cycleTime);
      this.fisherShips.set(building, ship);
    }
  }

  removeBuilding(building: EconomyBuilding): void {
    const idx = this.buildings.indexOf(building);
    if (idx >= 0) this.buildings.splice(idx, 1);
    // Destroy associated fisher ship
    const ship = this.fisherShips.get(building);
    if (ship) {
      ship.destroy();
      this.fisherShips.delete(building);
    }
    building.destroy();
  }

  /** Get the fisher ship for a given fishery (if any). */
  getFisherShip(building: EconomyBuilding): FisherShip | undefined {
    return this.fisherShips.get(building);
  }

  getBuildings(): readonly EconomyBuilding[] {
    return this.buildings;
  }

  /** Count buildings of a given type. Used for escalating costs. */
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
    for (const b of this.buildings) {
      const def = ECO_BUILDING_DEFS[b.buildingType];

      // Only tick producers (buildings that produce a resource)
      if (!def.produces) continue;

      // Don't produce if inventory is full
      if (b.inventory >= b.maxInventory) continue;

      // Buildings that consume a resource need input stock to produce
      if (def.consumes && b.inputStock <= 0) continue;

      // Fisher ships: use ship-based production instead of direct timer
      if (b.buildingType === 'fishery') {
        this.updateFishery(b, delta);
        continue;
      }

      b.cycleTimer += delta;
      if (b.cycleTimer >= b.cycleTime) {
        b.cycleTimer -= b.cycleTime;
        // Consume input stock for buildings that need it
        if (def.consumes) b.inputStock--;
        b.inventory++;
        b.redraw();
        this.emit({ type: 'produced', buildingType: b.buildingType, resource: def.produces, amount: 1 });
      }
    }

    // Update all fisher ships
    for (const [building, ship] of this.fisherShips) {
      const fishReady = ship.updateShip(delta);
      if (fishReady) {
        building.inventory++;
        building.redraw();
        this.emit({ type: 'produced', buildingType: 'fishery', resource: 'fish', amount: 1 });
      }
    }

    // Tick markets: slowly convert inventory to gold
    this.tickMarkets(delta);

    // Try to consume goods: move inventory from producers to consumers
    this.processConsumption();
  }

  /** Handle fishery production via fisher ship. */
  private updateFishery(building: EconomyBuilding, _delta: number): void {
    const ship = this.fisherShips.get(building);
    if (!ship) return;
    // Update fishing duration from building's cycle time (affected by upgrades)
    ship.setFishingDuration(building.cycleTime);
    // If the ship is idle, send it on a trip
    if (ship.isIdle()) {
      ship.startTrip();
    }
  }

  /** Markets convert stored goods to gold over time (tick-based, not instant). */
  private tickMarkets(delta: number): void {
    for (const b of this.buildings) {
      if (!ECO_BUILDING_DEFS[b.buildingType].isEndpoint) continue;
      if (b.buildingType !== 'market') continue; // Only market is tick-based
      if (b.inventory <= 0) continue;

      b.cycleTimer += delta;
      if (b.cycleTimer >= b.cycleTime) {
        b.cycleTimer -= b.cycleTime;
        b.inventory--;
        b.redraw();

        const def = ECO_BUILDING_DEFS[b.buildingType];
        const gold = Math.floor(def.goldPerUnit * b.valueMultiplier);
        this.economy.earn(gold);
        this.emit({
          type: 'delivered',
          buildingType: b.buildingType,
          resource: def.consumes ?? def.produces,
          amount: gold,
          pixelX: b.pixelX,
          pixelY: b.pixelY,
        });
      }
    }
  }

  // ─── Consumption / transport ────────────────────────────────────────────

  private processConsumption(): void {
    // Phase 1: Move goods from producers to warehouses (if available) or directly to consumers.
    for (const producer of this.buildings) {
      if (producer.inventory <= 0) continue;

      const resource = getProduces(producer.buildingType);
      if (!resource) continue;

      const consumerType = CONSUMER_MAP[resource];

      // Goods with no consumer (e.g. bread from bakery) go to warehouse → market.
      if (!consumerType) {
        const warehouse = this.findClosestAvailableWarehouse(producer, resource);
        if (warehouse) {
          producer.inventory--;
          warehouse.inventory++;
          this.warehouseResources.set(warehouse, resource);
          producer.redraw();
          warehouse.redraw();
          this.emit({ type: 'consumed', buildingType: 'warehouse', resource, amount: 1 });
        }
        continue;
      }

      // Raw materials: deliver directly to consumer (production chain).
      // Prefer the closest consumer that has input capacity.
      const consumers = this.buildings.filter(
        b => b.buildingType === consumerType && b.inputStock < b.maxInventory,
      );
      if (consumers.length === 0) continue;

      const consumer = this.closestBuilding(producer, consumers);
      producer.inventory--;
      consumer.inputStock++;
      producer.redraw();
      consumer.redraw();
      this.emit({ type: 'consumed', buildingType: consumer.buildingType, resource, amount: 1 });

      const consumerDef = ECO_BUILDING_DEFS[consumer.buildingType];
      if (consumerDef.isEndpoint && consumerDef.goldPerUnit > 0) {
        this.deliverToEndpoint(consumer);
      }
    }

    // Phase 2: Process full warehouses — bulk deliver to consumer with bonus.
    this.processWarehouses();
  }

  /** Find the closest building from a list. */
  private closestBuilding(from: EconomyBuilding, candidates: EconomyBuilding[]): EconomyBuilding {
    let best = candidates[0];
    let bestDist = Infinity;
    for (const c of candidates) {
      const dx = c.pixelX - from.pixelX;
      const dy = c.pixelY - from.pixelY;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  /** Find the closest warehouse that can accept this resource (empty or matching type, has space). */
  private findClosestAvailableWarehouse(from: EconomyBuilding, resource: EconomyResource): EconomyBuilding | null {
    let best: EconomyBuilding | null = null;
    let bestDist = Infinity;
    for (const b of this.buildings) {
      if (!ECO_BUILDING_DEFS[b.buildingType].isStorage) continue;
      if (b.inventory >= b.maxInventory) continue;

      const stored = this.warehouseResources.get(b);
      // Empty warehouse accepts anything; non-empty must match resource type
      if (stored !== undefined && stored !== resource) continue;

      const dx = b.pixelX - from.pixelX;
      const dy = b.pixelY - from.pixelY;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = b; }
    }
    return best;
  }

  /** Bulk-deliver goods from full warehouses to market (if available) or directly to consumer. */
  private processWarehouses(): void {
    for (const warehouse of this.buildings) {
      if (!ECO_BUILDING_DEFS[warehouse.buildingType].isStorage) continue;
      if (warehouse.inventory < warehouse.maxInventory) continue;

      const resource = this.warehouseResources.get(warehouse);
      if (!resource) continue;

      // Try market first — prefer closest non-full market
      const markets = this.buildings.filter(
        b => b.buildingType === 'market' && b.inventory < b.maxInventory,
      );
      const market = markets.length > 0 ? this.closestBuilding(warehouse, markets) : null;

      if (market) {
        // Bulk deliver to market
        const count = warehouse.inventory;
        const bonusCount = Math.floor(count * (WAREHOUSE_BULK_BONUS - 1));

        warehouse.inventory = 0;
        this.warehouseResources.delete(warehouse);
        warehouse.redraw();

        // Transfer to market (with bonus units)
        const space = market.maxInventory - market.inventory;
        const transfer = Math.min(count + bonusCount, space);
        market.inventory += transfer;
        market.redraw();

        this.emit({ type: 'consumed', buildingType: 'market', resource, amount: transfer,
          pixelX: warehouse.pixelX, pixelY: warehouse.pixelY });
        continue;
      }

      // No market — try direct consumer (legacy path), else fallback gold.
      let delivered = false;
      const consumerType = CONSUMER_MAP[resource];
      if (consumerType) {
        const consumers = this.buildings.filter(
          b => b.buildingType === consumerType && b.inputStock < b.maxInventory,
        );
        if (consumers.length > 0) {
          const consumer = this.closestBuilding(warehouse, consumers);
          const count = warehouse.inventory;
          const bonusCount = Math.floor(count * (WAREHOUSE_BULK_BONUS - 1));

          warehouse.inventory = 0;
          this.warehouseResources.delete(warehouse);
          warehouse.redraw();

          const space = consumer.maxInventory - consumer.inputStock;
          const transfer = Math.min(count, space);
          consumer.inputStock += transfer;
          consumer.redraw();

          this.emit({ type: 'consumed', buildingType: consumer.buildingType, resource, amount: transfer });

          const consumerDef = ECO_BUILDING_DEFS[consumer.buildingType];
          if (consumerDef.isEndpoint && consumerDef.goldPerUnit > 0) {
            for (let i = 0; i < transfer; i++) {
              if (consumer.inventory > 0) {
                this.deliverToEndpoint(consumer);
              }
            }
            if (bonusCount > 0) {
              const bonusGold = consumerDef.goldPerUnit * consumer.valueMultiplier * bonusCount;
              this.economy.earn(Math.floor(bonusGold));
              this.emit({
                type: 'delivered',
                buildingType: consumer.buildingType,
                resource,
                amount: Math.floor(bonusGold),
                pixelX: consumer.pixelX, pixelY: consumer.pixelY,
              });
            }
          }
          delivered = true;
        }
      }

      if (!delivered) {
        // No market and no available consumer — sell directly for gold
        const count = warehouse.inventory;
        const bonusCount = Math.floor(count * (WAREHOUSE_BULK_BONUS - 1));
        const totalGold = 12 * (count + bonusCount);

        warehouse.inventory = 0;
        this.warehouseResources.delete(warehouse);
        warehouse.redraw();

        this.economy.earn(totalGold);
        this.emit({
          type: 'delivered',
          buildingType: 'warehouse',
          resource,
          amount: totalGold,
          pixelX: warehouse.pixelX, pixelY: warehouse.pixelY,
        });
      }
    }
  }

  private deliverToEndpoint(endpoint: EconomyBuilding): void {
    const def = ECO_BUILDING_DEFS[endpoint.buildingType];
    let gold = def.goldPerUnit * endpoint.valueMultiplier;

    // Chain bonus: check if goods came through a full chain
    // (simplified: if there's both a farm AND mill for bakery, or fishery for harbor)
    if (this.hasCompleteChainBefore(endpoint)) {
      gold = Math.floor(gold * CHAIN_BONUS_MULTIPLIER);
    }

    endpoint.inventory--;
    endpoint.redraw();

    this.economy.earn(gold);
    this.emit({
      type: 'delivered',
      buildingType: endpoint.buildingType,
      resource: def.consumes ?? def.produces,
      amount: gold,
      pixelX: endpoint.pixelX,
      pixelY: endpoint.pixelY,
    });
  }

  /** Check if there's a complete production chain feeding this endpoint. */
  private hasCompleteChainBefore(endpoint: EconomyBuilding): boolean {
    const type = endpoint.buildingType;

    if (type === 'bakery') {
      // Complete chain: farm + mill + bakery all present
      return this.buildings.some(b => b.buildingType === 'farm')
        && this.buildings.some(b => b.buildingType === 'mill');
    }

    if (type === 'harbor') {
      // Complete chain: fishery + harbor
      return this.buildings.some(b => b.buildingType === 'fishery');
    }

    return false;
  }
}
