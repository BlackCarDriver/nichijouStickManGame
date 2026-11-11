import Phaser from 'phaser';
import { Entity } from '../core/Entity';
import type { InputCommand } from '../core/InputCommand';
import { StickmanRenderer } from '../render/StickmanRenderer';
import type { StickmanPose } from '../render/StickmanRenderer';
import { GameFeel } from '../feel/GameFeel';
import { COLLISION_CATEGORY, PLAYER_MASK_ALL } from '../core/CollisionCategories';
import { emptyInput } from '../core/InputCommand';
import { Health } from './Health';
import type { DamageInfo } from '../combat/DamageInfo';

export const PLAYER_CONFIG = {
  /** 碰撞体尺寸（火柴人总高约 111px，碰撞体略小于视觉） */
  /** 碰撞体宽度（站立） */
  bodyWidth: 36,
  /**
   * 蹲下时碰撞体横向缩放（36 → 90px，半宽 45）。
   * 蹲下姿态「矮而宽」：躯干前倾 45° 使头右缘到 x≈47.6，
   * 站立宽 36（半宽 18）包不住 → 推箱子时身体穿进去。
   * 只加宽不改高，因此不影响 feetY / 射线探测 / 单向平台判定。
   */
  crouchBodyScaleX: 2.5,
  bodyHeight: 96,
  moveSpeed: 5,
  /** 跳跃初速度（负值向上） */
  jumpVelocity: -17,
  /** 最大下落速度：防穿透 */
  maxFallSpeed: 26,
  /** 最大水平速度（含被击飞冲量）：防穿透 */
  maxHorizontalSpeed: 18,

  // ---- 跳跃手感（platformer + input-systems 技能）----
  /** 土狼时间（秒）：离开平台边缘后仍可跳的宽限窗口 */
  coyoteTime: 0.1,
  /** 跳跃缓冲（秒）：落地前提前按跳被记住的窗口 */
  jumpBuffer: 0.12,
  /** 可变跳跃：松开跳键时上升速度的保留比例 */
  jumpCutMultiplier: 0.45,
  /** 非对称重力：下落时的重力倍数 */
  fallGravityMultiplier: 1.8,
  /** 起跳后的土狼锁定（秒）：防止同一着地段内重复起跳（伪二段跳） */
  jumpLockout: 0.15,
  /** 脚下射线探测深度（像素）。斜面需要更大的探测深度 */
  groundProbeDepth: 10,

  // ---- 生命值 ----
  /** 最大生命值 */
  maxHp: 100,
  /** 死亡后复活延迟（ms）：沙盒模式下无限重生 */
  respawnDelayMs: 1200,
  /** 复活后的无敌时长（ms） */
  spawnInvulnMs: 900,
} as const;

/** matter.add.gameObject 返回的容器（运行时带 Matter body 与组件方法） */
interface MatterContainer extends Phaser.GameObjects.Container {
  body: MatterJS.BodyType;
  setVelocity(x: number, y?: number): void;
  setVelocityX(x: number): void;
  setVelocityY(y: number): void;
}

/** Phaser 的 MatterJS 类型定义不完整，这里声明运行时实际可用的字段 */
interface PhysicsWorldLike {
  bodies: MatterJS.BodyType[];
}

/**
 * 火柴人实体。
 * - 消费 InputCommand（输入来源无关，联机时来自网络队列）
 * - Matter 刚体（主体） + 射线脚下检测（比 sensor body 可靠）
 * - 骨骼渲染（StickmanRenderer）
 */
export class Player extends Entity {
  private readonly scene: Phaser.Scene;
  /** 物理容器（位置与 Matter body 同步） */
  readonly container: MatterContainer;
  /** 内层视觉容器：面向翻转（与物理/挤压分离） */
  private readonly visual: Phaser.GameObjects.Container;
  private readonly graphics: Phaser.GameObjects.Graphics;
  readonly body: MatterJS.BodyType;
  readonly color: number;

  /** 面向（1=右 -1=左）；镜头 look-ahead 使用 */
  facing: 1 | -1 = 1;

