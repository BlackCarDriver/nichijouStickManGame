import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import type { WorldRegistry } from '../world/WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageSystem } from './DamageSystem';
import type { ShrapnelConfig } from './WeaponFormat';

/** 一次爆炸请求 */
export interface ExplosionRequest {
  x: number;
  y: number;
  /** 半径（px） */
  radius: number;
  /** 中心伤害（边缘按距离线性衰减到 0） */
  damage: number;
  /** 是否伤害投掷者自己 */
  selfDamage: boolean;
  /** 击退强度 */
  knockback: number;
  /** 投掷者实体 id（自伤判定 / 击杀归属） */
  ownerId: number;
  sourceId: number;
  /** 造成爆炸的武器 id（击杀回放用；手榴弹为 'grenade'） */
  weaponId?: string;
  /**
   * 无视受击无敌帧（可选）。
   * 用于"同一瞬间先挨了子弹、随后怀里榴弹爆炸"这种场景：
   * 否则子弹给的 180ms 无敌会把紧接着的爆炸伤害全部吃掉。
   */
  ignoreInvuln?: boolean;
  /** 破片配置（不填 = 不弹破片） */
  shrapnel?: ShrapnelConfig;
  /**
   * 跳过玩家伤害（可选）。
   * 用于"没有攻击者"的爆炸（材质自爆）：联机时玩家伤害由各自客户端上报环境伤害，
   * 这里再算一遍会造成重复预览/双倍数字。
   */
  skipPlayerDamage?: boolean;
}

/**
 * 爆炸系统：范围伤害 + 击退 + 环境破坏 + 视觉。
 *
 * 三个作用面：
 *   1. 玩家：按距离衰减扣血；**对投掷者自身也生效**（需求：火箭/手榴弹会炸到自己）
 *   2. 地图物体：按距离衰减扣耐久（→ 破坏系统接管）
 *   3. 动态刚体：施加向外冲量（**按 mass 归一**，轻重物体都飞得合理）
 */
export class ExplosionSystem {
  private readonly scene: Phaser.Scene;
  /** 破片系统（可选注入，避免构造函数参数过长） */
  private shrapnelSystem: {
    burst: (x: number, y: number, count: number, damage: number, speed: number, range: number, ownerId: number, weaponId?: string) => void;
  } | null = null;
  private readonly damageSystem: DamageSystem;
  private readonly registry: WorldRegistry;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;

  /** 冲量强度系数：Matter 的 force 经 dt²(≈277) 积分成速度，除以它得到"期望速度变化" */
  private static readonly FORCE_TO_VELOCITY = 1 / 277;
  /** 击退换算到刚体的期望速度变化（px/帧） */
  private static readonly IMPULSE_SCALE = 9;

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
  }

  /** 注入破片系统（GameScene 构造完两个系统后调用） */
  attachShrapnel(system: {
    burst: (x: number, y: number, count: number, damage: number, speed: number, range: number, ownerId: number, weaponId?: string) => void;
  }): void {
    this.shrapnelSystem = system;
  }

  explode(req: ExplosionRequest): void {
    const { x, y, radius, damage, knockback } = req;

    // ---- 视觉：爆散火花 + 扩散环 + 屏幕震动 ----
    this.fx.burst({ x, y }, 0xffb347);
    this.fx.ring(x, y, radius, 0xffa94d);
    this.scene.events.emit('explosion', x, y, radius);

    // ---- 破片：向四周弹射（需求 4）----
    if (req.shrapnel && this.shrapnelSystem) {
      const sh = req.shrapnel;
      this.shrapnelSystem.burst(x, y, sh.count, sh.damage, sh.speed, sh.range, req.sourceId, req.weaponId);
    }

    // ---- 玩家 ----
    if (!req.skipPlayerDamage) for (const player of this.bodyToPlayer.values()) {
      if (player.health.isDead) continue;
      if (!req.selfDamage && player.id === req.ownerId) continue;
      const dist = Phaser.Math.Distance.Between(x, y, player.container.x, player.container.y);
      if (dist > radius) continue;

      const falloff = 1 - dist / radius;
      const dirX = dist > 1 ? (player.container.x - x) / dist : 0;
      const dirY = dist > 1 ? (player.container.y - y) / dist : -1;
      this.damageSystem.damagePlayer(player, {
        amount: damage * falloff,
        kind: 'explosion',
        sourceId: req.sourceId,
        weaponId: req.weaponId,
        point: { x, y },
        knockback: {
          x: dirX * knockback * falloff,
          y: dirY * knockback * falloff - 3 * falloff,
        },
        ignoreInvuln: req.ignoreInvuln === true,
      });
    }

    // ---- 地图物体 + 动态刚体 ----
    for (const runtime of [...this.registry.objects]) {
      const body = runtime.body;
      if (!body) continue;
      const dist = Phaser.Math.Distance.Between(x, y, body.position.x, body.position.y);
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;

      // 伤害（材质伤害倍率在 DestructionSystem 里应用）
      this.damageSystem.damageObject(runtime, {
        amount: damage * falloff,
        kind: 'explosion',
        sourceId: req.sourceId,
        point: { x, y },
      });

      // 冲量（只有动态刚体能被推动）
      if (!body.isStatic) {
        this.push(body, x, y, dist, falloff);
      }
    }
  }

  /**
   * 对刚体施加向外冲量。
   * Matter 里 force 会按 mass 与 dt² 积分成速度，因此：
   *   force = mass × 期望速度变化 ÷ dt²  → 轻重物体获得相同速度变化
   * 这样纸箱不会飞到外太空、金属球也不会纹丝不动。
   */
  private push(
    body: MatterJS.BodyType,
    cx: number,
    cy: number,
    dist: number,
    falloff: number,
  ): void {
    const dirX = dist > 1 ? (body.position.x - cx) / dist : 0;
    const dirY = dist > 1 ? (body.position.y - cy) / dist : -1;
    const dv = ExplosionSystem.IMPULSE_SCALE * falloff;
    const k = body.mass * dv * ExplosionSystem.FORCE_TO_VELOCITY;
    this.scene.matter.body.applyForce(body, body.position, {
      x: dirX * k,
      y: dirY * k - body.mass * 1.5 * ExplosionSystem.FORCE_TO_VELOCITY,
    });
  }
}
