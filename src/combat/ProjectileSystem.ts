import Phaser from 'phaser';
import { MATERIALS, parseColor } from '../config/materials';
import type { WorldRegistry } from '../world/WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageSystem } from './DamageSystem';
import type { Player } from '../entities/Player';
import { raycast, getWorldBodies } from './Raycast';
import type { RayHit } from './Raycast';
import type { BulletConfig } from './WeaponFormat';

/**
 * 逻辑弹道子弹系统。
 *
 * 子弹不是物理刚体，而是"位置 + 单位方向 + 速度"的纯逻辑对象，每帧飞一段：
 *   上一帧位置 ──射线──→ 本帧位置
 * 命中点、法线都由射线求得，因此：
 *   - 高速子弹不会隧穿薄地形（一次步进跨多远都能检测到）
 *   - 穿透（继续飞，伤害衰减）/ 反弹（按法线反射）/ 命中即停 都可控
 *   - 零物理体创建销毁，连发不产生 GC 压力
 *   - 联机时天然可确定性同步
 */

export interface ProjectileSpawnOptions {
  weaponId: string;
  /** 起点（枪口） */
  x: number;
  y: number;
  /** 方向（弧度，世界） */
  angle: number;
  damage: number;
  knockback: number;
  ownerId: number;
  ownerBody: MatterJS.BodyType;
  bullet: BulletConfig;
}

interface Projectile {
  weaponId: string;
  x: number;
  y: number;
  /** 单位方向向量 */
  vx: number;
  vy: number;
  speed: number;
  range: number;
  traveled: number;
  damage: number;
  /** 当前伤害倍率（穿透/反弹逐次衰减） */
  damageMul: number;
  knockback: number;
  ownerId: number;
  ownerBody: MatterJS.BodyType;
  bullet: BulletConfig;
  /** 剩余反弹次数 */
  bounceLeft: number;
  alive: boolean;
  /** 已穿透的目标（避免同一发子弹重复命中同一物体） */
  ignore: MatterJS.BodyType[];
  color: number;
  /** 烟雾拖尾计时（ms）：火箭/手榴弹喷烟用 */
  smokeTimer: number;
}

export class ProjectileSystem {
  private readonly scene: Phaser.Scene;
  private readonly damageSystem: DamageSystem;
  private readonly registry: WorldRegistry;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;
  private readonly g: Phaser.GameObjects.Graphics;
  private projectiles: Projectile[] = [];

  /** 同时存在的子弹上限（超出后丢弃最老的，防极端情况失控） */
  private static readonly MAX_PROJECTILES = 240;
  /** 单帧最多解算的命中次数（穿透连击保护） */
  private static readonly MAX_HITS_PER_STEP = 8;

  constructor(
    scene: Phaser.Scene,
    damageSystem: DamageSystem,
    registry: WorldRegistry,
    bodyToPlayer: Map<number, Player>,
    fx: FxSystem,
  ) {
    this.scene = scene;
    this.damageSystem = damageSystem;
    this.registry = registry;
    this.bodyToPlayer = bodyToPlayer;
    this.fx = fx;
    this.g = scene.add.graphics();
    this.g.setDepth(850);
  }

  get count(): number {
    return this.projectiles.length;
  }

  spawn(options: ProjectileSpawnOptions): void {
    if (this.projectiles.length >= ProjectileSystem.MAX_PROJECTILES) {
      this.projectiles.shift();
    }
    const { bullet } = options;
    this.projectiles.push({
      weaponId: options.weaponId,
      x: options.x,
      y: options.y,
      vx: Math.cos(options.angle),
      vy: Math.sin(options.angle),
      speed: bullet.speed,
      range: bullet.range,
      traveled: 0,
      damage: options.damage,
      damageMul: 1,
      knockback: options.knockback,
      ownerId: options.ownerId,
      ownerBody: options.ownerBody,
      bullet,
      bounceLeft: bullet.maxBounces,
      alive: true,
      ignore: [],
      color: parseColor(bullet.color, 0xffffff),
      smokeTimer: 0,
    });
  }

  /** 每帧推进所有子弹并重绘 */
  update(deltaMs: number): void {
    if (this.projectiles.length > 0) {
      for (const p of this.projectiles) {
        if (!p.alive) continue;
        this.step(p, deltaMs);
        if (p.alive) this.emitSmoke(p, deltaMs);
      }
      this.projectiles = this.projectiles.filter((p) => p.alive);
    }
    this.draw();
  }