  // ---- 生命值 ----
  readonly health = new Health({ maxHp: PLAYER_CONFIG.maxHp });
  /** 死亡后剩余复活倒计时（ms） */
  private respawnTimer = 0;
  /** 出生点（复活用） */
  private readonly spawnX: number;
  private readonly spawnY: number;

  // ---- 瞄准（武器系统用）----
  /** 瞄准角度（弧度，世界方向）。由场景按"谁持有鼠标"每帧设置 */
  private aimAngle = 0;
  /** 是否装备调试枪（W1 验证伤害管线用，W2 由 WeaponSystem 接管） */
  equippedGun = false;

  private static readonly HIT_INVULN_MS = 180;
  /** 肩部到枪口的距离（手臂 + 枪身） */
  private static readonly MUZZLE_REACH = 54;

  // ---- 着地状态 ----
  /** 脚下射线检测结果 */
  private rayGrounded = false;
  /** 是否站在单向平台上（由场景每帧设置） */
  private standingOnOneWay = false;
  /** 地面法线（由碰撞事件更新）：用于斜面时左右脚的高度差 */
  private readonly groundNormal = { x: 0, y: -1 };
  /** 蹲下中（本帧输入） */
  private crouching = false;
  /** 当前碰撞体宽度（跟随蹲下缩放，避免累积缩放算错） */
  private currentBodyWidth: number = PLAYER_CONFIG.bodyWidth;
  /** 持续离地时长（ms）：用于判断是否真的离开地面（避免斜坡滑动时抖动重置法线） */
  private airborneTime = 0;

  // ---- 跳跃手感计时器 ----
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private jumpCutArmed = false;
  private jumpLockout = 0;

  // ---- 动画状态机 ----
  private pose: StickmanPose = 'idle';
  /** 步态时间（秒）：行走时按速度累加，驱动确定性步态 */
  private gaitTime = 0;
  private hitTimer = 0;
  private hitPhase = 0;
  private hitTilt = 0;
  private static readonly HIT_DURATION = 600;
  private static readonly HIT_TILT_MAX = 0.5;

  // ---- 动作细节（spine-animation 技能：冲击吸收/预备/跟随）----
  /** 落地冲击剩余毫秒（>0 时处于落地压缩→恢复阶段） */
  private landImpact = 0;
  /** 落地冲击强度 0~1（按下落速度决定，驱动下蹲深度） */
  private landImpactStrength = 0;
  /** 起跳预备剩余毫秒（纯视觉前摇，不延迟物理跳跃） */
  private jumpAnticipation = 0;
  private static readonly LAND_IMPACT_DURATION = 220;
  private static readonly JUMP_ANTICIPATION_DURATION = 100;

  constructor(scene: Phaser.Scene, x: number, y: number, color: number) {
    super();
    this.scene = scene;
    this.color = color;
    this.spawnX = x;
    this.spawnY = y;

    this.container = scene.add.container(x, y) as MatterContainer;
    this.visual = scene.add.container(0, 0);
    this.graphics = scene.add.graphics();
    this.visual.add(this.graphics);
    this.container.add(this.visual);

    // 主碰撞体
    const playerBody = scene.matter.add.gameObject(this.container, {
      shape: {
        type: 'rectangle',
        width: PLAYER_CONFIG.bodyWidth,
        height: PLAYER_CONFIG.bodyHeight,
      },
      // 摩擦：取 pair.friction = min(玩家, 物体)。
      // 墙体材质 friction=0 → 贴墙时摩擦为 0，下落不会被减速（修复贴墙下落变慢）。
      // 保持小量摩擦：让玩家能稳稳站在斜面/地面上。
      friction: 0.1,
      frictionStatic: 0.5,
      restitution: 0,
      density: 0.002,
      label: 'player',
      // 锁定旋转：火柴人站立不应翻转
      inertia: Infinity,
      collisionFilter: {
        category: COLLISION_CATEGORY.player,
        mask: PLAYER_MASK_ALL,
      },
    }) as unknown as MatterContainer;
    this.body = playerBody.body;

    // 监听碰撞，缓存地面法线（用于斜面脚底贴合）
    scene.matter.world.on('collisionactive', this.handleCollisionActive, this);

    this.draw();
  }

