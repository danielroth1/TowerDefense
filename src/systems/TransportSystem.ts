import Phaser from 'phaser';
import type { EconomyBuilding } from '../entities/EconomyBuilding';
import type { EconomySimulation, EconomyEvent } from './EconomySimulation';
import type { EconomyResource } from '../data/economy';
import { buildWalkabilityGrid, findCartPath, type Vec2 } from './CartPathfinder';
import type { GridTile } from './MapGenerator';

/*
 * ─── Transport System ────────────────────────────────────────────────────
 *
 * Manages cart deliveries between economy buildings along the road network.
 *
 * Each cart carries exactly one unit of goods. Carts pathfind along the
 * walkable grid (grass + enemy path tiles) using A*, then traverse the
 * resulting polyline manually each frame. Goods are only transferred to
 * the receiver when the cart physically reaches its destination.
 *
 * Flow:
 *   1. EconomySimulation calls requestDelivery(from, to, resource, type)
 *   2. TransportSystem pathfinds from → to, spawns a cart with the path
 *   3. Each frame the cart advances along its path at CART_SPEED px/s
 *   4. On arrival → economySim.completeDelivery() transfers the goods
 */

// ─── Cargo tint colors ──────────────────────────────────────────────────────

const CARGO_TINTS: Record<EconomyResource, number> = {
  wheat: 0xd4a843,
  flour: 0xeee8d5,
  bread: 0xc89a5c,
  fish:  0x6699cc,
  goods: 0xc8a050,
};

const CART_SPEED = 80; // px/s
const MAX_CARTS = 20;

// ─── Cart entity ────────────────────────────────────────────────────────────

interface CartSprite {
  sprite: Phaser.GameObjects.Image;
  alive: boolean;
}

interface PendingDelivery {
  cart: CartSprite;
  from: EconomyBuilding;
  to: EconomyBuilding;
  resource: EconomyResource;
  deliveryType: 'consumer' | 'warehouse';
  /** Pre-computed path polyline (pixel centers). */
  path: Vec2[];
  /** Total path length in pixels. */
  totalLength: number;
  /** Pixels traveled so far along the path. */
  distTraveled: number;
}

export class TransportSystem {
  private scene: Phaser.Scene;
  private economySim: EconomySimulation;

  /** Group containing all cart sprites — exposed so the UI camera can ignore them. */
  readonly cartGroup: Phaser.GameObjects.Group;

  /** Active deliveries (carts currently in transit). */
  private deliveries: PendingDelivery[] = [];

  /** Pool of reusable cart sprites. */
  private cartPool: CartSprite[] = [];

  /** Walkability grid for pathfinding (built from map grid). */
  private walkable: Uint8Array | null = null;

  constructor(scene: Phaser.Scene, sim: EconomySimulation) {
    this.scene = scene;
    this.economySim = sim;
    this.cartGroup = scene.add.group();

    // Pre-create cart sprite pool
    for (let i = 0; i < MAX_CARTS; i++) {
      const sprite = scene.add.image(-100, -100, 'eco_cart')
        .setDepth(0.25)
        .setDisplaySize(16, 12)
        .setVisible(false)
        .setActive(false);
      this.cartGroup.add(sprite);
      this.cartPool.push({ sprite, alive: false });
    }

    // Listen for delivered events for floating money text
    sim.onEvent((e: EconomyEvent) => {
      if (e.type === 'delivered' && e.amount > 0 && e.pixelX != null && e.pixelY != null) {
        this.spawnMoneyText(e.pixelX, e.pixelY, e.amount);
      }
    });
  }

  /** Set the map grid to build the walkability grid for pathfinding. */
  setGrid(grid: GridTile[][]): void {
    this.walkable = buildWalkabilityGrid(grid);
  }

  /** No-op — kept for backward compatibility. Building refs come via requestDelivery(). */
  setBuildings(_buildings: EconomyBuilding[]): void {
    // Building references are provided directly by EconomySimulation.requestDelivery()
  }

  // ─── Delivery dispatch ───────────────────────────────────────────────────