  /**
   * 单颗子弹步进：沿当前方向射线前进，命中则结算并可能改变方向（反弹）继续前进。
   */
  private step(p: Projectile, deltaMs: number): void {
    const bodies = getWorldBodies(this.scene);
    let remaining = (p.speed * deltaMs) / 1000;
    let guard = 0;

    while (remaining > 0.01 && p.alive) {
      if (guard++ > ProjectileSystem.MAX_HITS_PER_STEP) {
        p.alive = false;
        break;
      }

      const maxDist = Math.min(remaining, p.range - p.traveled);
      if (maxDist <= 0.01) {
        p.alive = false;
        break;
      }

      const hits = raycast(
        bodies,
        { x: p.x, y: p.y },
        { x: p.vx, y: p.vy },
        maxDist,
        { ignore: [p.ownerBody, ...p.ignore], maxHits: 1 },
      );
      const hit = hits[0];

      if (!hit) {
        // 一路无阻挡
        p.x += p.vx * maxDist;
        p.y += p.vy * maxDist;
        p.traveled += maxDist;
        break;
      }

      // 推进到命中点
      p.x = hit.point.x;
      p.y = hit.point.y;
      p.traveled += hit.distance;
      remaining -= hit.distance;

      const stop = this.onHit(p, hit);
      if (stop) {
        p.alive = false;
      }
    }

    if (p.traveled >= p.range) p.alive = false;
  }

  /** 火箭/手榴弹的烟雾拖尾（视觉上强化"这发子弹在慢慢飞"） */
  private emitSmoke(p: Projectile, deltaMs: number): void {
    const kind = p.bullet.kind;
    if (kind !== 'rocket' && kind !== 'grenade') return;
    p.smokeTimer -= deltaMs;
    if (p.smokeTimer > 0) return;
    p.smokeTimer = 45;
    this.fx.hitSpark(
      { x: p.x - p.vx * 6, y: p.y - p.vy * 6 },
      { x: -p.vx, y: -p.vy },
      0xb9c4d0,
    );
  }

  /** 结算一次命中。返回 true = 子弹终止 */
  private onHit(p: Projectile, hit: RayHit): boolean {
    const amount = p.damage * p.damageMul;
    const knockback = {
      x: p.vx * p.knockback,
      y: p.vy * p.knockback * 0.5 - 1.5,
    };

    // ---- 命中玩家 ----
    const target = this.bodyToPlayer.get(hit.body.id);
    if (target) {
      this.damageSystem.damagePlayer(target, {
        amount,
        kind: 'bullet',
        sourceId: p.ownerId,
        point: hit.point,
        normal: hit.normal,
        knockback,
      });
      if (p.bullet.piercePlayers) {
        p.ignore.push(hit.body);
        p.damageMul *= p.bullet.pierceDamageMul;
        this.advancePast(p, hit);
        return false;
      }
      return true;
    }

    // ---- 命中地图物体 ----
    const runtime = this.registry.resolve(hit.body);
    if (!runtime) return true; // 未知物体：视为阻挡

    const material = MATERIALS[runtime.material];
    this.damageSystem.damageObject(runtime, {
      amount,
      kind: 'bullet',
      sourceId: p.ownerId,
      point: hit.point,
      normal: hit.normal,
    });

    // 穿透（纸箱等）：伤害衰减后继续飞
    if (material?.bulletPierce) {
      p.ignore.push(hit.body);
      p.damageMul *= p.bullet.pierceDamageMul;
      this.advancePast(p, hit);
      return false;
    }

    // 反弹（金属等）：按法线反射，伤害衰减，最多 N 次
    if (material?.bulletBounce && p.bounceLeft > 0) {
      const dot = p.vx * hit.normal.x + p.vy * hit.normal.y;
      p.vx -= 2 * dot * hit.normal.x;
      p.vy -= 2 * dot * hit.normal.y;
      p.bounceLeft -= 1;
      p.damageMul *= p.bullet.bounceDamageMul;
      // 从表面稍微推开，避免下一段立刻再次命中同一个面
      p.x = hit.point.x + hit.normal.x * 0.8;
      p.y = hit.point.y + hit.normal.y * 0.8;
      return false;
    }

    return true;
  }

  /** 穿透后前进一点点，避免下一段射线从同一位置再次命中 */
  private advancePast(p: Projectile, hit: RayHit): void {
    p.x = hit.point.x + p.vx * 0.8;
    p.y = hit.point.y + p.vy * 0.8;
  }

  private draw(): void {
    this.g.clear();
    for (const p of this.projectiles) {
      const { bullet } = p;
      if (bullet.trail > 0) {
        this.g.lineStyle(Math.max(1, bullet.size * 0.7), p.color, 0.4);
        this.g.lineBetween(
          p.x - p.vx * bullet.trail,
          p.y - p.vy * bullet.trail,
          p.x,
          p.y,
        );
      }
      this.g.fillStyle(p.color, 1);
      this.g.fillCircle(p.x, p.y, bullet.size);

      // 火箭/手榴弹：亮一点的核心
      if (bullet.kind === 'rocket' || bullet.kind === 'grenade') {
        this.g.fillStyle(0xffffff, 0.85);
        this.g.fillCircle(p.x, p.y, bullet.size * 0.4);
      }
    }
  }

  destroy(): void {
    this.projectiles = [];
    this.g.destroy();
  }
}
