import Phaser from 'phaser';
import { Entity } from '../core/Entity';
import type { InputCommand } from '../core/InputCommand';
import { StickmanRenderer } from '../render/StickmanRenderer';

export const PLAYER_CONFIG = {
  /** 碰撞体尺寸（火柴人约高 111px，碰撞体略小于视觉） */
  bodyWidth: 36,
  bodyHeight: 96,
  moveSpeed: 5,
  jumpVelocity: -13.5,
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
    if (cmd.jump) {
      this.tryJump();
    }

    // 水平速度直接控制（M2 踢飞机制接入后需改为"仅在地面时受控"）
    // 注意：Matter 为 Verlet 积分，直接改 body.velocity 会被覆盖，必须用 setVelocity（同步 positionPrev）
    this.container.setVelocity(cmd.moveX * PLAYER_CONFIG.moveSpeed, this.body.velocity.y);

    if (cmd.moveX !== 0) {
      this.facing = cmd.moveX > 0 ? 1 : -1;
    }

    const moving = Math.abs(this.body.velocity.x) > 0.5;
    if (moving && this.isGrounded) {
      this.walkPhase += deltaMs * 0.012;
    }

    this.syncFeet();
    this.container.scaleX = this.facing;
    this.draw();
  }

  private tryJump(): void {
    if (!this.isGrounded) return;
    this.container.setVelocity(this.body.velocity.x, PLAYER_CONFIG.jumpVelocity);
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
      walkPhase: this.walkPhase,
      moving: Math.abs(this.body.velocity.x) > 0.5,
      grounded: this.isGrounded,
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
