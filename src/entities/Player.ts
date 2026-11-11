import Phaser from 'phaser';
import { Entity } from '../core/Entity';
import type { InputCommand } from '../core/InputCommand';
import { StickmanRenderer } from '../render/StickmanRenderer';
import type { StickmanPose } from '../render/StickmanRenderer';

export const PLAYER_CONFIG = {
  /** 碰撞体尺寸（火柴人约高 111px，碰撞体略小于视觉） */
  bodyWidth: 36,
  bodyHeight: 96,
  moveSpeed: 5,
  /** 跳跃初速度（负值向上；配合重力 1.6，形成明显抛物线） */
  jumpVelocity: -17,
} as const;

/** 碰撞分类（Matter collisionFilter） */
const CATEGORY = {
  /** 玩家火柴人主体 */
  player: 0x0002,
  /** 脚下传感器（不与玩家主体碰撞，但检测其他物体） */
  feetSensor: 0x0004,
} as const;

/** matter.add.gameObject 返回的容器（运行时带 Matter body 与组件方法） */
interface MatterContainer extends Phaser.GameObjects.Container {
  body: MatterJS.BodyType;
  /** Matter 组件注入：设置速度（同时同步 positionPrev，适配 Verlet 积分） */
  setVelocity(x: number, y?: number): void;
  setVelocityX(x: number): void;
  setVelocityY(y: number): void;
}

/**
 * 火柴人实体。
 * - 消费 InputCommand（输入来源无关，联机时来自网络队列）
 * - Matter 刚体 + 脚下传感器（判断是否着地）
 * - 骨骼渲染（StickmanRenderer）
 */
export class Player extends Entity {
  private readonly scene: Phaser.Scene;
  readonly container: MatterContainer;
  private readonly graphics: Phaser.GameObjects.Graphics;
  readonly body: MatterJS.BodyType;
  private readonly feetRect: Phaser.GameObjects.Rectangle;
  private readonly feetBody: MatterJS.BodyType;
  private groundedContacts = 0;
  private walkPhase = 0;
  private facing: 1 | -1 = 1;
  readonly color: number;

  // ---- 动画状态机（混合驱动：物理状态 → 程序化姿态） ----
  private pose: StickmanPose = 'idle';
  /** 受击剩余时间（>0 时处于受击乱舞状态） */
  private hitTimer = 0;
  /** 受击乱舞相位（快速变化，让四肢乱舞） */
  private hitPhase = 0;
  /** 受击身体倾斜角（由 Container rotation 实现旋转，随时间衰减） */
  private hitTilt = 0;
  private static readonly HIT_DURATION = 600;
  private static readonly HIT_TILT_MAX = 0.5;

  constructor(scene: Phaser.Scene, x: number, y: number, color: number) {
    super();
    this.scene = scene;
    this.color = color;

    this.container = scene.add.container(x, y) as MatterContainer;
    this.graphics = scene.add.graphics();
    this.container.add(this.graphics);

    // 主碰撞体
    const playerBody = scene.matter.add.gameObject(this.container, {
      shape: {
        type: 'rectangle',
        width: PLAYER_CONFIG.bodyWidth,
        height: PLAYER_CONFIG.bodyHeight,
      },
      friction: 0.1,
      frictionStatic: 0.5,
      restitution: 0,
      density: 0.002,
      label: 'player',
      // 锁定旋转：火柴人站立不应翻转（Matter 矩形与地面完美接触时的数值不稳定）
      inertia: Infinity,
      collisionFilter: {
        category: CATEGORY.player,
        mask: 0xffff,
      },
    }) as unknown as MatterContainer;
    this.body = playerBody.body;

    // 脚下传感器：判断着地状态。位于主体正下方外侧，且与玩家主体互不碰撞
    this.feetRect = scene.add.rectangle(0, 0, 28, 10, 0xffffff, 0);
    const feetObj = scene.matter.add.gameObject(this.feetRect, {
      isSensor: true,
      shape: { type: 'rectangle', width: 28, height: 10 },
      label: 'feet-sensor',
      collisionFilter: {
        category: CATEGORY.feetSensor,
        mask: 0xffff ^ CATEGORY.player, // 排除玩家主体
      },
    }) as unknown as MatterContainer;
    this.feetBody = feetObj.body;

    scene.matter.world.on('collisionstart', this.handleCollisionStart, this);
    scene.matter.world.on('collisionend', this.handleCollisionEnd, this);

    this.syncFeet();
    this.draw();
  }

  get isGrounded(): boolean {
    return this.groundedContacts > 0;
  }

