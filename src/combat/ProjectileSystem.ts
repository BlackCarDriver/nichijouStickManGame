import Phaser from 'phaser';
import { MATERIALS, parseColor } from '../config/materials';
import type { WorldRegistry } from '../world/WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageSystem } from './DamageSystem';
import type { Player } from '../entities/Player';
import { raycast, getWorldBodies } from './Raycast';
import type { RayHit } from './Raycast';
import type { BulletConfig, ExplosionConfig } from './WeaponFormat';
import { resolveGravity } from './WeaponFormat';
import type { ExplosionRequest } from './ExplosionSystem';

/**
 * 逻辑弹道子弹系统。
 *
 * 子弹不是物理刚体，而是"位置 + 速度向量（px/秒）"的纯逻辑对象，每帧：
 *   1. 施加重力（vy += gravity * dt）→ **抛物线**
 *   2. 用「上帧位置 → 本帧位置」的线段射线求交（高速也不会隧穿）
 *
 * 因此穿透 / 反弹 / 命中即停 / 爆炸 / 插入目标 都可控，
 * 且零物理体开销、联机天然可确定性同步。
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
  /** 命中时爆炸（火箭/手榴弹） */
  explosion?: ExplosionConfig;
  /** 引信（ms）：到期在原地自爆 */
  fuseMs?: number;
  /** 投掷物插入目标停留（ms）：匕首/长矛 */
  stickMs?: number;
  /** 攻击批次 id（霰弹多弹丸共用，用于绕过同批次的无敌帧） */
  attackId?: number;
}

interface Projectile {
  weaponId: string;
  x: number;
  y: number;
  /** 速度向量（px/秒），受重力影响后不再保持单位长度 */
  vx: number;
  vy: number;
  gravity: number;
  range: number;
  traveled: number;
  damage: number;
  damageMul: number;
  knockback: number;
  ownerId: number;
  ownerBody: MatterJS.BodyType;
  bullet: BulletConfig;
  explosion?: ExplosionConfig;
  fuseMs?: number;
  stickMs?: number;
  attackId?: number;
  elapsed: number;
  bounceLeft: number;
  alive: boolean;
  ignore: MatterJS.BodyType[];
  color: number;
  smokeTimer: number;
  /** 当前单位飞行方向（渲染拖尾用） */
  dirX: number;
  dirY: number;
}

/** 插在目标上的投掷物（停留一段时间后消失） */
interface StuckItem {
  x: number;
  y: number;
  angle: number;
  color: number;
  size: number;
  remain: number;
  /** 跟随目标 body（动态物体时） */
  followBody?: MatterJS.BodyType;
  offsetX: number;
  offsetY: number;
}

export class ProjectileSystem {
  private readonly scene: Phaser.Scene;
  private readonly damageSystem: DamageSystem;
  private readonly registry: WorldRegistry;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;
  private readonly explode: (req: ExplosionRequest) => void;
  private readonly g: Phaser.GameObjects.Graphics;
  private projectiles: Projectile[] = [];
  private stuck: StuckItem[] = [];

  private static readonly MAX_PROJECTILES = 240;
  private static readonly MAX_STUCK = 24;
  private static readonly MAX_HITS_PER_STEP = 8;

  constructor(
    scene: Phaser.Scene,
    damageSystem: DamageSystem,
    registry: WorldRegistry,
    bodyToPlayer: Map<number, Player>,
    fx: FxSystem,
    explode: (req: ExplosionRequest) => void,
  ) {
    this.scene = scene;
    this.damageSystem = damageSystem;
    this.registry = registry;
    this.bodyToPlayer = bodyToPlayer;
    this.fx = fx;
    this.explode = explode;
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
      vx: Math.cos(options.angle) * bullet.speed,
      vy: Math.sin(options.angle) * bullet.speed,
      gravity: resolveGravity(bullet.gravity),
      range: bullet.range,
      traveled: 0,
      damage: options.damage,
      damageMul: 1,
      knockback: options.knockback,
      ownerId: options.ownerId,
      ownerBody: options.ownerBody,
      bullet,
      explosion: options.explosion,
      fuseMs: options.fuseMs,
      stickMs: options.stickMs,
      attackId: options.attackId,
      elapsed: 0,
      bounceLeft: Math.max(bullet.maxBounces, bullet.bounceAny ? 6 : 0),
      alive: true,
      ignore: [],
      color: parseColor(bullet.color, 0xffffff),
      smokeTimer: 0,
      dirX: Math.cos(options.angle),
      dirY: Math.sin(options.angle),
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
    this.updateStuck(deltaMs);
    this.draw();
  }