  get isGrounded(): boolean {
    return this.rayGrounded || this.standingOnOneWay;
  }

  /** 玩家脚底 y（世界）：直接取碰撞盒实际底部，自动适应趴下时的压缩体 */
  get feetY(): number {
    return this.container.y + PLAYER_CONFIG.bodyHeight / 2;
  }

  /**
   * 切换蹲下碰撞体宽度：蹲下时横向拉宽，包住前倾的躯干/头/手臂，
   * 避免推箱子时身体穿进去。
   */
  private setCrouchBody(active: boolean): void {
    // matter.body.scale 是**累积**缩放，用自维护的当前宽度反算比例（不读 bounds，避免滞后值算错）。
    //
    // 重要：**斜面上不加宽**。90px 宽的扁盒子放在陡坡上，一侧会深插进斜面，
    // Matter 求解器反复推挤 → 物理位置抖动（实测 X 抖 10px / Y 抖 7px）→ 屏闪。
    // 斜面本来也没有箱子可推，窄体即可。
    const onSlope = Math.abs(this.groundNormal.x) > 0.25;
    // 前方有上升地形（斜坡/台阶）时不加宽：宽盒子的前下角会顶住斜面起点，导致爬不上去
    const uphillAhead = active && this.hasUphillAhead();
    const wantWide = active && !onSlope && !uphillAhead;
    const base = PLAYER_CONFIG.bodyWidth;
    const targetW = wantWide ? base * PLAYER_CONFIG.crouchBodyScaleX : base;
    if (Math.abs(this.currentBodyWidth - targetW) < 0.25) return;
    this.scene.matter.body.scale(this.body, targetW / this.currentBodyWidth, 1);
    this.currentBodyWidth = targetW;
  }

  /**
   * 前方是否有「上升地形」（斜坡/台阶）。
   * 做法：在面向前方 32px 处，从脚底上方 20px 到上方 3px 打一条短射线；
   * 命中非自身实体即说明前方地面高于脚下 —— 加宽碰撞体会被此地形顶住。
   */
  private hasUphillAhead(): boolean {
    const bodies = (this.scene.matter.world.localWorld as unknown as PhysicsWorldLike).bodies;
    const px = this.container.x + this.facing * 32;
    const feetY = this.feetY;
    const results = this.scene.matter.query.ray(
      bodies,
      { x: px, y: feetY - 20 },
      { x: px, y: feetY - 3 },
    );
    for (const r of results) {
      const a = r.bodyA as unknown as MatterJS.BodyType;
      const b = r.bodyB as unknown as MatterJS.BodyType;
      const target = a === this.body && b === this.body ? null : a === this.body ? b : a;
      if (target && target !== this.body && !target.isSensor) return true;
    }
    return false;
  }

  /**
   * 单向平台状态（由场景每帧调用）：
   * @param ignore 是否忽略单向平台碰撞（在平台下方或上升中 → 可穿过）
   * @param standing 是否站在单向平台上（脚底贴平台顶部 → 可站立/可跳）
   */
  setOneWayState(ignore: boolean, standing: boolean): void {
    this.standingOnOneWay = standing;
    this.body.collisionFilter.mask = ignore
      ? PLAYER_MASK_ALL & ~COLLISION_CATEGORY.oneWayPlatform
      : PLAYER_MASK_ALL;
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
    this.scene.events.emit('player-hit', this);
  }

  // ==========================================================
  //  伤害 / 生命值
  // ==========================================================

  /**
   * 受到伤害（由 DamageSystem 调用）。返回实际生效的伤害量。
   * 无敌帧拦截、击杀判定、受击姿态都在这里统一处理。
   */
  applyDamage(info: DamageInfo): number {
    if (this.health.isDead) return 0;
    const applied = this.health.applyDamage(info.amount);
    if (applied <= 0) return 0;

    // 击退 + 受击姿态（hit() 内部会广播 player-hit → 屏幕震动）
    const kb = info.knockback ?? { x: 0, y: 0 };
    this.hit(kb.x, kb.y, 380);
    // 短无敌：避免连发武器在同一瞬间把玩家打穿（AK 高频子弹）
    this.health.setInvulnerable(Player.HIT_INVULN_MS);

    if (this.health.isDead) this.die();
    return applied;
  }

