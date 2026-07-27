import Phaser from 'phaser';
import type { EconomyBuilding } from '../entities/EconomyBuilding';
import type { EconomySimulation, EconomyEvent, DeliveryType } from './EconomySimulation';
import type { EconomyResource } from '../data/economy';
import { buildWalkabilityGrid, findCartPath, type Vec2 } from './CartPathfinder';
import type { GridTile } from './MapGenerator';

/*
 * ─── Transport System ────────────────────────────────────────────────────
 *
 * Manages cart deliveries between economy buildings along the road network.
 *
 * Each cart carries exactly one unit of goods. Carts pathfind along the
 * walkable grid using A*, then traverse the resulting polyline each frame.
 * Goods are transferred only when the cart reaches its destination.
 *
 * Carts are created dynamically on demand — no fixed capacity limit.
 *
 * Flow:
 *   1. EconomySimulation calls requestDelivery(from, to, resource, type)
 *   2. TransportSystem pathfinds from → to, creates a cart with the path
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

// ─── Pending delivery ───────────────────────────────────────────────────────

interface PendingDelivery {
  sprite: Phaser.GameObjects.Image;
  from: EconomyBuilding;
  to: EconomyBuilding;
  resource: EconomyResource;
  deliveryType: DeliveryType;
  path: Vec2[];
  totalLength: number;
  distTraveled: number;
}

export class TransportSystem {
  private scene: Phaser.Scene;
  private economySim: EconomySimulation;

  /** UI camera reference — set after construction so dynamically created
   *  cart sprites and money text are only rendered in world space. */
  private uiCam: Phaser.Cameras.Scene2D.Camera | null = null;

  /** Group containing all cart sprites. */
  readonly cartGroup: Phaser.GameObjects.Group;

  private deliveries: PendingDelivery[] = [];
  private walkable: Uint8Array | null = null;

  constructor(scene: Phaser.Scene, sim: EconomySimulation) {
    this.scene = scene;
    this.economySim = sim;
    this.cartGroup = scene.add.group();

    sim.onEvent((e: EconomyEvent) => {
      if (e.type === 'delivered' && e.amount > 0 && e.pixelX != null && e.pixelY != null) {
        this.spawnMoneyText(e.pixelX, e.pixelY, e.amount);
      }
    });
  }

  /** Set the UI camera so cart sprites and money text are ignored by it
   *  (rendered only in world space, not camera space). */
  setUICam(cam: Phaser.Cameras.Scene2D.Camera): void {
    this.uiCam = cam;
  }

  setGrid(grid: GridTile[][]): void {
    this.walkable = buildWalkabilityGrid(grid);
  }

  /** No-op — kept for backward compatibility. */
  setBuildings(_buildings: EconomyBuilding[]): void {}

  // ─── Delivery dispatch ───────────────────────────────────────────────────

  requestDelivery(
    from: EconomyBuilding,
    to: EconomyBuilding,
    resource: EconomyResource,
    deliveryType: DeliveryType,
  ): boolean {
    if (!this.walkable) return false;

    const path = findCartPath(
      this.walkable,
      new Set(),
      from.gridRow, from.gridCol,
      to.gridRow, to.gridCol,
    );
    if (!path || path.length < 2) return false;

    const smoothed = smoothCartPath(path);

    let totalLength = 0;
    for (let i = 1; i < smoothed.length; i++) {
      const dx = smoothed[i].x - smoothed[i - 1].x;
      const dy = smoothed[i].y - smoothed[i - 1].y;
      totalLength += Math.sqrt(dx * dx + dy * dy);
    }

    const tint = CARGO_TINTS[resource] ?? 0xffffff;

    // Create cart sprite dynamically (no pool limit)
    const sprite = this.scene.add.image(from.pixelX, from.pixelY, 'eco_cart')
      .setDepth(0.25)
      .setDisplaySize(16, 12)
      .setTint(tint)
      .setFlipX(to.pixelX < from.pixelX);
    this.cartGroup.add(sprite);

    // Cart is world-space only; ignore on UI camera
    if (this.uiCam) this.uiCam.ignore(sprite);

    this.deliveries.push({
      sprite,
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
    const dt = delta / 1000;
    const toComplete: PendingDelivery[] = [];

    for (const delivery of this.deliveries) {
      delivery.distTraveled += CART_SPEED * dt;

      const pos = this.pointAtDistance(delivery.path, delivery.distTraveled, delivery.totalLength);
      delivery.sprite.setPosition(pos.x, pos.y);

      if (delivery.distTraveled > 0 && delivery.path.length > 1) {
        const nextIdx = this.pathIndexAtDistance(delivery.path, delivery.distTraveled, delivery.totalLength);
        if (nextIdx < delivery.path.length) {
          const dx = delivery.path[nextIdx].x - delivery.sprite.x;
          if (Math.abs(dx) > 1) delivery.sprite.setFlipX(dx < 0);
        }
      }

      if (delivery.distTraveled >= delivery.totalLength) {
        toComplete.push(delivery);
      }
    }

    for (const delivery of toComplete) {
      this.economySim.completeDelivery(delivery.to, delivery.resource, delivery.deliveryType);
      delivery.sprite.destroy();
      const idx = this.deliveries.indexOf(delivery);
      if (idx >= 0) this.deliveries.splice(idx, 1);
    }
  }

  // ─── Path utilities ──────────────────────────────────────────────────────

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

  // ─── Money text ─────────────────────────────────────────────────────────

  private spawnMoneyText(x: number, y: number, amount: number): void {
    const text = this.scene.add.text(x, y - 8, `+$${amount}`, {
      fontSize: '14px',
      fontFamily: 'monospace',
      color: '#ffd700',
      stroke: '#000000',
      strokeThickness: 3,
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(2);

    // Money text is world-space only; ignore on UI camera
    if (this.uiCam) this.uiCam.ignore(text);

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
      delivery.sprite.destroy();
    }
    this.deliveries = [];
  }
}

// ─── Path smoothing ─────────────────────────────────────────────────────────

function smoothCartPath(points: Vec2[]): Vec2[] {
  if (points.length < 3) return points;
  const out: Vec2[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
    out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  out.push(points[points.length - 1]);
  return out;
}

