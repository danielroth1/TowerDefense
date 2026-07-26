import type { EconomyBuildingType, EconomyResource } from '../data/economy';
import { ECO_BUILDING_DEFS, CHAIN_BONUS_MULTIPLIER, WAREHOUSE_CAPACITY, WAREHOUSE_BULK_BONUS } from '../data/economy';
import type { EconomyBuilding } from '../entities/EconomyBuilding';
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
}

// ─── Production chain graph ─────────────────────────────────────────────────

/** Which building consumes which resource. */
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
  private eventListeners: Array<(e: EconomyEvent) => void> = [];

  /** Tracks what resource type each warehouse is storing (by building reference). */
  private warehouseResources = new WeakMap<EconomyBuilding, EconomyResource>();

  constructor(economy: EconomyManager) {
    this.economy = economy;
  }

  // ─── Building management ────────────────────────────────────────────────

  addBuilding(building: EconomyBuilding): void {
    this.buildings.push(building);
    // Set warehouse max inventory and clear stored resource
    if (ECO_BUILDING_DEFS[building.buildingType].isStorage) {
      building.maxInventory = WAREHOUSE_CAPACITY;
    }
  }

  removeBuilding(building: EconomyBuilding): void {
    const idx = this.buildings.indexOf(building);
    if (idx >= 0) this.buildings.splice(idx, 1);
    building.destroy();
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

      b.cycleTimer += delta;
      if (b.cycleTimer >= b.cycleTime) {
        b.cycleTimer -= b.cycleTime;
        b.inventory++;
        b.redraw();
        this.emit({ type: 'produced', buildingType: b.buildingType, resource: def.produces, amount: 1 });
      }
    }

    // Try to consume goods: move inventory from producers to consumers
    this.processConsumption();
  }

  // ─── Consumption / transport ────────────────────────────────────────────

  private processConsumption(): void {
    // Phase 1: Move goods from producers to warehouses (if available) or directly to consumers.
    for (const producer of this.buildings) {
      if (producer.inventory <= 0) continue;

      const resource = getProduces(producer.buildingType);
      if (!resource) continue;

      const consumerType = CONSUMER_MAP[resource];
      if (!consumerType) continue;

      // Try warehouse first — find one that has space and either is empty
      // or already stores this resource type.
      const warehouse = this.findAvailableWarehouse(resource);
      if (warehouse) {
        // Route to warehouse
        producer.inventory--;
        warehouse.inventory++;
        this.warehouseResources.set(warehouse, resource);
        producer.redraw();
        warehouse.redraw();
        this.emit({ type: 'consumed', buildingType: 'warehouse', resource, amount: 1 });
        continue;
      }

      // No warehouse available — deliver directly to consumer
      const consumers = this.buildings.filter(
        b => b.buildingType === consumerType && b.inventory < b.maxInventory,
      );
      if (consumers.length === 0) continue;

      const consumer = consumers[0];
      producer.inventory--;
      consumer.inventory++;
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

  /** Find a warehouse that can accept this resource (empty or matching type, has space). */
  private findAvailableWarehouse(resource: EconomyResource): EconomyBuilding | null {
    for (const b of this.buildings) {
      if (!ECO_BUILDING_DEFS[b.buildingType].isStorage) continue;
      if (b.inventory >= b.maxInventory) continue;

      const stored = this.warehouseResources.get(b);
      // Empty warehouse accepts anything; non-empty must match resource type
      if (stored === undefined || stored === resource) {
        return b;
      }
    }
    return null;
  }

  /** Bulk-deliver goods from full warehouses to their consumers. */
  private processWarehouses(): void {
    for (const warehouse of this.buildings) {
      if (!ECO_BUILDING_DEFS[warehouse.buildingType].isStorage) continue;
      if (warehouse.inventory < warehouse.maxInventory) continue;

      const resource = this.warehouseResources.get(warehouse);
      if (!resource) continue;

      const consumerType = CONSUMER_MAP[resource];
      if (!consumerType) continue;

      const consumer = this.buildings.find(
        b => b.buildingType === consumerType && b.inventory < b.maxInventory,
      );
      if (!consumer) continue; // Consumer is full, warehouse waits

      // Bulk deliver: transfer all inventory with 50% bonus
      const count = warehouse.inventory;
      const bonusCount = Math.floor(count * (WAREHOUSE_BULK_BONUS - 1));

      warehouse.inventory = 0;
      this.warehouseResources.delete(warehouse);
      warehouse.redraw();

      // Deliver base units to consumer
      consumer.inventory += Math.min(count, consumer.maxInventory - consumer.inventory + count);
      // Clamp to max
      if (consumer.inventory > consumer.maxInventory) {
        consumer.inventory = consumer.maxInventory;
      }
      consumer.redraw();

      this.emit({ type: 'consumed', buildingType: consumer.buildingType, resource, amount: count });

      // If consumer is an endpoint, deliver bonus gold too
      const consumerDef = ECO_BUILDING_DEFS[consumer.buildingType];
      if (consumerDef.isEndpoint && consumerDef.goldPerUnit > 0) {
        // Deliver base gold for each unit
        for (let i = 0; i < count; i++) {
          if (consumer.inventory > 0) {
            this.deliverToEndpoint(consumer);
          }
        }
        // Bonus gold from warehouse bulk delivery
        if (bonusCount > 0) {
          const bonusGold = consumerDef.goldPerUnit * consumer.valueMultiplier * bonusCount;
          this.economy.earn(Math.floor(bonusGold));
          this.emit({
            type: 'delivered',
            buildingType: consumer.buildingType,
            resource,
            amount: Math.floor(bonusGold),
          });
        }
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