  /** 治疗（医疗包用） */
  heal(amount: number): number {
    return this.health.heal(amount);
  }

  private die(): void {
    this.respawnTimer = PLAYER_CONFIG.respawnDelayMs;
    this.scene.events.emit('player-died', this);
  }

  /** 复活：回到出生点、满血、短无敌 */
  private respawn(): void {
    this.respawnTimer = 0;
    this.health.reset();
    this.health.setInvulnerable(PLAYER_CONFIG.spawnInvulnMs);
    this.container.setPosition(this.spawnX, this.spawnY);
    this.container.setVelocity(0, 0);
    this.container.setRotation(0);
    this.hitTimer = 0;
    this.hitTilt = 0;
    this.visual.setAlpha(1);
    this.scene.events.emit('player-respawn', this);
  }

  // ==========================================================
  //  瞄准 / 枪口
  // ==========================================================

  /** 设置瞄准角度（弧度，世界方向） */
  /** 当前瞄准角度（弧度） */
  get aim(): number {
    return this.aimAngle;
  }

  /** 肩部位置（世界坐标）：瞄准角计算与枪口起点基准 */
  get shoulderWorld(): { x: number; y: number } {
    return {
      x: this.container.x,
      y: this.container.y + this.visual.y + StickmanRenderer.SHOULDER_Y,
    };
  }

  /** 枪口位置（世界坐标）：子弹必须从这里出，否则会从墙里穿出来 */
  get muzzle(): { x: number; y: number } {
    const s = this.shoulderWorld;
    const reach = Player.MUZZLE_REACH;
    return {
      x: s.x + Math.cos(this.aimAngle) * reach,
      y: s.y + Math.sin(this.aimAngle) * reach,
    };
  }

  /** 每帧由场景调用：消费输入指令并更新物理与渲染 */
  update(cmd: InputCommand, deltaMs: number): void {
    const dt = deltaMs / 1000;

    // ---- 生命值 / 死亡 → 复活 ----
    this.health.update(deltaMs);
    if (this.health.isDead) {
      this.respawnTimer -= deltaMs;
      if (this.respawnTimer <= 0) {
        this.respawn();
      } else {
        // 死亡期间不接受操作（物理与渲染照常：尸体继续被打飞）
        cmd = emptyInput();
      }
    }

    // 持续离地超过 150ms 才把地面法线重置为平地（短暂滑动/抖动不重置，避免闪烁）
    if (this.isGrounded) {
      this.airborneTime = 0;
    } else {
      this.airborneTime += deltaMs;
      if (this.airborneTime > 150) {
        this.groundNormal.x = 0;
        this.groundNormal.y = -1;
      }
    }

    // 先记录「上一帧」着地状态（必须在射线刷新前），用于检测「刚落地」瞬间
    const wasGrounded = this.isGrounded;

    // 射线着地检测（先于跳跃判定，保证当帧状态最新）
    this.updateRayGrounded();

    // ===== 跳跃手感计时器 =====
    this.jumpLockout = Math.max(0, this.jumpLockout - dt);
    // 土狼时间：着地刷新；锁定期间不刷新（否则起跳当帧着地会刷满 → 可重复起跳）
    if (this.isGrounded && this.jumpLockout <= 0) {
      this.coyoteTimer = PLAYER_CONFIG.coyoteTime;
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
    }
    // 跳跃缓冲
    if (cmd.jump) {
      this.jumpBufferTimer = PLAYER_CONFIG.jumpBuffer;
    } else {
      this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    }

    // ===== 水平速度：每帧直接控制（Matter 为 Verlet 积分，必须用 setVelocityX）=====
    // 蹲下：**只看按键**（不依赖 isGrounded）。
    // 若依赖着地状态，斜坡上滑动导致 grounded 抖动 → 碰撞体宽度每帧 36↔72 反复切换 → 屏闪。
    this.crouching = cmd.crouch;
    this.setCrouchBody(this.crouching);
    const speedMul = this.crouching ? 0.45 : 1;
    // 着地且无输入 → 精确归零（避免在斜面上因碰撞法线推力而缓慢滑落）
    const targetVx =
      cmd.moveX !== 0
        ? cmd.moveX * PLAYER_CONFIG.moveSpeed * speedMul
        : this.isGrounded
          ? 0
          : this.body.velocity.x * 0.85;
    const cappedVx = Phaser.Math.Clamp(targetVx, -PLAYER_CONFIG.maxHorizontalSpeed, PLAYER_CONFIG.maxHorizontalSpeed);
    this.container.setVelocityX(cappedVx);

    // ===== 跳跃求解：缓冲 + 土狼时间同时满足才跳（一起消耗，防二段跳）=====
    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0) {
      this.container.setVelocityY(PLAYER_CONFIG.jumpVelocity);
      this.jumpBufferTimer = 0;
      this.coyoteTimer = 0;
      this.jumpLockout = PLAYER_CONFIG.jumpLockout;
      this.jumpCutArmed = true;
      this.jumpAnticipation = Player.JUMP_ANTICIPATION_DURATION; // 起跳前摇（下一帧起显示压缩姿态）
      GameFeel.pop(this.graphics, 0.85, 1.15, 200);
    }

