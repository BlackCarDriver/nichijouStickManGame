import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getWeapon, createHeldWeapon } from '../combat/WeaponFormat';
import { drawHeldWeapon } from '../render/WeaponRenderer';
import { raycast, getWorldBodies } from '../combat/Raycast';
import type { FxSystem } from '../fx/FxSystem';
import { GrenadeSystem } from '../combat/GrenadeSystem';
import { getItem, itemPickupRadius, type ItemJson } from './ItemFormat';
import { parseColor } from '../config/materials';
import type { DropWire, PickGrant } from '../net/protocol';

/** 联机拾取请求桥（由 OnlineMatch 提供） */
export interface PickupNetBridge {
  request(item: GroundPickup, player: Player, swap: boolean): void;
}

/** 手榴弹背包上限（PickupSystem 与 GrenadeSystem 共用同一常量） */
const GRENADE_MAX = GrenadeSystem.MAX;

/** 地面上的一件掉落物（武器或道具）共有字段 */
interface GroundPickupBase {
  x: number;
  y: number;
  vy: number;
  falling: boolean;
  gfx: Phaser.GameObjects.Graphics;
  bob: number;
  /** 来源标记（武器掉落点用：判断"这个点上的武器是否已被捡走"） */
  tag?: string;
  /** 联机：服务端下发的掉落物 id（单机为 undefined） */
  netId?: number;
}

/** 地面上的武器（可拾取，占用武器槽） */
export interface WeaponGroundPickup extends GroundPickupBase {
  kind: 'weapon';
  weaponId: string;
  ammo: number;
}

/** 地面上的道具（医疗包/防弹衣，触碰即用，不占武器槽） */
export interface ItemGroundPickup extends GroundPickupBase {
  kind: 'item';
  itemId: string;
}

export type GroundPickup = WeaponGroundPickup | ItemGroundPickup;

/**
 * 拾取仲裁模式：
 * - single：单机，本地直接生效
 * - authority：联机房主，替**所有玩家**判定拾取，再交给服务端授予
 * - client：联机非房主，只做“是否会拾取”的本地预判（用于抑制踢/投掷），不实际生效
 */
export type PickupMode = 'single' | 'authority' | 'client';

/** 兼容旧名字（武器掉落物） */
export type WeaponPickup = WeaponGroundPickup;

export interface PickupSpawnOptions {
  ammo?: number;
  /** 是否从空中掉落（穿过物体落到地面） */
  falling?: boolean;
  /** 来源标记（武器掉落点用） */
  tag?: string;
}

/**
 * 拾取系统（武器 + 道具）。
 *
 * 武器规则：
 * - 空手靠近 → **自动拾取**
 * - 已有武器 + 靠近 + 按替换键 → **替换**（旧武器留在原地）
 * - 武器可从空中被拾取（下落过程中也能捡）
 * - 超级战士状态（光刀）→ **武器槽锁死**，不能替换
 *
 * 道具规则：
 * - 医疗包：**非满血**时靠近 → 自动拾取并当场使用（回血）
 * - 防弹衣：**护盾未满**时靠近 → 自动拾取并获得护盾
 * - 不需要按键，也不占用武器槽
 */
export class PickupSystem {
  private readonly scene: Phaser.Scene;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;
  private items: GroundPickup[] = [];

  // ---- 联机 ----
  private net: PickupNetBridge | null = null;
  private mode: PickupMode = 'single';
  private localPlayer: Player | null = null;
  /** 请求节流：同一件掉落物 250ms 内只上报一次 */
  private readonly requestAt = new WeakMap<GroundPickup, number>();
  private static readonly REQUEST_INTERVAL = 250;

  /** 自动拾取半径 */
  private static readonly AUTO_RADIUS = 46;
  /** 替换拾取半径（略大，便于操作） */
  private static readonly SWAP_RADIUS = 62;
  /** 掉落物下落重力（px/秒²） */
  private static readonly FALL_GRAVITY = 900;
  /** 落地后浮在地面上方的高度（视觉不贴地） */
  private static readonly REST_OFFSET = 18;
  /** 支撑检测距离：脚下没有东西就继续下落 */
  private static readonly SUPPORT_PROBE = 22;

  constructor(scene: Phaser.Scene, bodyToPlayer: Map<number, Player>, fx: FxSystem) {
    this.scene = scene;
    this.bodyToPlayer = bodyToPlayer;
    this.fx = fx;
  }