  /** 单颗子弹步进：施加重力 → 沿当前速度方向射线前进 → 命中结算 */
  private step(p: Projectile, deltaMs: number): void {
    const dt = deltaMs / 1000;
    p.elapsed += deltaMs;

    // 重力 → 抛物线
    p.vy += p.gravity * dt;

    // 引信到期：原地爆炸（手榴弹）
    if (p.fuseMs && p.elapsed >= p.fuseMs) {
      this.explodeAt(p, p.x, p.y);
      p.alive = false;
      return;
    }

    let remaining = Math.hypot(p.vx, p.vy) * dt;
    let guard = 0;
    const bodies = getWorldBodies(this.scene);

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

      const speed = Math.hypot(p.vx, p.vy);
      if (speed < 0.5) {
        // 引信弹（手榴弹）：停在地上等引信，不消失
        if (p.fuseMs) return;
        p.alive = false;
        break;
      }
      const dirX = p.vx / speed;
      const dirY = p.vy / speed;
      p.dirX = dirX;
      p.dirY = dirY;

      const hits = raycast(
        bodies,
        { x: p.x, y: p.y },
        { x: dirX, y: dirY },
        maxDist,
        { ignore: [p.ownerBody, ...p.ignore], maxHits: 1 },
      );
      const hit = hits[0];

      if (!hit) {
        p.x += dirX * maxDist;
        p.y += dirY * maxDist;
        p.traveled += maxDist;
        break;
      }

      p.x = hit.point.x;
      p.y = hit.point.y;
      p.traveled += hit.distance;
      remaining -= hit.distance;

      if (this.onHit(p, hit, dirX, dirY)) {
        p.alive = false;
      }
    }

