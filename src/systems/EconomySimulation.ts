import type { EconomyBuildingType, EconomyResource } from '../data/economy';
import { ECO_BUILDING_DEFS, CHAIN_BONUS_MULTIPLIER } from '../data/economy';
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

  constructor(economy: EconomyManager) {
    this.economy = economy;
  }

  // ─── Building management ────────────────────────────────────────────────

  addBuilding(building: EconomyBuilding): void {
    this.buildings.push(building);
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
    // For each building with inventory, try to find a connected consumer
    for (const producer of this.buildings) {
      if (producer.inventory <= 0) continue;

      const resource = getProduces(producer.buildingType);
      if (!resource) continue;

      const consumerType = CONSUMER_MAP[resource];
      if (!consumerType) continue;

      // Find consumers of the right type with room to process
      const consumers = this.buildings.filter(
        b => b.buildingType === consumerType && b.inventory < b.maxInventory,
      );

      if (consumers.length === 0) continue;

      // Deliver to first available consumer
      const consumer = consumers[0];
      producer.inventory--;
      consumer.inventory++;
      producer.redraw();
      consumer.redraw();

      this.emit({ type: 'consumed', buildingType: consumer.buildingType, resource, amount: 1 });

      // If consumer is an endpoint, convert to gold
      const consumerDef = ECO_BUILDING_DEFS[consumer.buildingType];
      if (consumerDef.isEndpoint && consumerDef.goldPerUnit > 0) {
        this.deliverToEndpoint(consumer);
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