  /** 每帧由场景调用：消费输入指令并更新物理与渲染 */
  update(cmd: InputCommand, deltaMs: number): void {
    // 水平速度：每帧直接控制（坦克式操控，松开键自然停）
    // 注意：Matter 为 Verlet 积分，必须用 setVelocityX（同步 positionPrev）
    const vx = cmd.moveX !== 0 ? cmd.moveX * PLAYER_CONFIG.moveSpeed : this.body.velocity.x * 0.85;
    this.container.setVelocityX(vx);

    // 垂直速度：完全交给物理（重力），仅在跳跃瞬间设置，避免每帧干扰抛物线
    if (cmd.jump) {
      this.tryJump();
    }

    if (cmd.moveX !== 0) {
      this.facing = cmd.moveX > 0 ? 1 : -1;
    }

    this.updatePose(deltaMs);
    this.syncFeet();
    this.container.scaleX = this.facing;
    this.draw();
  }

  /**
   * 受击：进入短暂物理乱飞状态（主体位移由 Matter 冲量驱动，姿态为四肢乱舞）。
   * 由踢飞（M2）/ 武器伤害（M3）调用。
   */
  hit(knockbackX: number, knockbackY: number, durationMs = Player.HIT_DURATION): void {
    this.hitTimer = durationMs;
    this.hitPhase = 0;
    this.hitTilt = (Math.random() < 0.5 ? -1 : 1) * Player.HIT_TILT_MAX;
    this.container.setVelocityX(knockbackX);
    this.container.setVelocityY(knockbackY);
  }

  /** 动画状态机：物理状态（着地/速度/受击）→ 姿势 */
  private updatePose(deltaMs: number): void {
    if (this.hitTimer > 0) {
      this.hitTimer -= deltaMs;
      this.hitPhase += deltaMs * 0.025;
      // 倾斜随剩余时间衰减，快速回正
      this.hitTilt *= Math.max(0, 1 - deltaMs / 150);
      this.pose = 'hit';
      this.container.rotation = this.hitTilt;
      return;
    }

    // 受击结束：回正姿态
    this.container.rotation = 0;
    const moving = Math.abs(this.body.velocity.x) > 0.5;
    if (!this.isGrounded) {
      this.pose = this.body.velocity.y < 0 ? 'jump' : 'fall';
    } else if (moving) {
      this.walkPhase += deltaMs * 0.015;
      this.pose = 'walk';
    } else {
      this.pose = 'idle';
    }
  }

  private tryJump(): void {
    if (!this.isGrounded) return;
    // 只设置垂直速度，保留当前水平速度
    this.container.setVelocityY(PLAYER_CONFIG.jumpVelocity);
  }

  private syncFeet(): void {
    // 传感器中心 = 主体中心 + 主体半高 + 传感器半高（位于主体正下方外侧）
    this.feetRect.setPosition(
      this.container.x,
      this.container.y + PLAYER_CONFIG.bodyHeight / 2 + 5,
    );
  }

  private draw(): void {
    StickmanRenderer.draw(this.graphics, {
      color: this.color,
      phase: this.walkPhase,
      pose: this.pose,
      moving: Math.abs(this.body.velocity.x) > 0.5,
      grounded: this.isGrounded,
      hitIntensity: this.hitTimer > 0 ? Math.min(1, this.hitTimer / Player.HIT_DURATION) : 0,
      hitPhase: this.hitPhase,
    });
  }

  private handleCollisionStart(event: Phaser.Physics.Matter.Events.CollisionStartEvent): void {
    for (const pair of event.pairs) {
      if (pair.bodyA === this.feetBody || pair.bodyB === this.feetBody) {
        this.groundedContacts++;
        break;
      }
    }
  }

  private handleCollisionEnd(event: Phaser.Physics.Matter.Events.CollisionEndEvent): void {
    for (const pair of event.pairs) {
      if (pair.bodyA === this.feetBody || pair.bodyB === this.feetBody) {
        this.groundedContacts--;
        break;
      }
    }
  }

  /** 联机预留：状态快照 */
  override serialize(): Record<string, unknown> {
    return {
      id: this.id,
      x: this.container.x,
      y: this.container.y,
      vx: this.body.velocity.x,
      vy: this.body.velocity.y,
    };
  }

  override destroy(): void {
    super.destroy();
    this.scene.matter.world.off('collisionstart', this.handleCollisionStart, this);
    this.scene.matter.world.off('collisionend', this.handleCollisionEnd, this);
    this.feetRect.destroy();
    this.container.destroy();
  }
}
