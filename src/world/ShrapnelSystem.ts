import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import type { DamageSystem } from '../combat/DamageSystem';
import type { WorldRegistry } from './WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';
import { raycast, getWorldBodies } from '../combat/Raycast';

/** 一块飞散的破片 */
interface Shrapnel {
  x: number;
  y: number;
  /** 单位方向 */
  dx: number;
  dy: number;
  /** 速度（px/秒） */
  speed: number;
  /** 已飞行距离 */
  traveled: number;
  /** 剩余寿命（ms，安全网：极端情况下兜底回收） */
  remain: number;
  /** 最大飞行距离（超过即消失） */
  range: number;
  damage: number;
  ownerId: number;
  gfx: Phaser.GameObjects.Graphics;
}

/**
 * 爆炸破片系统（手榴弹 / 火箭炮）。
 *
 * 需求：爆炸时**像子弹一样**向四周发射碎片，碎片击中敌人或物体产生伤害，
 * 飞行约两个火柴人身高（≈222px）后消失。
 *
 * 因此这里**不用物理刚体**，而是和子弹同款的逻辑弹道：
 * - 每帧用「上一帧位置 → 本帧位置」的射线求交（高速也不会穿透）
 * - 直线飞行、不受重力，命中即结算伤害并终止 —— 这就是"子弹感"
 * - 撞到任何实体都会停下（不做反弹），与子弹一致
 *
 * 好处：20 块破片不产生 20 个 Matter 刚体（连锁爆炸时不会拖垮物理世界），
 * 且不会把角色/箱子顶飞（爆炸的击退已经由 ExplosionSystem 单独处理）。
 */
export class ShrapnelSystem {
  private readonly scene: Phaser.Scene;
  private readonly damageSystem: DamageSystem;
  private readonly registry: WorldRegistry;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;
  private readonly shards: Shrapnel[] = [];

  /** 同时存在的破片上限（连锁爆炸保护） */
  private static readonly MAX = 240;
  /** 破片最长寿命（ms）：防止极小速度时长期残留 */
  private static readonly LIFE_MS = 1200;

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

  get count(): number {
    return this.shards.length;
  }

  /**
   * 在爆炸点向四周发射破片。
   * @param count  破片数量
   * @param damage 单块命中伤害
   * @param speed  速度（px/秒），越接近子弹越快
   * @param range  最大飞行距离（px）
   */
  burst(
    x: number,
    y: number,
    count: number,
    damage: number,
    speed: number,
    range: number,
    ownerId: number,
  ): void {
    const n = Math.max(0, Math.min(64, Math.round(count)));
    for (let i = 0; i < n; i++) {
      if (this.shards.length >= ShrapnelSystem.MAX) this.shards.shift();

      // 360° 均分 + 抖动（避免整齐的花瓣状），并给一点速度随机
      const base = (Math.PI * 2 * i) / n;
      const angle = base + (Math.random() - 0.5) * ((Math.PI * 2) / n) * 0.9;
      const gfx = this.scene.add.graphics();
      gfx.setDepth(832);

      this.shards.push({
        x: x + Math.cos(angle) * 8,
        y: y + Math.sin(angle) * 8,
        dx: Math.cos(angle),
        dy: Math.sin(angle),
        speed: speed * (0.85 + Math.random() * 0.3),
        traveled: 0,
        remain: ShrapnelSystem.LIFE_MS,
        range,
        damage,
        ownerId,
        gfx,
      });
    }
  }

  update(deltaMs: number): void {
    const dt = Math.min(deltaMs, 40) / 1000; // 掉帧时限制单帧步长，避免跨墙
    const bodies = getWorldBodies(this.scene);

    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.remain -= deltaMs;
      if (s.remain <= 0) {
        this.remove(s);
        continue;
      }
      const step = s.speed * dt;
      const remaining = s.range - s.traveled;
      const dist = Math.min(step, remaining);

      // 「上一帧 → 本帧」线段求交：高速也命中
      const hits = raycast(bodies, { x: s.x, y: s.y }, { x: s.dx, y: s.dy }, dist, { maxHits: 4 });
      const hit = hits[0];

      if (hit) {
        this.resolveHit(s, hit.point, hit.body);
        this.remove(s);
        continue;
      }

      s.x += s.dx * dist;
      s.y += s.dy * dist;
      s.traveled += dist;

      // 飞满距离 → 消失
      if (s.traveled >= s.range - 0.001) {
        this.remove(s);
        continue;
      }

      this.draw(s);
    }
  }

  /** 命中结算：玩家 / 可破坏物体扣血，其它（墙地）直接停 */
  private resolveHit(s: Shrapnel, point: { x: number; y: number }, body: MatterJS.BodyType): void {
    const player = this.bodyToPlayer.get(body.id);
    if (player) {
      if (!player.health.isDead) {
        this.damageSystem.damagePlayer(player, {
          amount: s.damage,
          kind: 'explosion',
          sourceId: s.ownerId,
          point,
        });
      }
      this.fx.hitSpark(point, { x: -s.dx, y: -s.dy }, 0xffb347);
      return;
    }

    const runtime = this.registry.resolve(body);
    if (runtime && runtime.durability >= 0) {
      this.damageSystem.damageObject(runtime, {
        amount: s.damage,
        kind: 'explosion',
        sourceId: s.ownerId,
        point,
      });
      this.fx.hitSpark(point, { x: -s.dx, y: -s.dy }, 0xffb347);
      return;
    }

    // 不可破坏物体（地面/墙）或未登记刚体：破片被挡下（子弹式，不反弹）
    this.fx.hitSpark(point, { x: -s.dx, y: -s.dy }, 0xffd08a);
  }

  /** 画成一小段子弹式拖影（速度方向为亮头，尾部渐隐） */
  private draw(s: Shrapnel): void {
    const g = s.gfx;
    g.clear();
    g.setPosition(s.x, s.y);
    const tailLen = Math.min(16, 6 + s.speed * 0.008);
    // 外层辉光
    g.lineStyle(3, 0xffb347, 0.35);
    g.lineBetween(0, 0, -s.dx * tailLen, -s.dy * tailLen);
    // 亮核
    g.lineStyle(1.6, 0xffe6a8, 0.95);
    g.lineBetween(0, 0, -s.dx * tailLen * 0.85, -s.dy * tailLen * 0.85);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(0, 0, 1.6);
  }

  private remove(s: Shrapnel): void {
    const idx = this.shards.indexOf(s);
    if (idx >= 0) this.shards.splice(idx, 1);
    s.gfx.destroy();
  }

  destroy(): void {
    for (const s of [...this.shards]) this.remove(s);
    this.shards.length = 0;
  }
}