  /** 地图上**武器**的数量（DropSystem 维持数量用，不含道具） */
  get count(): number {
    let n = 0;
    for (const item of this.items) if (item.kind === 'weapon') n++;
    return n;
  }

  /** 地图上某种**道具**的数量（ItemDropSystem 维持数量用） */
  itemCount(itemId: string): number {
    let n = 0;
    for (const item of this.items) if (item.kind === 'item' && item.itemId === itemId) n++;
    return n;
  }

  /** 所有掉落物（含武器与道具） */
  get list(): readonly GroundPickup[] {
    return this.items;
  }

  /** 生成一件武器掉落物 */
  spawn(weaponId: string, x: number, y: number, options: PickupSpawnOptions = {}): WeaponGroundPickup | null {
    const weapon = getWeapon(weaponId);
    if (!weapon) return null;

    const item: WeaponGroundPickup = {
      kind: 'weapon',
      weaponId,
      ammo: options.ammo ?? weapon.ammo,
      x,
      y,
      vy: 0,
      falling: options.falling ?? false,
      tag: options.tag,
      gfx: this.scene.add.graphics(),
      bob: Math.random() * Math.PI * 2,
    };
    item.gfx.setDepth(820);
    this.items.push(item);
    this.redraw(item);
    return item;
  }

  /** 某个 tag 的掉落物是否还在地上（武器掉落点判断是否该刷新） */
  hasTag(tag: string): boolean {
    return this.items.some((item) => item.tag === tag);
  }

