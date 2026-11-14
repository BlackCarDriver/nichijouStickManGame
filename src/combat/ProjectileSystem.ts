import Phaser from 'phaser';
import { MATERIALS, parseColor } from '../config/materials';
import type { WorldRegistry } from '../world/WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageSystem } from './DamageSystem';
import type { Player } from '../entities/Player';
import { raycast, getWorldBodies } from './Raycast';
import type { RayHit } from './Raycast';
import type { BulletConfig, ExplosionConfig } from './WeaponFormat';
import { getWeapon } from './WeaponFormat';
import { drawHeldWeapon } from '../render/WeaponRenderer';
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
  /** 由网络事件重建（不再触发"本端开火"的拦截/广播） */
  relayed?: boolean;
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
  /**
   * 是否仍忽略发射者本人。
   * 初始 true（子弹不会立刻打到自己），**反弹一次后置 false**：
   * 跳弹可以打回自己（伤害/速度都已按反弹衰减）。
   */
  ignoreOwner: boolean;
  ignore: MatterJS.BodyType[];
  color: number;
  smokeTimer: number;
  /** 当前单位飞行方向（渲染拖尾用） */
  dirX: number;
  dirY: number;
  /** 匕首飞行时的自旋角度（弧度）；只影响视觉，不改变命中方向 */
  spinAngle: number;
  /** 匕首自旋速度（弧度/秒） */
  spinSpeed: number;
  gfx?: Phaser.GameObjects.Graphics;
  /**
   * 最近若干帧的位置（旧→新）。拖尾按**真实轨迹**画，而不是"当前方向反推一条直线"：
   * 子弹是抛物线、还能反弹，直线拖尾会和实际路径脱节。
   */
  history: { x: number; y: number }[];
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
  /** 独立视觉：用与手持/飞行时**完全相同**的武器模型（插上后外观不变） */
  gfx?: Phaser.GameObjects.Graphics;
}

export class ProjectileSystem {
  private readonly scene: Phaser.Scene;
  private readonly damageSystem: DamageSystem;
  private readonly registry: WorldRegistry;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;
  private readonly explode: (req: ExplosionRequest) => void;
  private readonly g: Phaser.GameObjects.Graphics;
  /** 拖尾绘制用的复用数组（避免每帧分配） */
  private readonly scratchA: { x: number; y: number }[] = [];
  private readonly scratchB: { x: number; y: number }[] = [];
  private readonly scratchC: { x: number; y: number }[] = [];
  private projectiles: Projectile[] = [];
  private stuck: StuckItem[] = [];

  private static readonly MAX_PROJECTILES = 240;
  private static readonly MAX_STUCK = 24;
  private static readonly MAX_HITS_PER_STEP = 8;
  /** 插入物消失前的闪烁时长（ms） */
  private static readonly STUCK_BLINK_MS = 1000;
  /**
   * 腰部手榴弹的命中判定带（px）。
   * 用「命中点与腰部锚点的垂直距离」而不是 2D 距离：
   * 玩家碰撞体宽 36，榴弹挂在背面边缘，2D 距离会被命中面（前/后）严重影响，
   * 导致"从背面打中不算、从正面打中才算"。只看高度带则手感稳定可预期。
   */
  private static readonly GRENADE_WAIST_BAND = 10;

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

  /** 调试/自动化测试用：当前在场投掷物的只读快照 */
  debugProjectiles(): Array<{ x: number; y: number; ownerId: number; weaponId: string }> {
    return this.projectiles.map((p) => ({ x: p.x, y: p.y, ownerId: p.ownerId, weaponId: p.weaponId }));
  }

  /**
   * 出生拦截器（联机用）。
   *
   * 返回 false = 这次出生不要在本地创建（别人的投掷物会由中继事件补上来），
   * 返回 true = 正常创建。同时由实现方负责"把自己开火的出生广播出去"。
   *
   * 为什么在这个位置拦：`spawn()` 是所有投掷物的唯一出口
   * （枪械弹丸 / 投掷武器 / 手雷都走它），拦这里就不会漏。
   */
  onSpawn?: (options: ProjectileSpawnOptions) => boolean;

  spawn(options: ProjectileSpawnOptions): void {
    if (!options.relayed && this.onSpawn && !this.onSpawn(options)) return;
    if (this.projectiles.length >= ProjectileSystem.MAX_PROJECTILES) {
      const dropped = this.projectiles.shift();
      dropped?.gfx?.destroy();
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
      ignoreOwner: true,
      ignore: [],
      color: parseColor(bullet.color, 0xffffff),
      smokeTimer: 0,
      dirX: Math.cos(options.angle),
      dirY: Math.sin(options.angle),
      spinAngle: 0,
      // 匕首快速但不刺眼地连续翻转；长矛保持沿飞行方向，便于辨识其长度。
      spinSpeed: options.weaponId === 'dagger' ? 48 : 0, // 匕首飞行时翻滚（速度已加倍）
      history: [{ x: options.x, y: options.y }],
    });