    if (p.traveled >= p.range) {
      // 射程耗尽：爆炸弹就地引爆，普通弹消失
      if (p.explosion) this.explodeAt(p, p.x, p.y);
      p.alive = false;
    }
  }

  /** 结算一次命中。返回 true = 子弹终止 */
  private onHit(p: Projectile, hit: RayHit, dirX: number, dirY: number): boolean {
    // ---- 引信弹（手榴弹）：碰到任何东西都只弹开，等引信到期才爆炸 ----
    if (p.fuseMs) {
      this.bounceOff(p, hit);
      return false;
    }

    // ---- 爆炸弹（火箭）：命中即引爆 ----
    if (p.explosion) {
      this.explodeAt(p, hit.point.x, hit.point.y);
      return true;
    }

    const amount = p.damage * p.damageMul;
    const knockback = { x: dirX * p.knockback, y: dirY * p.knockback * 0.5 - 1.5 };

    // ---- 投掷物（匕首/长矛）：先结算伤害，再插入目标停留 ----
    if (p.stickMs) {
      this.applyDamageTo(p, hit, amount, knockback);
      this.addStuck(p, hit);
      return true;
    }

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
        attackId: p.attackId,
      });
      if (p.bullet.piercePlayers) {
        p.ignore.push(hit.body);
        p.damageMul *= p.bullet.pierceDamageMul;
        this.advancePast(p, hit, dirX, dirY);
        return false;
      }
      return true;
    }

    // ---- 命中地图物体 ----
    const runtime = this.registry.resolve(hit.body);
    if (!runtime) return true;

    const material = MATERIALS[runtime.material];
    this.damageSystem.damageObject(runtime, {
      amount,
      kind: 'bullet',
      sourceId: p.ownerId,
      point: hit.point,
      normal: hit.normal,
    });

    // 穿透（纸箱等）
    if (material?.bulletPierce) {
      p.ignore.push(hit.body);
      p.damageMul *= p.bullet.pierceDamageMul;
      this.advancePast(p, hit, dirX, dirY);
      return false;
    }

    // 反弹（金属；手榴弹对任意材质反弹）
    const canBounce = material?.bulletBounce || p.bullet.bounceAny;
    if (canBounce && p.bounceLeft > 0) {
      const dot = p.vx * hit.normal.x + p.vy * hit.normal.y;
      const rest = p.bullet.bounceRestitution ?? 1;
      p.vx = (p.vx - 2 * dot * hit.normal.x) * rest;
      p.vy = (p.vy - 2 * dot * hit.normal.y) * rest;
      p.bounceLeft -= 1;
      p.damageMul *= p.bullet.bounceDamageMul;
      p.x = hit.point.x + hit.normal.x * 0.8;
      p.y = hit.point.y + hit.normal.y * 0.8;
      return false;
    }

    return true;
  }

  /**
   * 从表面弹开（引信弹用）。按法线反射并衰减速度，
   * 同时把位置推到表面外侧，避免下一段立刻再次命中同一面。
   */
  private bounceOff(p: Projectile, hit: RayHit): void {
    const dot = p.vx * hit.normal.x + p.vy * hit.normal.y;
    const rest = p.bullet.bounceRestitution ?? 0.5;
    p.vx = (p.vx - 2 * dot * hit.normal.x) * rest;
    p.vy = (p.vy - 2 * dot * hit.normal.y) * rest;
    p.x = hit.point.x + hit.normal.x * 1.2;
    p.y = hit.point.y + hit.normal.y * 1.2;
  }

  /** 对单个目标结算伤害（投掷物/爆炸共用口径） */
  private applyDamageTo(
    p: Projectile,
    hit: RayHit,
    amount: number,
    knockback: { x: number; y: number },
  ): void {
    const player = this.bodyToPlayer.get(hit.body.id);
    if (player) {
      this.damageSystem.damagePlayer(player, {
        amount,
        kind: 'melee',
        sourceId: p.ownerId,
        point: hit.point,
        normal: hit.normal,
        knockback,
      });
      return;
    }
    const runtime = this.registry.resolve(hit.body);
    if (runtime) {
      this.damageSystem.damageObject(runtime, {
        amount,
        kind: 'melee',
        sourceId: p.ownerId,
        point: hit.point,
        normal: hit.normal,
      });
    }
  }

  private explodeAt(p: Projectile, x: number, y: number): void {
    if (!p.explosion) return;
    this.explode({
      x,
      y,
      radius: p.explosion.radius,
      damage: p.explosion.damage,
      selfDamage: p.explosion.selfDamage,
      knockback: p.explosion.knockback,
      ownerId: p.ownerId,
      sourceId: p.ownerId,
    });
  }

  private addStuck(p: Projectile, hit: RayHit): void {
    if (this.stuck.length >= ProjectileSystem.MAX_STUCK) this.stuck.shift();
    const body = hit.body;
    this.stuck.push({
      x: hit.point.x,
      y: hit.point.y,
      angle: Math.atan2(p.dirY, p.dirX),
      color: p.color,
      size: p.bullet.size,
      remain: p.stickMs ?? 1500,
      followBody: body.isStatic ? undefined : body,
      offsetX: hit.point.x - body.position.x,
      offsetY: hit.point.y - body.position.y,
    });
  }

  private updateStuck(deltaMs: number): void {
    for (let i = this.stuck.length - 1; i >= 0; i--) {
      const s = this.stuck[i];
      s.remain -= deltaMs;
      if (s.followBody) {
        s.x = s.followBody.position.x + s.offsetX;
        s.y = s.followBody.position.y + s.offsetY;
      }
      if (s.remain <= 0) this.stuck.splice(i, 1);
    }
  }

  /** 火箭/手榴弹的烟雾拖尾 */
  private emitSmoke(p: Projectile, deltaMs: number): void {
    const kind = p.bullet.kind;
    if (kind !== 'rocket' && kind !== 'grenade') return;
    p.smokeTimer -= deltaMs;
    if (p.smokeTimer > 0) return;
    p.smokeTimer = 45;
    this.fx.hitSpark(
      { x: p.x - p.dirX * 6, y: p.y - p.dirY * 6 },
      { x: -p.dirX, y: -p.dirY },
      0xb9c4d0,
    );
  }

  private advancePast(p: Projectile, hit: RayHit, dirX: number, dirY: number): void {
    p.x = hit.point.x + dirX * 0.8;
    p.y = hit.point.y + dirY * 0.8;
  }

  private draw(): void {
    this.g.clear();
    for (const p of this.projectiles) {
      const { bullet } = p;
      if (bullet.trail > 0) {
        this.g.lineStyle(Math.max(1, bullet.size * 0.7), p.color, 0.4);
        this.g.lineBetween(
          p.x - p.dirX * bullet.trail,
          p.y - p.dirY * bullet.trail,
          p.x,
          p.y,
        );
      }
      this.g.fillStyle(p.color, 1);
      this.g.fillCircle(p.x, p.y, bullet.size);
      if (bullet.kind === 'rocket' || bullet.kind === 'grenade') {
        this.g.fillStyle(0xffffff, 0.85);
        this.g.fillCircle(p.x, p.y, bullet.size * 0.4);
      }
    }

    // 插在目标上的投掷物（随剩余时间淡出）
    for (const s of this.stuck) {
      const alpha = Math.min(1, s.remain / 400);
      const dx = Math.cos(s.angle);
      const dy = Math.sin(s.angle);
      this.g.lineStyle(Math.max(2, s.size), s.color, alpha);
      this.g.lineBetween(s.x - dx * 10, s.y - dy * 10, s.x + dx * 8, s.y + dy * 8);
    }
  }

  destroy(): void {
    this.projectiles = [];
    this.stuck = [];
    this.g.destroy();
  }
}