  /** 生成一件道具掉落物（医疗包/防弹衣） */
  spawnItem(itemId: string, x: number, y: number, options: PickupSpawnOptions = {}): ItemGroundPickup | null {
    if (!getItem(itemId)) return null;

    const item: ItemGroundPickup = {
      kind: 'item',
      itemId,
      x,
      y,
      vy: 0,
      falling: options.falling ?? false,
      tag: options.tag,
      gfx: this.scene.add.graphics(),
      bob: Math.random() * Math.PI * 2,
    };
    item.gfx.setDepth(820);
    this.items.push(item);
    this.redraw(item);
    return item;
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const item of this.items) {
      // 联机（非房主）：掉落物坐标完全以房主快照为准，不做本地物理/支撑检测，
      // 否则同一件掉落物会在两端落到不同高度（“物品位置不一样”的直接原因）。
      if (this.mode === 'client' && item.netId !== undefined) {
        item.bob += dt * 2.2;
        this.redraw(item);
        continue;
      }
      if (item.falling) {
        const prevY = item.y;
        item.vy += PickupSystem.FALL_GRAVITY * dt;
        item.y += item.vy * dt;

        // 用「上一帧位置 → 本帧位置」的线段检测（避免高速下落漏检）。
        // 关键：掉落物是**浮在表面上方 REST_OFFSET 处**的，
        // 所以必须提前 REST_OFFSET 就判定落地，否则会先陷进地面里一帧再弹回来。
        const dy = item.y - prevY;
        if (dy > 0) {
          const hits = raycast(
            getWorldBodies(this.scene),
            { x: item.x, y: prevY },
            { x: 0, y: 1 },
            dy + PickupSystem.REST_OFFSET,
            { maxHits: 1 },
          );
          const restY = hits[0] ? hits[0].point.y - PickupSystem.REST_OFFSET : Number.POSITIVE_INFINITY;
          if (hits[0] && restY <= item.y + 0.5) {
            item.y = restY;
            item.falling = false;
            item.vy = 0;
            this.fx.burst({ x: item.x, y: item.y }, 0xb9c4d0);
          }
        }

        // 掉出地图底部 → 移除
        if (item.y > 4000) {
          item.gfx.destroy();
          this.items.splice(this.items.indexOf(item), 1);
          continue;
        }
      } else {
        item.bob += dt * 2.2;

        // 支撑检测：脚下的平台被破坏后，掉落物应该继续往下掉
        const support = raycast(
          getWorldBodies(this.scene),
          { x: item.x, y: item.y },
          { x: 0, y: 1 },
          PickupSystem.SUPPORT_PROBE,
          { maxHits: 1 },
        );
        if (!support[0]) {
          item.falling = true;
          item.vy = 0;
        }
      }
      this.redraw(item);
    }
  }

  /**
   * 拾取处理。
   * @param swapRequested 这些玩家本帧按了"替换"键（P1 右键 / P2 E）
   * @returns 本帧真正完成了拾取/替换的玩家 id 集合（未完成的才去做踢/投掷）
   */
  tryPickup(swapRequested: ReadonlySet<number>): Set<number> {
    if (this.mode === 'authority') return this.tryPickupAuthority(swapRequested);
    if (this.mode === 'client') return this.previewPickup(swapRequested);
    const consumed = new Set<number>();
    for (const player of this.bodyToPlayer.values()) {
      if (player.health.isDead) continue;
      const holding = player.heldWeapon;

      for (const item of [...this.items]) {
        const dist = Phaser.Math.Distance.Between(player.container.x, player.container.y, item.x, item.y);

        if (item.kind === 'item') {
          if (this.tryPickItem(player, item, dist)) {
            this.remove(item);
            consumed.add(player.id);
            break;
          }
          continue;
        }

        // ---- 武器 ----
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
          this.give(player, item.weaponId, item.ammo, { x: item.x, y: item.y });
          this.remove(item);
          consumed.add(player.id);
          break;
        }

        // 已有武器 + 按替换键 → 替换（旧武器留在原地）
        // 超级战士（光刀）锁定武器槽 → 不能替换
        if (holding && wantSwap && !player.weaponLocked && dist <= PickupSystem.SWAP_RADIUS) {
          const old = holding;
          this.give(player, item.weaponId, item.ammo, { x: item.x, y: item.y });
          this.remove(item);
          this.spawn(old.id, player.container.x, player.container.y, {
            ammo: old.ammo,
            falling: false,
          });
          consumed.add(player.id);
          break;
        }
      }
    }
    return consumed;
  }

  /**
   * 联机（房主）：替所有玩家判定拾取。
   *
   * 为什么由房主统一判定：拾取/换枪会改变世界状态（地面武器、掉落物），
   * 各端各自判会出现"两个人都捡到同一把枪"；由房主判、服务端授予，
   * 才能保证单一事实来源，也不依赖客户端上报的距离。
   */
  private tryPickupAuthority(swapRequested: ReadonlySet<number>): Set<number> {
    const consumed = new Set<number>();
    const net = this.net;
    if (!net) return consumed;
    const now = performance.now();
    const request = (item: GroundPickup, player: Player, swap: boolean): void => {
      const last = this.requestAt.get(item) ?? -Infinity;
      if (now - last < PickupSystem.REQUEST_INTERVAL) return;
      this.requestAt.set(item, now);
      net.request(item, player, swap);
    };

    for (const player of this.bodyToPlayer.values()) {
      if (player.health.isDead) continue;
      const holding = player.heldWeapon;

      for (const item of [...this.items]) {
        const dist = Phaser.Math.Distance.Between(player.container.x, player.container.y, item.x, item.y);

        if (item.kind === 'item') {
          if (this.canPickItem(player, item, dist)) {
            request(item, player, false);
            consumed.add(player.id);
            break;
          }
          continue;
        }

        // 手榴弹：进背包，不占武器槽
        if (item.weaponId === 'grenade') {
          if (dist <= PickupSystem.AUTO_RADIUS * 1.4 && player.grenadeCount < GRENADE_MAX) {
            request(item, player, false);
            consumed.add(player.id);
            break;
          }
          continue;
        }

        if (!holding && dist <= PickupSystem.AUTO_RADIUS) {
          request(item, player, false);
          consumed.add(player.id);
          break;
        }
        if (
          holding &&
          swapRequested.has(player.id) &&
          !player.weaponLocked &&
          dist <= PickupSystem.SWAP_RADIUS
        ) {
          request(item, player, true);
          consumed.add(player.id);
          break;
        }
      }
    }
    return consumed;
  }

  /**
   * 联机（非房主）：只预判"本地玩家此刻会不会拾取"。
   * 用于抑制替换武器时的踢/投掷动作（真正的拾取由房主判定）。
   */
  private previewPickup(swapRequested: ReadonlySet<number>): Set<number> {
    const consumed = new Set<number>();
    const player = this.localPlayer;
    if (!player || player.health.isDead) return consumed;

    for (const item of this.items) {
      const dist = Phaser.Math.Distance.Between(player.container.x, player.container.y, item.x, item.y);
      if (item.kind === 'item') {
        if (this.canPickItem(player, item, dist)) {
          consumed.add(player.id);
          break;
        }
        continue;
      }
      if (item.weaponId === 'grenade') {
        if (dist <= PickupSystem.AUTO_RADIUS * 1.4 && player.grenadeCount < GRENADE_MAX) {
          consumed.add(player.id);
          break;
        }
        continue;
      }
      const holding = player.heldWeapon;
      if (!holding && dist <= PickupSystem.AUTO_RADIUS) {
        consumed.add(player.id);
        break;
      }
      if (holding && swapRequested.has(player.id) && !player.weaponLocked && dist <= PickupSystem.SWAP_RADIUS) {
        consumed.add(player.id);
        break;
      }
    }
    return consumed;
  }

  /** 挂接联机桥：带仲裁能力的一方（房主）用 authority，其余用 client */
  setNet(net: PickupNetBridge | null, localPlayer: Player | null, mode: PickupMode = 'client'): void {
    this.net = net;
    this.localPlayer = localPlayer;
    this.mode = net ? mode : 'single';
  }

  /** 联机：当前所有带服务端 id 的地面物品（房主用它生成快照） */
  netSpawns(): Array<{ id: number; x: number; y: number; falling: boolean }> {
    const out: Array<{ id: number; x: number; y: number; falling: boolean }> = [];
    for (const item of this.items) {
      if (item.netId === undefined) continue;
      out.push({ id: item.netId, x: item.x, y: item.y, falling: item.falling });
    }
    return out;
  }

  /** 联机：按服务端 id 移除一件掉落物（越界清理 / 服务端删除） */
  removeByNetId(netId: number): void {
    const item = this.items.find((it) => it.netId === netId);
    if (item) this.remove(item);
  }

  /** 联机：套用房主下发的掉落物坐标（非房主端不再自行模拟下落） */
  applyNetPosition(netId: number, x: number, y: number, falling: boolean): void {
    const item = this.items.find((it) => it.netId === netId);
    if (!item) return;
    item.x = x;
    item.y = y;
    item.vy = 0;
    item.falling = falling;
  }

  /** 这件补给此刻是否值得捡（单机 / 房主判定 / 非房主预判共用同一套条件） */
  private canPickItem(player: Player, item: ItemGroundPickup, dist: number): boolean {
    const def = getItem(item.itemId);
    if (!def) return true;
    if (dist > itemPickupRadius(def)) return false;
    if (def.kind === 'heal') return player.health.hp < player.health.maxHp;
    return player.health.shield < player.health.maxShield;
  }

  /** 联机：按服务端下发的掉落物创建地面物品 */
  spawnNet(drop: DropWire): void {
    if (drop.kind === 'weapon') {
      if (!drop.weaponId) return;
      const item = this.spawn(drop.weaponId, drop.x, drop.y, {
        ammo: drop.ammo,
        falling: drop.falling,
        tag: drop.tag,
      });
      if (item) item.netId = drop.id;
      return;
    }
    if (!drop.itemId) return;
    const item = this.spawnItem(drop.itemId, drop.x, drop.y, { falling: drop.falling, tag: drop.tag });
    if (item) item.netId = drop.id;
  }

  /** 联机：服务端授予拾取（所有人都会收到，用来同步"谁捡到了什么"） */
  applyGrant(netId: number, player: Player | null, grant: PickGrant): void {
    const item = this.items.find((it) => it.netId === netId);
    const at = item ? { x: item.x, y: item.y } : player ? { x: player.container.x, y: player.container.y } : null;
    if (item) this.remove(item);
    if (!player) return;

    if (grant.kind === 'weapon' && grant.weaponId) {
      // 手榴弹是道具：进背包（腰挂），不占武器槽
      if (grant.weaponId === 'grenade') {
        player.grenadeCount = Math.min(GRENADE_MAX, player.grenadeCount + 1);
        if (at) this.fx.hitSpark({ x: at.x, y: at.y }, { x: 0, y: -1 }, 0x8fd06a);
        this.scene.events.emit('grenade-picked', player, player.grenadeCount);
        this.scene.events.emit('sfx', 'pickup');
        return;
      }
      this.give(player, grant.weaponId, grant.ammo ?? 0, at);
      return;
    }
    if (grant.kind === 'item' && at) {
      // 生命/护盾由服务端结算并通过 hp 消息下发，这里只播表现（含 +40 / +100 气泡）
      const def = grant.itemId ? getItem(grant.itemId) : undefined;
      if (def) {
        this.fx.burst(at, parseColor(def.glow ?? def.color));
        if (def.kind === 'heal') {
          this.scene.events.emit('item-used', player, 'medkit', def.heal ?? 0);
        } else {
          this.scene.events.emit('item-used', player, 'armor', def.shield ?? 0);
        }
      }
      this.scene.events.emit('sfx', 'pickup');
    }
  }

  /**
   * 尝试拾取一件道具。返回 true = 已消耗（从地上移除）。
   * 医疗包/防弹衣都是"触碰即用"，但不满足条件时留在地上。
   */
  private tryPickItem(player: Player, item: ItemGroundPickup, dist: number): boolean {
    const def = getItem(item.itemId);
    if (!def) return true; // 未知道具：直接清掉，避免残留
    if (!this.canPickItem(player, item, dist)) return false;

    if (def.kind === 'heal') {
      // 满血不捡（留在地上给缺血的人）
      if (player.health.hp >= player.health.maxHp) return false;
      const healed = player.heal(def.heal ?? 0);
      if (healed <= 0) return false;
      this.fx.burst({ x: item.x, y: item.y }, parseColor(def.glow ?? def.color));
      this.scene.events.emit('item-used', player, 'medkit', healed);
      this.scene.events.emit('sfx', 'pickup');
      return true;
    }

    // shield（防弹衣）
    if (player.health.shield >= player.health.maxShield) return false;
    const added = player.health.addShield(def.shield ?? 0);
    if (added <= 0) return false;
    this.fx.burst({ x: item.x, y: item.y }, parseColor(def.glow ?? def.color));
    this.scene.events.emit('item-used', player, 'armor', added);
    this.scene.events.emit('sfx', 'pickup');
    return true;
  }

  /** 把武器塞给玩家 */
  private give(
    player: Player,
    weaponId: string,
    ammo: number,
    at: { x: number; y: number } | null,
  ): void {
    player.heldWeapon = createHeldWeapon(weaponId) ?? null;
    if (player.heldWeapon) {
      player.heldWeapon.ammo = ammo;
    }
    if (at) this.fx.hitSpark({ x: at.x, y: at.y }, { x: 0, y: -1 }, 0x9ad0ff);
    this.scene.events.emit('weapon-picked', player, weaponId);
    this.scene.events.emit('sfx', 'pickup');
  }

  private remove(item: GroundPickup): void {
    item.gfx.destroy();
    const idx = this.items.indexOf(item);
    if (idx >= 0) this.items.splice(idx, 1);
  }

  /** 重画掉落物：浮动 + 光晕 + 外形 */
  private redraw(item: GroundPickup): void {
    const g = item.gfx;
    g.clear();
    const bobY = item.falling ? 0 : Math.sin(item.bob) * 3;
    g.setPosition(item.x, item.y + bobY);

    if (item.kind === 'item') {
      this.redrawItem(g, item);
      return;
    }

    const weapon = getWeapon(item.weaponId);
    if (!weapon) return;

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

  /** 道具外形：医疗包 = 白底绿十字；防弹衣 = 灰色护盾 */
  private redrawItem(g: Phaser.GameObjects.Graphics, item: ItemGroundPickup): void {
    const def: ItemJson | undefined = getItem(item.itemId);
    if (!def) return;
    const color = parseColor(def.color);
    const glow = parseColor(def.glow ?? def.color);

    // 光晕
    g.fillStyle(glow, item.falling ? 0.22 : 0.16);
    g.fillCircle(0, 0, 17);

    if (def.kind === 'heal') {
      // 药箱：白底 + 绿十字
      g.fillStyle(0xf2f5f7, 1);
      g.fillRoundedRect(-11, -9, 22, 18, 3);
      g.lineStyle(1.5, color, 1);
      g.strokeRoundedRect(-11, -9, 22, 18, 3);
      g.fillStyle(color, 1);
      g.fillRect(-2.5, -6, 5, 12);
      g.fillRect(-6, -2.5, 12, 5);
    } else {
      // 护盾：上平下尖
      g.fillStyle(color, 1);
      g.beginPath();
      g.moveTo(-10, -10);
      g.lineTo(10, -10);
      g.lineTo(10, 2);
      g.lineTo(0, 11);
      g.lineTo(-10, 2);
      g.closePath();
      g.fillPath();
      g.lineStyle(1.5, 0xffffff, 0.55);
      g.strokePath();
    }
  }

  destroy(): void {
    for (const item of this.items) item.gfx.destroy();
    this.items = [];
  }
}