    // ===== 可变跳跃高度：上升中松开跳键，切短跳跃（只切一次）=====
    if (this.jumpCutArmed && !cmd.jumpHeld && this.body.velocity.y < 0) {
      this.container.setVelocityY(this.body.velocity.y * PLAYER_CONFIG.jumpCutMultiplier);
      this.jumpCutArmed = false;
    }
    if (this.isGrounded && this.body.velocity.y >= 0) {
      this.jumpCutArmed = false;
    }

    // ===== 垂直方向：最小干预（每帧强行改 vy 会破坏 Matter 碰撞平衡）=====
    if (this.body.velocity.y > PLAYER_CONFIG.maxFallSpeed) {
      this.container.setVelocityY(PLAYER_CONFIG.maxFallSpeed);
    }
    // 非对称重力：下落时用 force 施加额外重力（交给引擎积分）
    if (this.body.velocity.y > 0) {
      const extraGravityRatio = 1.6 * 0.001 * (PLAYER_CONFIG.fallGravityMultiplier - 1);
      this.body.force.y += this.body.mass * extraGravityRatio;
    }

    // ===== 反弹抑制：着地后向上速度归零（避免在铁球/弹性物体上反复弹跳）=====
    // 注意：起跳后的短暂锁定期（jumpLockout）内保留向上速度，否则会吃掉跳跃
    if (this.isGrounded && this.body.velocity.y < 0 && this.jumpLockout <= 0) {
      this.container.setVelocityY(0);
    }

    if (cmd.moveX !== 0) {
      this.facing = cmd.moveX > 0 ? 1 : -1;
    }

    // 瞄准：明确角度优先（鼠标玩家）；null → 跟随身体朝向（无鼠标玩家）
    this.aimAngle = cmd.aimAngle ?? (this.facing > 0 ? 0 : Math.PI);

