import Phaser from 'phaser';
import type { EconomyBuilding } from '../entities/EconomyBuilding';
import type { EconomySimulation, EconomyEvent } from './EconomySimulation';
import { ECO_BUILDING_DEFS } from '../data/economy';
import type { EconomyResource } from '../data/economy';

/*
 * ─── Transport System ────────────────────────────────────────────────────
 *
 * Listens to EconomySimulation events and spawns visual cart sprites that
 * travel between producer and consumer buildings along the road network.
 *
 * Carts are purely visual — the economy simulation handles all inventory
 * transfers and gold payouts independently. This system just adds the
 * animated cart layer on top.
 */

// ─── Cargo tint colors ──────────────────────────────────────────────────────

const CARGO_TINTS: Record<EconomyResource, number> = {
  wheat: 0xd4a843,
  flour: 0xeee8d5,
  bread: 0xc89a5c,
  fish:  0x6699cc,
  goods: 0xc8a050,
};

// ─── Cart entity ────────────────────────────────────────────────────────────

interface Cart {
  sprite: Phaser.GameObjects.Image;
  tween: Phaser.Tweens.Tween | null;
  alive: boolean;
}

export class TransportSystem {
  private scene: Phaser.Scene;
  private buildings: EconomyBuilding[] = [];

  /** Group containing all cart sprites — exposed so the UI camera can ignore them. */
  readonly cartGroup: Phaser.GameObjects.Group;

  /** Pool of reusable cart sprites. */
  private cartPool: Cart[] = [];
  private readonly CART_SPEED = 80; // px/s
  private readonly MAX_CARTS = 20;

  constructor(scene: Phaser.Scene, sim: EconomySimulation) {
    this.scene = scene;
    this.cartGroup = scene.add.group();

    // Pre-create cart pool
    for (let i = 0; i < this.MAX_CARTS; i++) {
      const sprite = scene.add.image(-100, -100, 'eco_cart')
        .setDepth(0.25)
        .setDisplaySize(16, 12)
        .setVisible(false)
        .setActive(false);
      this.cartGroup.add(sprite);
      this.cartPool.push({ sprite, tween: null, alive: false });
    }

    // Listen for production events
    sim.onEvent((e: EconomyEvent) => this.onEconomyEvent(e));
  }

  /** Set the current list of economy buildings (updated after placement). */
  setBuildings(buildings: EconomyBuilding[]): void {
    this.buildings = buildings;
  }

  // ─── Event handler ───────────────────────────────────────────────────────

  private onEconomyEvent(e: EconomyEvent): void {
    if (e.type !== 'consumed') return;
    if (!e.resource) return;

    // Warehouse → Market delivery: cart from a warehouse to the market
    if (e.buildingType === 'market') {
      const warehouse = this.buildings.find(
        b => ECO_BUILDING_DEFS[b.buildingType].isStorage,
      );
      const market = this.buildings.find(b => b.buildingType === 'market');
      if (warehouse && market) {
        this.spawnCart(warehouse, market, e.resource);
      }
      return;
    }

    // Find the producer (building that produced this resource)
    const producer = this.findProducer(e.resource);
    // Find the consumer (building that consumed this resource)
    const consumerType = this.getConsumerType(e.resource);
    if (!consumerType) return;
    const consumer = this.findConsumer(consumerType);
    if (!producer || !consumer) return;

    this.spawnCart(producer, consumer, e.resource);
  }

  private getConsumerType(resource: EconomyResource): string | null {
    const map: Record<EconomyResource, string> = {
      wheat: 'mill',
      flour: 'bakery',
      fish:  'harbor',
      bread: null!, // endpoint, no further consumer
      goods: null!, // goes to warehouse → market
    };
    return map[resource] ?? null;
  }

  private findProducer(resource: EconomyResource): EconomyBuilding | null {
    // Find building that produces this resource and has inventory
    return this.buildings.find(b => {
      const def = ECO_BUILDING_DEFS[b.buildingType];
      return def.produces === resource;
    }) ?? null;
  }

  private findConsumer(type: string): EconomyBuilding | null {
    return this.buildings.find(b => b.buildingType === type) ?? null;
  }

  // ─── Cart spawning ───────────────────────────────────────────────────────

  private spawnCart(from: EconomyBuilding, to: EconomyBuilding, resource: EconomyResource): void {
    const cart = this.getPooledCart();
    if (!cart) return;

    const tint = CARGO_TINTS[resource] ?? 0xffffff;

    cart.sprite
      .setPosition(from.pixelX, from.pixelY)
      .setTint(tint)
      .setVisible(true)
      .setActive(true)
      .setAlpha(1);
    cart.alive = true;

    // Travel in a straight line from producer to consumer.
    // TODO Phase 4+: follow actual road polylines from CityRoadNetwork
    // for now straight-line movement gives immediate visual feedback.
    const dx = to.pixelX - from.pixelX;
    const dy = to.pixelY - from.pixelY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const duration = (dist / this.CART_SPEED) * 1000;

    // Face movement direction
    cart.sprite.setFlipX(dx < 0);

    cart.tween = this.scene.tweens.add({
      targets: cart.sprite,
      x: to.pixelX,
      y: to.pixelY,
      duration,
      ease: 'Linear',
      onComplete: () => {
        this.recycleCart(cart);
      },
    });
  }

  // ─── Cart pool ───────────────────────────────────────────────────────────

  private getPooledCart(): Cart | null {
    for (const cart of this.cartPool) {
      if (!cart.alive) return cart;
    }
    return null;
  }

  private recycleCart(cart: Cart): void {
    cart.alive = false;
    cart.sprite.setVisible(false).setActive(false).setPosition(-100, -100);
    if (cart.tween) {
      cart.tween.stop();
      cart.tween = null;
    }
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  update(_delta: number): void {
    // Carts are tween-driven, no per-frame update needed.
    // Future: if switching to manual movement along road polylines,
    // update cart positions here.
  }

  destroy(): void {
    for (const cart of this.cartPool) {
      if (cart.tween) cart.tween.stop();
      cart.sprite.destroy();
    }
    this.cartPool = [];
  }
}
