import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import type { DamageSystem } from '../combat/DamageSystem';
import type { WorldRegistry } from './WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';

/** 单块破片 */
interface Shrapnel {
  body: MatterJS.BodyType;
  gfx: Phaser.GameObjects.Graphics;
  /** 出生点（用于计算飞行距离） */
  ox: number;
  oy: number;
  remain: number;
  damage: number;
  ownerId: number;
  /** 最大飞行距离（超过即消失） */
  range: number;
}

/**
 * 爆炸破片系统（手榴弹 / 火箭炮）。
 *
 * 需求：爆炸时向四周弹射 20 个碎片，碎片击中敌人或物体产生伤害，飞出一定距离后消失。
 *
 * 实现要点：
 * - 破片是**真实刚体**（会受重力、会被地形挡住），因此撞到墙/地面会提前终结
 * - 命中判定走 Matter 的 collisionstart：玩家 → bodyToPlayer，物体 → WorldRegistry
 * - 命中即结算 DamageInfo 并销毁破片（避免一片连续割多刀）
 * - 三重终止条件：命中 / 飞出 range / 寿命到期，且有总量上限防连锁爆炸打崩帧率
 */
export class ShrapnelSystem {
  private readonly scene: Phaser.Scene;
  private readonly damageSystem: DamageSystem;
  private readonly registry: WorldRegistry;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;
  private readonly items: Shrapnel[] = [];
  /** body.id → 破片，用于碰撞反查 */
  private readonly byBodyId = new Map<number, Shrapnel>();

  /** 同时存在的破片上限（连锁爆炸保护） */
  private static readonly MAX = 140;
  /** 破片寿命（ms） */
  private static readonly LIFE_MS = 2200;

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
    scene.matter.world.on('collisionstart', this.handleCollisionStart, this);
  }

  /**
   * 在爆炸点向四周弹射破片。
   * @param count  破片数量
   * @param damage 单块命中伤害
   * @param speed  初速（px/秒）
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
      if (this.items.length >= ShrapnelSystem.MAX) this.removeOldest();

      // 均匀铺开 + 随机抖动（避免形成规则的花瓣状）
      const base = (Math.PI * 2 * i) / n;
      const angle = base + (Math.random() - 0.5) * ((Math.PI * 2) / n) * 0.8;
      const v = speed * (0.75 + Math.random() * 0.5);
      const size = 3 + Math.random() * 2.5;

      const body = this.scene.matter.add.circle(x + Math.cos(angle) * 6, y + Math.sin(angle) * 6, size, {
        label: 'shrapnel',
        friction: 0.2,
        frictionStatic: 0.3,
        restitution: 0.25,
        density: 0.002,
        // 不参与玩家/物体的物理推挤：只做"伤害探针"，避免把角色顶飞
        collisionFilter: { category: 0x0100, mask: 0xffff },
      });
      // Matter 速度单位是 px/物理步（60fps）→ 由 px/秒 换算
      body.velocity.x = (Math.cos(angle) * v) / 60;
      body.velocity.y = (Math.sin(angle) * v) / 60;

      const gfx = this.scene.add.graphics();
      gfx.setDepth(830);

      const item: Shrapnel = {
        body,
        gfx,
        ox: x,
        oy: y,
        remain: ShrapnelSystem.LIFE_MS,
        damage,
        ownerId,
        range,
      };
      this.items.push(item);
      this.byBodyId.set(body.id, item);
      this.draw(item);
    }
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const s = this.items[i];
      s.remain -= deltaMs;

      // 超出最大飞行距离 / 寿命 → 消失（需求：超过一定距离后消失）
      const dist = Math.hypot(s.body.position.x - s.ox, s.body.position.y - s.oy);
      if (s.remain <= 0 || dist > s.range) {
        this.remove(s);
        continue;
      }

      // 拖尾淡出（末段闪烁提示即将消失）
      const lifeRatio = s.remain / ShrapnelSystem.LIFE_MS;
      s.gfx.setAlpha(lifeRatio < 0.25 ? 0.45 + 0.55 * Math.abs(Math.sin(s.remain / 60)) : 1);
      s.gfx.setPosition(s.body.position.x, s.body.position.y);
      // 速度方向拉出一条短拖影
      const vx = s.body.velocity.x;
      const vy = s.body.velocity.y;
      const len = Math.hypot(vx, vy) || 1;
      s.gfx.clear();
      s.gfx.fillStyle(0xffe6a8, 0.95);
      s.gfx.fillCircle(0, 0, 2.2);
      s.gfx.lineStyle(1.6, 0xffb347, 0.55);
      s.gfx.lineBetween(0, 0, (-vx / len) * Math.min(14, 4 + len * 1.6), (-vy / len) * Math.min(14, 4 + len * 1.6));
      void dt;
    }
  }

  /** 绘制静止的一帧（刚创建时） */
  private draw(s: Shrapnel): void {
    s.gfx.clear();
    s.gfx.setPosition(s.body.position.x, s.body.position.y);
    s.gfx.fillStyle(0xffe6a8, 0.95);
    s.gfx.fillCircle(0, 0, 2.2);
  }

  private handleCollisionStart(event: Phaser.Physics.Matter.Events.CollisionStartEvent): void {
    for (const pair of event.pairs) {
      const a = this.byBodyId.get(pair.bodyA.id);
      const b = this.byBodyId.get(pair.bodyB.id);
      const s = a ?? b;
      if (!s) continue;
      const other = a ? pair.bodyB : pair.bodyA;
      if (other.label === 'shrapnel') continue;

      const point = { x: s.body.position.x, y: s.body.position.y };
      // 玩家
      const player = this.bodyToPlayer.get(other.id) ?? this.bodyToPlayer.get(other.parent?.id ?? -1);
      if (player) {
        if (!player.health.isDead) {
          this.damageSystem.damagePlayer(player, {
            amount: s.damage,
            kind: 'explosion',
            sourceId: s.ownerId,
            point,
          });
          this.fx.hitSpark(point, { x: 0, y: -1 }, 0xffb347);
        }
        this.remove(s);
        continue;
      }

      // 地图物体（复合体命中会是 part → registry 内部已处理 parent）
      const runtime = this.registry.resolve(other);
      if (runtime) {
        // 可破坏物体：受伤 + 破片终结
        if (runtime.durability >= 0) {
          this.damageSystem.damageObject(runtime, {
            amount: s.damage,
            kind: 'explosion',
            sourceId: s.ownerId,
            point,
          });
          this.fx.hitSpark(point, { x: 0, y: -1 }, 0xffb347);
          this.remove(s);
          continue;
        }
        // 不可破坏（地面/墙/金属护墙等）：让破片**反弹**继续飞，
        // 否则贴地爆炸时碎片当帧全灭，看不到四射效果
        this.fx.hitSpark(point, { x: 0, y: -1 }, 0xffd08a);
        continue;
      }

      // 其它未登记刚体：不终结，靠 range / 寿命回收
      continue;
    }
  }

  private remove(s: Shrapnel): void {
    const idx = this.items.indexOf(s);
    if (idx >= 0) this.items.splice(idx, 1);
    this.byBodyId.delete(s.body.id);
    this.scene.matter.world.remove(s.body);
    s.gfx.destroy();
  }

  private removeOldest(): void {
    const oldest = this.items[0];
    if (oldest) this.remove(oldest);
  }

  destroy(): void {
    this.scene.matter.world.off('collisionstart', this.handleCollisionStart, this);
    for (const s of [...this.items]) this.remove(s);
    this.items.length = 0;
    this.byBodyId.clear();
  }
}
