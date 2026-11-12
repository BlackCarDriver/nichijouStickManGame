import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getWeapon, createHeldWeapon } from '../combat/WeaponFormat';
import { drawHeldWeapon } from '../render/WeaponRenderer';
import { raycast, getWorldBodies } from '../combat/Raycast';
import type { FxSystem } from '../fx/FxSystem';
import { GrenadeSystem } from '../combat/GrenadeSystem';

/** 手榴弹背包上限（PickupSystem 与 GrenadeSystem 共用同一常量） */
const GRENADE_MAX = GrenadeSystem.MAX;

/** 地面上的一件武器（可拾取） */
export interface WeaponPickup {
  weaponId: string;
  ammo: number;
  durability: number;
  x: number;
  y: number;
  vy: number;
  falling: boolean;
  gfx: Phaser.GameObjects.Graphics;
  bob: number;
}

export interface PickupSpawnOptions {
  ammo?: number;
  durability?: number;
  /** 是否从空中掉落（穿过物体落到地面） */
  falling?: boolean;
}

/**
 * 武器拾取系统。
 *
 * 规则（需求）：
 * - 空手靠近 → **自动拾取**
 * - 已有武器 + 靠近 + 按替换键 → **替换**（旧武器留在原地）
 * - 武器可从空中被拾取（下落过程中也能捡）
 * - 弹药打空的武器会被丢在地上，仍可被捡起（弹匣为 0，捡起后无法开火直到 W5+ 补弹）
 */
export class PickupSystem {
  private readonly scene: Phaser.Scene;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;
  private items: WeaponPickup[] = [];

  /** 自动拾取半径 */
  private static readonly AUTO_RADIUS = 46;
  /** 替换拾取半径（略大，便于操作） */
  private static readonly SWAP_RADIUS = 62;
  /** 掉落物下落重力（px/秒²） */
  private static readonly FALL_GRAVITY = 900;

  constructor(scene: Phaser.Scene, bodyToPlayer: Map<number, Player>, fx: FxSystem) {
    this.scene = scene;
    this.bodyToPlayer = bodyToPlayer;
    this.fx = fx;
  }

  get count(): number {
    return this.items.length;
  }

  get list(): readonly WeaponPickup[] {
    return this.items;
  }

  /** 生成一件武器掉落物 */
  spawn(weaponId: string, x: number, y: number, options: PickupSpawnOptions = {}): WeaponPickup | null {
    const weapon = getWeapon(weaponId);
    if (!weapon) return null;

    const gfx = this.scene.add.graphics();
    gfx.setDepth(820);
    const item: WeaponPickup = {
      weaponId,
      ammo: options.ammo ?? weapon.ammo,
      durability: options.durability ?? weapon.durability,
      x,
      y,
      vy: 0,
      falling: options.falling ?? false,
      gfx,
      bob: Math.random() * Math.PI * 2,
    };
    this.items.push(item);
    this.redraw(item);
    return item;
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const item of this.items) {
      if (item.falling) {
        item.vy += PickupSystem.FALL_GRAVITY * dt;
        item.y += item.vy * dt;
        // 落到地面/物体上
        const hits = raycast(
          getWorldBodies(this.scene),
          { x: item.x, y: item.y },
          { x: 0, y: 1 },
          14,
          { maxHits: 1 },
        );
        if (hits[0]) {
          item.y = hits[0].point.y - 18;
          item.falling = false;
          item.vy = 0;
          this.fx.burst({ x: item.x, y: item.y }, 0xb9c4d0);
        }
        // 掉出地图底部 → 移除
        if (item.y > 4000) {
          item.gfx.destroy();
          this.items.splice(this.items.indexOf(item), 1);
          continue;
        }
      } else {
        item.bob += dt * 2.2;
      }
      this.redraw(item);
    }
  }

  /**
   * 拾取处理。
   * @param swapRequested 这些玩家本帧按了"替换"键（P1 右键 / P2 E）
   * @returns 本帧真正完成了拾取/替换的玩家 id 集合（未完成的才去做踢/投掷）
   */
  tryPickup(swapRequested: Set<number>): Set<number> {
    const consumed = new Set<number>();
    for (const player of this.bodyToPlayer.values()) {
      if (player.health.isDead) continue;
      const holding = player.heldWeapon;

      for (const item of [...this.items]) {
        const dist = Phaser.Math.Distance.Between(player.container.x, player.container.y, item.x, item.y);

        // 手榴弹是道具：进背包，不占用/替换武器槽
        if (item.weaponId === 'grenade') {
          if (dist <= PickupSystem.AUTO_RADIUS * 1.4 && player.grenadeCount < GRENADE_MAX) {
            player.grenadeCount += 1;
            this.remove(item);
            this.fx.hitSpark({ x: item.x, y: item.y }, { x: 0, y: -1 }, 0x8fd06a);
            this.scene.events.emit('grenade-picked', player, player.grenadeCount);
            this.scene.events.emit('sfx', 'pickup');
          }
          continue;
        }

        const wantSwap = swapRequested.has(player.id);

        // 空手 → 自动拾取
        if (!holding && dist <= PickupSystem.AUTO_RADIUS) {
          this.give(player, item);
          this.remove(item);
          consumed.add(player.id);
          break;
        }

        // 已有武器 + 按替换键 → 替换（旧武器留在原地）
        if (holding && wantSwap && dist <= PickupSystem.SWAP_RADIUS) {
          const old = holding;
          this.give(player, item);
          this.remove(item);
          this.spawn(old.id, player.container.x, player.container.y, {
            ammo: old.ammo,
            durability: old.durability,
            falling: false,
          });
          consumed.add(player.id);
          break;
        }
      }
    }
    return consumed;
  }

  /** 把掉落物塞给玩家 */
  private give(player: Player, item: WeaponPickup): void {
    player.heldWeapon = createHeldWeapon(item.weaponId) ?? null;
    if (player.heldWeapon) {
      player.heldWeapon.ammo = item.ammo;
      player.heldWeapon.durability = item.durability;
    }
    this.fx.hitSpark({ x: item.x, y: item.y }, { x: 0, y: -1 }, 0x9ad0ff);
    this.scene.events.emit('weapon-picked', player, item.weaponId);
    this.scene.events.emit('sfx', 'pickup');
  }

  private remove(item: WeaponPickup): void {
    item.gfx.destroy();
    const idx = this.items.indexOf(item);
    if (idx >= 0) this.items.splice(idx, 1);
  }

  /** 重画掉落物：地面上的武器外形 + 浮动 + 光晕 */
  private redraw(item: WeaponPickup): void {
    const weapon = getWeapon(item.weaponId);
    if (!weapon) return;
    const g = item.gfx;
    g.clear();
    const bobY = item.falling ? 0 : Math.sin(item.bob) * 3;
    g.setPosition(item.x, item.y + bobY);

    // 光晕
    g.fillStyle(0x9ad0ff, item.falling ? 0.2 : 0.14);
    g.fillCircle(0, 0, 18);
    g.fillStyle(0xffffff, item.falling ? 0.22 : 0.1);
    g.fillCircle(0, 0, 9);

    // 武器本体
    drawHeldWeapon(g, {
      visual: weapon.visual,
      facing: 1,
      aim: 0,
      hand: { x: -weapon.visual.length / 2, y: 0 },
    });

    // 弹匣为空 → 灰点提示
    if (item.ammo === 0) {
      g.fillStyle(0x666666, 0.9);
      g.fillCircle(0, 14, 3);
    }
  }

  destroy(): void {
    for (const item of this.items) item.gfx.destroy();
    this.items = [];
  }
}