  /**
   * Called by EconomySimulation when a producer has goods ready for a consumer.
   * Pathfinds between the buildings and spawns a cart. Returns true if a cart
   * was successfully dispatched (path found + cart available).
   */
  requestDelivery(
    from: EconomyBuilding,
    to: EconomyBuilding,
    resource: EconomyResource,
    deliveryType: 'consumer' | 'warehouse',
  ): boolean {
    if (!this.walkable) return false;

    const cartSprite = this.getPooledCart();
    if (!cartSprite) return false;

    // Pathfind from the producer's grid cell to the consumer's grid cell
    const path = findCartPath(
      this.walkable,
      new Set(), // Don't block on building footprints — carts need to reach buildings
      from.gridRow, from.gridCol,
      to.gridRow, to.gridCol,
    );
    if (!path || path.length < 2) return false;

    // Smooth the path for natural-looking movement
    const smoothed = smoothCartPath(path);

    // Compute total path length
    let totalLength = 0;
    for (let i = 1; i < smoothed.length; i++) {
      const dx = smoothed[i].x - smoothed[i - 1].x;
      const dy = smoothed[i].y - smoothed[i - 1].y;
      totalLength += Math.sqrt(dx * dx + dy * dy);
    }

    const tint = CARGO_TINTS[resource] ?? 0xffffff;

    cartSprite.sprite
      .setPosition(from.pixelX, from.pixelY)
      .setTint(tint)
      .setVisible(true)
      .setActive(true)
      .setAlpha(1)
      .setFlipX(to.pixelX < from.pixelX);
    cartSprite.alive = true;

    this.deliveries.push({
      cart: cartSprite,
      from,
      to,
      resource,
      deliveryType,
      path: smoothed,
      totalLength,
      distTraveled: 0,
    });

    return true;
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  update(delta: number): void {
    const dt = delta / 1000; // ms → s
    const toComplete: PendingDelivery[] = [];

    for (const delivery of this.deliveries) {
      delivery.distTraveled += CART_SPEED * dt;

      // Find the position along the path at the current distance traveled
      const pos = this.pointAtDistance(delivery.path, delivery.distTraveled, delivery.totalLength);
      delivery.cart.sprite.setPosition(pos.x, pos.y);

      // Update flip direction based on movement
      if (delivery.distTraveled > 0 && delivery.path.length > 1) {
        const nextIdx = this.pathIndexAtDistance(delivery.path, delivery.distTraveled, delivery.totalLength);
        if (nextIdx < delivery.path.length) {
          const dx = delivery.path[nextIdx].x - delivery.cart.sprite.x;
          if (Math.abs(dx) > 1) delivery.cart.sprite.setFlipX(dx < 0);
        }
      }

      // Arrived?
      if (delivery.distTraveled >= delivery.totalLength) {
        toComplete.push(delivery);
      }
    }

    // Complete deliveries (outside the iteration to avoid mutation issues)
    for (const delivery of toComplete) {
      // Transfer goods from cart to receiver
      this.economySim.completeDelivery(delivery.to, delivery.resource, delivery.deliveryType);

      // Recycle the cart sprite
      this.recycleCart(delivery.cart);

      // Remove from active deliveries
      const idx = this.deliveries.indexOf(delivery);
      if (idx >= 0) this.deliveries.splice(idx, 1);
    }
  }

  // ─── Path utilities ──────────────────────────────────────────────────────

  /** Get the interpolated position at a given distance along the path. */
  private pointAtDistance(path: Vec2[], dist: number, totalLength: number): Vec2 {
    if (path.length === 0) return { x: 0, y: 0 };
    if (dist <= 0) return path[0];
    if (dist >= totalLength) return path[path.length - 1];

    let traveled = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i].x - path[i - 1].x;
      const dy = path[i].y - path[i - 1].y;
      const segLen = Math.sqrt(dx * dx + dy * dy);

      if (traveled + segLen >= dist) {
        const t = (dist - traveled) / segLen;
        return {
          x: path[i - 1].x + dx * t,
          y: path[i - 1].y + dy * t,
        };
      }
      traveled += segLen;
    }

    return path[path.length - 1];
  }

  /** Get the index of the next path point ahead of the current distance. */
  private pathIndexAtDistance(path: Vec2[], dist: number, totalLength: number): number {
    if (dist >= totalLength) return path.length - 1;
    let traveled = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i].x - path[i - 1].x;
      const dy = path[i].y - path[i - 1].y;
      traveled += Math.sqrt(dx * dx + dy * dy);
      if (traveled > dist) return i;
    }
    return path.length - 1;
  }

  // ─── Cart pool ───────────────────────────────────────────────────────────

  private getPooledCart(): CartSprite | null {
    for (const cart of this.cartPool) {
      if (!cart.alive) return cart;
    }
    return null;
  }

  private recycleCart(cart: CartSprite): void {
    cart.alive = false;
    cart.sprite.setVisible(false).setActive(false).setPosition(-100, -100);
  }

  // ─── Floating money text ────────────────────────────────────────────────

  private spawnMoneyText(x: number, y: number, amount: number): void {
    const text = this.scene.add.text(x, y - 8, `+$${amount}`, {
      fontSize: '14px',
      fontFamily: 'monospace',
      color: '#ffd700',
      stroke: '#000000',
      strokeThickness: 3,
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(2);

    this.scene.tweens.add({
      targets: text,
      y: y - 36,
      alpha: 0,
      duration: 1200,
      ease: 'Cubic.easeOut',
      onComplete: () => text.destroy(),
    });
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  destroy(): void {
    for (const delivery of this.deliveries) {
      this.recycleCart(delivery.cart);
    }
    this.deliveries = [];
    for (const cart of this.cartPool) {
      cart.sprite.destroy();
    }
    this.cartPool = [];
  }
}

// ─── Path smoothing (light Chaikin for cart paths) ──────────────────────────

function smoothCartPath(points: Vec2[]): Vec2[] {
  if (points.length < 3) return points;
  // One iteration of Chaikin corner-cutting
  const out: Vec2[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
    out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  out.push(points[points.length - 1]);
  return out;
}