    this.updatePose(deltaMs, wasGrounded);
    this.visual.scaleX = this.facing;
    this.draw();
  }

  /** 缓存地面法线：斜面时用它算左右脚高度差，让脚底贴合斜面 */
  private handleCollisionActive(event: Phaser.Physics.Matter.Events.CollisionActiveEvent): void {
    for (const pair of event.pairs) {
      if (pair.bodyA !== this.body && pair.bodyB !== this.body) continue;
      const normal = pair.collision && pair.collision.normal;
      if (!normal) continue;
      let nx = normal.x;
      let ny = normal.y;
      // 统一为“朝上”的法线（屏幕坐标 y 向下，所以朝上的法线 ny < 0）
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      // 只采纳“地面型”接触（法线以垂直为主），忽略墙面
      if (Math.abs(ny) > Math.abs(nx) * 1.2) {
        this.groundNormal.x = nx;
        this.groundNormal.y = ny;
      }
    }
  }

  /**
   * 当前地面坡度导致的脚底高度偏移（相对主体底部）。
   * 矩形盒平放在斜面上只有**一个角接触**，所以表面是一条斜线：
   *   y(dx) = bodyBottom + nx * (cornerX - dx) / ny
   * 其中 cornerX = -sign(nx)*半宽（最低角）。
   */
  private surfaceOffsetAt(localDx: number): number {
    // 注意：这里**不**判断 isGrounded。斜坡上滑动会让 grounded 短暂为 false，
    // 若因此返回 0，目标值会在 0↔12px 间跳变 → 视觉闪烁。
    // 改由「持续离地超过阈值才重置法线」来收敛（见 update）。
    const nx = this.groundNormal.x;
    const ny = this.groundNormal.y;
    if (ny > -0.05) return 0;
    // 固定用站立宽度作参考：若跟随蹲下加宽会形成"加宽→目标位移跳变→视觉抖动"的反馈回路
    const halfW = PLAYER_CONFIG.bodyWidth / 2;
    const cornerX = nx === 0 ? 0 : -Math.sign(nx) * halfW;
    return (nx * (cornerX - localDx)) / ny;
  }

  /** 平滑后的表面偏移（中心 / 左脚 / 右脚）：避免斜坡上法线抖动导致视觉闪烁 */
  private smSurfCenter = 0;
  private smSurfLeft = 0;
  private smSurfRight = 0;

  /** 脚下射线检测（5 条：更宽范围，适应斜坡与边缘） */
  private updateRayGrounded(): void {
    // 起点必须在主体底部外侧（否则射线会击中自己）
    const startY = this.feetY + 1;
    const endY = this.feetY + PLAYER_CONFIG.groundProbeDepth;
    const bodies = (this.scene.matter.world.localWorld as unknown as PhysicsWorldLike).bodies;
    let hit = false;
    for (const dx of [-14, -7, 0, 7, 14]) {
      const results = this.scene.matter.query.ray(
        bodies,
        { x: this.container.x + dx, y: startY },
        { x: this.container.x + dx, y: endY },
      );
      for (const r of results) {
        // Query.ray 返回「被射线击中的 body」（bodyA = 被检测体，bodyB = 其 part）
        const a = r.bodyA as unknown as MatterJS.BodyType;
        const b = r.bodyB as unknown as MatterJS.BodyType;
        const target = a === this.body && b === this.body ? null : a === this.body ? b : a;
        if (target && target !== this.body && !target.isSensor) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    this.rayGrounded = hit;
  }

  /** 动画状态机：物理状态（着地/速度/受击）→ 姿势 */
  private updatePose(deltaMs: number, wasGrounded: boolean): void {
    // 动作细节计时器递减（spine-animation：冲击吸收/预备都需要“衰减恢复”）
    this.landImpact = Math.max(0, this.landImpact - deltaMs);
    this.jumpAnticipation = Math.max(0, this.jumpAnticipation - deltaMs);

    if (this.hitTimer > 0) {
      this.hitTimer -= deltaMs;
      this.hitPhase += deltaMs * 0.025;
      this.hitTilt *= Math.max(0, 1 - deltaMs / 150);
      this.pose = 'hit';
      this.container.rotation = this.hitTilt;
      return;
    }

    this.container.rotation = 0;
    const speed = Math.abs(this.body.velocity.x);
    const moving = speed > 0.5;

    if (!this.isGrounded) {
      this.pose = this.body.velocity.y < 0 ? 'jump' : 'fall';
    } else if (this.crouching) {
      // 蹲下：保留步态时间推进（便于呼吸/微动）
      this.gaitTime += deltaMs / 1000;
      this.pose = 'crouch';
    } else if (moving) {
      // 步态时间按速度推进（秒）；速度已由渲染器用于步态幅度
      this.gaitTime += deltaMs / 1000;
      this.pose = 'walk';
    } else {
      this.pose = 'idle';
      // 站立时缓慢推进（呼吸动画）
      this.gaitTime += deltaMs / 1000;
    }

    // 落地冲击（spine-animation：冲击吸收 → 稳定恢复，而非弹一下就完）
    if (!wasGrounded && this.isGrounded) {
      const fallSpeed = this.body.velocity.y;
      // 下落速度 → 冲击强度（力的大小决定吸收深度）
      this.landImpactStrength = Phaser.Math.Clamp(fallSpeed / 18, 0.15, 1);
      this.landImpact = Player.LAND_IMPACT_DURATION;
      const intensity = Phaser.Math.Clamp(fallSpeed / 15, 0.15, 0.45);
      GameFeel.pop(this.graphics, 1 + intensity, 1 - intensity, 160);
    }
  }

  private draw(): void {
    // 平滑逼近目标：斜坡上 grounded 可能抖动（目标在 0↔24px 间跳），
    // 直接赋值会导致视觉剧烈跳动（屏闪），所以做指数平滑。
    // 三处表面偏移统一做**慢速**指数平滑（约 0.5s 收敛）。
    // 斜坡上 groundNormal 可能在"斜坡/平地"间抖动，慢平滑可让任何跳变都不可见。
    const K = 0.08;
    this.smSurfCenter += (this.surfaceOffsetAt(0) - this.smSurfCenter) * K;
    this.smSurfLeft += (this.surfaceOffsetAt(-10) - this.smSurfLeft) * K;
    this.smSurfRight += (this.surfaceOffsetAt(10) - this.smSurfRight) * K;

    StickmanRenderer.draw(this.graphics, {
      color: this.color,
      gaitTime: this.gaitTime,
      pose: this.pose,
      moving: Math.abs(this.body.velocity.x) > 0.5,
      grounded: this.isGrounded,
      hitIntensity: this.hitTimer > 0 ? Math.min(1, this.hitTimer / Player.HIT_DURATION) : 0,
      hitPhase: this.hitPhase,
      velocityX: this.body.velocity.x,
      velocityY: this.body.velocity.y,
      landImpact: this.landImpact > 0 ? this.landImpact / Player.LAND_IMPACT_DURATION : 0,
      landImpactStrength: this.landImpactStrength,
      jumpAnticipation: this.jumpAnticipation > 0 ? this.jumpAnticipation / Player.JUMP_ANTICIPATION_DURATION : 0,
      // 斜面：整体视觉下移 + 双脚相对偏移（全部使用平滑值，脚仍贴合斜面）
      groundYL: this.smSurfLeft - this.smSurfCenter,
      groundYR: this.smSurfRight - this.smSurfCenter,
      crouching: this.crouching,
    });

    // 斜面时整体下移视觉（平滑值，避免抖动闪烁）
    this.visual.y = this.smSurfCenter;

    // 死亡表现：半透明
    this.visual.setAlpha(this.health.isDead ? 0.3 : 1);

    // 播放调试枪（W1 临时装备）
    if (this.equippedGun && !this.health.isDead) {
      this.drawGun();
    }
  }

  /**
   * 画手中的枪（调试用）。
   * 坐标系是 visual 的局部坐标：visual.scaleX = facing，
   * 因此世界方向 (cos, sin) 要换成局部 (facing*cos, sin)。
   */
  private drawGun(): void {
    const g = this.graphics;
    const lx = Math.cos(this.aimAngle) * this.facing;
    const ly = Math.sin(this.aimAngle);
    const sx = 0;
    const sy = StickmanRenderer.SHOULDER_Y;
    const armLen = 32;
    const gunLen = Player.MUZZLE_REACH - armLen;

    // 手臂
    g.lineStyle(4, this.color, 1);
    g.lineBetween(sx, sy, sx + lx * armLen, sy + ly * armLen);
    // 枪身
    g.lineStyle(6, 0x2a2a35, 1);
    g.lineBetween(sx + lx * armLen, sy + ly * armLen, sx + lx * (armLen + gunLen), sy + ly * (armLen + gunLen));
  }

  /** 联机预留：状态快照 */
  override serialize(): Record<string, unknown> {
    return {
      id: this.id,
      x: this.container.x,
      y: this.container.y,
      vx: this.body.velocity.x,
      vy: this.body.velocity.y,
      facing: this.facing,
      pose: this.pose,
      grounded: this.isGrounded,
    };
  }

  override destroy(): void {
    super.destroy();
    this.scene.matter.world.off('collisionactive', this.handleCollisionActive, this);
    this.scene.matter.world.remove(this.body);
    this.visual.destroy();
    this.container.destroy();
  }
}
