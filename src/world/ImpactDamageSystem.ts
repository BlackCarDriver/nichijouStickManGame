import Phaser from 'phaser';
import type { DamageSystem } from '../combat/DamageSystem';
import type { WorldRegistry } from './WorldRegistry';

/**
 * 跌落撞击伤害（物品版）。
 *
 * 玩家摔落伤害在 Player 内部算（有专门的落地检测），这里只管**地图物体**：
 * 被炸飞/被推下高处的箱子、球，落地时按撞击速度掉耐久。
 *
 * 实现：监听 Matter 的 collisionstart —— 该事件在**碰撞求解之前**触发，
 * 因此 body.velocity 仍是撞击瞬间的速度（求解后就归零了，拿不到）。
 * 只处理动态体、且必须在 WorldRegistry 里能查到（玩家/碎片会被自动跳过）。
 */
export class ImpactDamageSystem {
  private readonly scene: Phaser.Scene;
  private readonly damageSystem: DamageSystem;
  private readonly registry: WorldRegistry;

  /** 低于此撞击速度不掉血 */
  private static readonly SAFE_SPEED = 15;
  /** 每超出 1 速度造成的伤害 */
  private static readonly DAMAGE_PER_SPEED = 2.6;
  /** 单次撞击伤害上限（防止极端速度一发打穿一切） */
  private static readonly MAX_DAMAGE = 45;

  constructor(scene: Phaser.Scene, damageSystem: DamageSystem, registry: WorldRegistry) {
    this.scene = scene;
    this.damageSystem = damageSystem;
    this.registry = registry;
    this.scene.matter.world.on('collisionstart', this.handleCollisionStart, this);
  }

  private handleCollisionStart(event: Phaser.Physics.Matter.Events.CollisionStartEvent): void {
    for (const pair of event.pairs) {
      this.handleBody(pair.bodyA as unknown as MatterJS.BodyType);
      this.handleBody(pair.bodyB as unknown as MatterJS.BodyType);
    }
  }

  private handleBody(body: MatterJS.BodyType): void {
    if (!body || body.isStatic || body.isSensor) return;

    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed <= ImpactDamageSystem.SAFE_SPEED) return;

    // 只处理注册表里的地图物体（玩家 / 碎片 resolve 不到，自动跳过）
    const runtime = this.registry.resolve(body);
    if (!runtime || runtime.durability < 0) return;

    const damage = Math.min(
      ImpactDamageSystem.MAX_DAMAGE,
      (speed - ImpactDamageSystem.SAFE_SPEED) * ImpactDamageSystem.DAMAGE_PER_SPEED,
    );
    this.damageSystem.damageObject(runtime, {
      amount: damage,
      kind: 'env',
      point: { x: body.position.x, y: body.position.y },
    });
  }

  destroy(): void {
    this.scene.matter.world.off('collisionstart', this.handleCollisionStart, this);
  }
}