    // 投掷武器：用与手持完全相同的模型渲染（不是画一根相似颜色的长条）
    const spawned = this.projectiles[this.projectiles.length - 1];
    if (bullet.kind === 'thrown') {
      const visual = getWeapon(options.weaponId)?.visual;
      if (visual) {
        const gfx = this.scene.add.graphics();
        gfx.setDepth(852);
        // 在局部把武器画成"朝 +x 方向、以自身中心为原点"，之后靠 position/rotation 跟随飞行
        drawHeldWeapon(gfx, {
          visual,
          facing: 1,
          aim: 0,
          hand: { x: -visual.length / 2, y: 0 },
        });
        spawned.gfx = gfx;
      }
    }
  }

  /** 每帧推进所有子弹并重绘 */
  update(deltaMs: number): void {
    if (this.projectiles.length > 0) {
      for (const p of this.projectiles) {
        if (!p.alive) continue;
        this.step(p, deltaMs);
        if (p.alive) this.emitSmoke(p, deltaMs);
      }
      for (const p of this.projectiles) {
        if (!p.alive) p.gfx?.destroy();
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
    p.spinAngle += p.spinSpeed * dt;

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
        { ignore: [...(p.ignoreOwner ? [p.ownerBody] : []), ...p.ignore], maxHits: 1 },
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

    // 记录轨迹用于拖尾（按拖尾长度决定取多少采样点）
    const maxSamples = Phaser.Math.Clamp(Math.ceil(p.bullet.trail / 12) + 2, 4, 14);
    p.history.push({ x: p.x, y: p.y });
    if (p.history.length > maxSamples) p.history.shift();
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
      // 能否钉进去：stickable 明确指定优先，否则按"投掷伤害 > 硬度"判定
      const runtime = this.registry.resolve(hit.body);
      const material = runtime ? MATERIALS[runtime.material] : undefined;
      const canStick = runtime
        ? material?.stickable === true
          ? true
          : material?.stickable === false
            ? false
            : amount - (material?.hardness ?? 0) > 0
        : true;
      if (!canStick) {
        this.scene.events.emit('thrown-blocked', p.weaponId, hit.point.x, hit.point.y);
        this.fx.hitSpark(hit.point, hit.normal, 0xdfe7f0);
        return true;
      }
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
        weaponId: p.weaponId,
        point: hit.point,
        normal: hit.normal,
        knockback,
        attackId: p.attackId,
      });
      // 腰上挂着手榴弹 → 打到腰部高度会引爆它（消耗这一发，由场景负责爆炸）
      if (target.grenadeCount > 0) {
        const waist = target.waistWorld;
        if (Math.abs(hit.point.y - waist.y) <= ProjectileSystem.GRENADE_WAIST_BAND) {
          this.scene.events.emit('carried-grenade-hit', target, waist, p.ownerId);
        }
      }
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
      // 反弹后速度衰减（未配置时默认 0.72，避免弹来弹去一直是原速）
      const rest = p.bullet.bounceRestitution ?? 0.72;
      p.vx = (p.vx - 2 * dot * hit.normal.x) * rest;
      p.vy = (p.vy - 2 * dot * hit.normal.y) * rest;
      p.bounceLeft -= 1;
      p.damageMul *= p.bullet.bounceDamageMul;
      // 反弹一次后不再免疫：跳弹可以打回自己（自伤由服务端/本地伤害系统正常结算）
      p.ignoreOwner = false;
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
        weaponId: p.weaponId,
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
      weaponId: p.weaponId,
      shrapnel: p.explosion.shrapnel,
    });
  }

  private addStuck(p: Projectile, hit: RayHit): void {
    if (this.stuck.length >= ProjectileSystem.MAX_STUCK) {
      const oldest = this.stuck.shift();
      oldest?.gfx?.destroy();
    }
    const body = hit.body;
    const angle = Math.atan2(p.dirY, p.dirX) + p.spinAngle;
    const item: StuckItem = {
      x: hit.point.x,
      y: hit.point.y,
      angle,
      color: p.color,
      size: p.bullet.size,
      remain: p.stickMs ?? 1500,
      followBody: body.isStatic ? undefined : body,
      offsetX: hit.point.x - body.position.x,
      offsetY: hit.point.y - body.position.y,
    };

    // 用真实武器模型（与手持/飞行时同一套绘制），插住后外观不变
    const visual = getWeapon(p.weaponId)?.visual;
    if (visual) {
      const gfx = this.scene.add.graphics();
      gfx.setDepth(851);
      drawHeldWeapon(gfx, {
        visual,
        facing: 1,
        aim: 0,
        hand: { x: -visual.length / 2, y: 0 },
      });
      gfx.setPosition(item.x, item.y);
      gfx.setRotation(angle);
      item.gfx = gfx;
    }

    this.stuck.push(item);
  }

  private updateStuck(deltaMs: number): void {
    for (let i = this.stuck.length - 1; i >= 0; i--) {
      const s = this.stuck[i];
      s.remain -= deltaMs;
      if (s.followBody) {
        s.x = s.followBody.position.x + s.offsetX;
        s.y = s.followBody.position.y + s.offsetY;
      }
      if (s.gfx) {
        s.gfx.setPosition(s.x, s.y);
        s.gfx.setRotation(s.angle);
        // 只保留"消失前 1 秒闪烁"，其余时间不改变外观
        const alpha =
          s.remain < ProjectileSystem.STUCK_BLINK_MS
            ? Math.floor(s.remain / 130) % 2 === 0 ? 1 : 0.22
            : 1;
        s.gfx.setAlpha(alpha);
      }
      if (s.remain <= 0) {
        s.gfx?.destroy();
        this.stuck.splice(i, 1);
      }
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

  /**
   * 锥形拖尾 + 多层发光弹头。
   *
   * 拖尾是一条**沿真实轨迹渐细的多边形带**（不是一根等宽直线）：
   *  - 尾端宽 0.12×、头端宽 ~1.07× → 读作"运动模糊"
   *  - 分两层（外发光 + 内核），外宽内窄，形成发光边缘
   *  - 顶点数组复用，避免每帧给每颗子弹分配新数组（GC 压力）
   *
   * 弹头是三层同心圆（外晕 → 本体 → 白热核心），比单个实心圆更有"热"感。
   */
  private drawTrail(p: Projectile): void {
    const { bullet } = p;
    const hist = p.history;
    const n = hist.length;

    if (bullet.trail > 0 && n >= 2) {
      const left = this.scratchA;
      const right = this.scratchB;
      const poly = this.scratchC;
      left.length = 0;
      right.length = 0;
      poly.length = 0;

      for (let i = 0; i < n; i++) {
        const prev = hist[Math.max(0, i - 1)];
        const next = hist[Math.min(n - 1, i + 1)];
        let dx = next.x - prev.x;
        let dy = next.y - prev.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        // 法线
        const nx = -dy;
        const ny = dx;
        const t = i / (n - 1); // 0 = 尾, 1 = 头
        const w = bullet.size * (0.12 + 0.95 * Math.pow(t, 1.6));
        left.push({ x: hist[i].x + nx * w, y: hist[i].y + ny * w });
        right.push({ x: hist[i].x - nx * w, y: hist[i].y - ny * w });
      }

      // 外发光
      for (const v of left) poly.push(v);
      for (let i = right.length - 1; i >= 0; i--) poly.push(right[i]);
      this.g.fillStyle(p.color, 0.2);
      this.g.fillPoints(poly, true);

      // 内核（更细更亮）
      poly.length = 0;
      for (let i = 0; i < left.length; i++) {
        const c = hist[i];
        poly.push({ x: c.x + (left[i].x - c.x) * 0.45, y: c.y + (left[i].y - c.y) * 0.45 });
      }
      for (let i = right.length - 1; i >= 0; i--) {
        const c = hist[i];
        poly.push({ x: c.x + (right[i].x - c.x) * 0.45, y: c.y + (right[i].y - c.y) * 0.45 });
      }
      this.g.fillStyle(p.color, 0.75);
      this.g.fillPoints(poly, true);
    }

    // 弹头：外晕 → 本体 → 白热核心
    const size = bullet.size;
    this.g.fillStyle(p.color, 0.28);
    this.g.fillCircle(p.x, p.y, size * 1.9);
    this.g.fillStyle(p.color, 1);
    this.g.fillCircle(p.x, p.y, size);
    this.g.fillStyle(0xffffff, 0.92);
    this.g.fillCircle(p.x, p.y, size * 0.45);
  }

  private draw(): void {
    this.g.clear();
    for (const p of this.projectiles) {
      const { bullet } = p;

      // 投掷武器用独立 Graphics（真实武器模型），这里只同步位置与旋转
      if (bullet.kind === 'thrown') {
        if (p.gfx) {
          p.gfx.setPosition(p.x, p.y);
          p.gfx.setRotation(Math.atan2(p.dirY, p.dirX) + p.spinAngle);
        }
        continue;
      }

      this.drawTrail(p);
    }

    // 插在目标上的投掷物由各自的 gfx 绘制（真实武器模型），这里无需再画
  }

  destroy(): void {
    for (const p of this.projectiles) p.gfx?.destroy();
    for (const s of this.stuck) s.gfx?.destroy();
    this.projectiles = [];
    this.stuck = [];
    this.g.destroy();
  }
}
