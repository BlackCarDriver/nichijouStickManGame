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
import { getWeapon } from '../combat/WeaponFormat';
import type { HeldWeapon } from '../combat/WeaponFormat';
import { drawHeldWeapon } from '../render/WeaponRenderer';

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
  /** 最大下落速度：防穿透（同时抬高摔落伤害的可测区间） */
  maxFallSpeed: 32,
  /** 摔落伤害阈值：低于此落地速度不掉血（普通跳跃落地应低于它） */
  fallSafeSpeed: 21,
  /** 摔落伤害系数：每超速 1 点造成多少伤害 */
  fallDamagePerSpeed: 3.2,
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
  /** 死亡 → 复活的完整时长（ms）= 倒下 + 闪烁 + 消失 */
  respawnDelayMs: 2800,
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

  /** 面向（1=右 -1=左）。**优先跟随瞄准（鼠标）**，无瞄准时跟随移动 */
  facing: 1 | -1 = 1;
  /** 本帧移动方向（-1/0/1），用于判断"倒着走" */
  moveDir = 0;
  /** 是否在倒着走（面向与移动方向相反）→ 倒走动画 */
  backward = false;
  /** 本段空中见过的最大下落速度（落地时用于算摔落伤害） */
  private fallSpeedSeen = 0;
  /** 最近一次落地的下落速度（调试/测试用） */
  lastLandingSpeed = 0;

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
  /** 手持武器（null = 空手）。由 WeaponSystem 装备 */
  heldWeapon: HeldWeapon | null = null;

  // ---- 后坐力 ----
  /** 枪口/弹道当前的上抬角度（度）。开枪累加，随时间回落 → 需要玩家压枪 */
  private recoilClimbDeg = 0;
  /** 上抬累计上限（度），由当前武器的 recoil 配置决定 */
  private recoilClimbMaxDeg = 0;
  /** 上抬从上限回落到 0 所需时间（ms） */
  private recoilRecoverMs = 320;
  /**
   * 后坐力推力生效窗口（ms）。
   * 站在地面时移动控制每帧会把"无输入"的水平速度归零，
   * 后坐力推力会被立刻抹掉 → 这个窗口内不做刹车，让击退滑出去。
   */
  private pushTimer = 0;
  /** 手榴弹背包数量（上限见 GRENADE_MAX） */
  grenadeCount = 0;
  /** 是否正握着手榴弹（此时左键=投掷，武器暂存在 heldWeapon 里不渲染） */
  grenadeMode = false;
  /**
   * 手部位置（visual 局部坐标）：由 StickmanRenderer 在瞄准时输出。
   * 武器从这里画、子弹从这里出，保证"枪口 = 子弹起点"。
   */
  private handLocal = { x: 0, y: StickmanRenderer.SHOULDER_Y };

  // ---- 攻击动作（刺击/踢）----
  private attackKind: 'stab' | 'kick' | 'slash' | null = null;
  private attackTimer = 0;
  private attackDuration = 1;

  /** 最近一次命中自己的攻击批次 id（同批次可重复命中，如霰弹枪多弹丸） */
  private lastHitAttackId: number | undefined;

  private static readonly HIT_INVULN_MS = 180;

  // ---- 死亡表现时序（倒下 → 闪烁 → 消失 → 复活）----
  /** 倒地动画时长 */
  private static readonly DEATH_FALL_MS = 450;
  /** 闪烁阶段时长（正常 ↔ 半透明） */
  private static readonly DEATH_BLINK_MS = 2000;
  /** 闪烁切换间隔 */
  private static readonly DEATH_BLINK_INTERVAL_MS = 250;
  /** 完全消失到复活的间隔 */
  private static readonly DEATH_GONE_MS = 350;
  private static readonly DEATH_TOTAL_MS =
    Player.DEATH_FALL_MS + Player.DEATH_BLINK_MS + Player.DEATH_GONE_MS;

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

    // 同一攻击批次（霰弹的多颗弹丸 / 激光的连续 tick）允许穿透无敌帧
    const sameAttack = info.attackId !== undefined && info.attackId === this.lastHitAttackId;
    const bypass = info.ignoreInvuln === true || sameAttack;

    const applied = this.health.applyDamage(info.amount, bypass);
    if (applied <= 0) return 0;

    if (info.attackId !== undefined) this.lastHitAttackId = info.attackId;

    // 击退 + 受击姿态（hit() 内部会广播 player-hit → 屏幕震动）
    // 高频低伤（激光 tick）用短后仰，否则会被持续锁在受击姿势里
    const kb = info.knockback ?? { x: 0, y: 0 };
    const light = info.ignoreInvuln === true || sameAttack;
    this.hit(kb.x, kb.y, light ? 130 : 380);
    // 短无敌：避免连发武器在同一瞬间把玩家打穿（AK 高频子弹）
    if (!light) this.health.setInvulnerable(Player.HIT_INVULN_MS);

    if (this.health.isDead) this.die();
    return applied;
  }

  /** 治疗（医疗包用） */
  heal(amount: number): number {
    return this.health.heal(amount);
  }

  /**
   * 死亡表现：倒下 → 闪烁 2 秒 → 消失 → 复活。
   * 由 respawnTimer 的剩余时间反推当前处于哪个阶段。
   */
  private updateDeathPose(): void {
    const elapsed = Player.DEATH_TOTAL_MS - this.respawnTimer;
    const fallEnd = Player.DEATH_FALL_MS;
    const blinkEnd = fallEnd + Player.DEATH_BLINK_MS;
    const lyingAngle = this.facing * (Math.PI / 2) * 0.94;

    if (elapsed < fallEnd) {
      // 倒地：快速转到躺平（ease-out）
      const t = Math.min(1, elapsed / fallEnd);
      const eased = 1 - Math.pow(1 - t, 2);
      this.container.rotation = lyingAngle * eased;
      this.visual.setAlpha(1);
      return;
    }

    this.container.rotation = lyingAngle;

    if (elapsed < blinkEnd) {
      // 闪烁：正常 ↔ 半透明
      const phase = Math.floor((elapsed - fallEnd) / Player.DEATH_BLINK_INTERVAL_MS);
      this.visual.setAlpha(phase % 2 === 0 ? 1 : 0.3);
      return;
    }

    // 消失
    this.visual.setAlpha(0);
  }

  private die(): void {
    this.grenadeMode = false;
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
    this.recoilClimbDeg = 0;
    this.visual.setAlpha(1);
    this.scene.events.emit('player-respawn', this);
  }

  // ==========================================================
  //  瞄准 / 枪口
  // ==========================================================

  /**
   * 当前**实际**瞄准角度（弧度）= 鼠标方向 + 后坐力上抬。
   * 枪口绘制、子弹方向、近战判定都用它，所以"看到枪口抬到哪，子弹就往哪飞"。
   */
  get aim(): number {
    if (this.recoilClimbDeg <= 0) return this.aimAngle;
    // 面向右时上抬=减小角度；面向左时上抬=增大角度（屏幕 y 向下）
    const upSign = Math.cos(this.aimAngle) >= 0 ? -1 : 1;
    return this.aimAngle + upSign * ((this.recoilClimbDeg * Math.PI) / 180);
  }

  /** 当前后坐力上抬量（度，调试/HUD 用） */
  get recoilClimb(): number {
    return this.recoilClimbDeg;
  }

  /**
   * 触发一次后坐力。
   * @param push 把自身沿瞄准反方向推开的冲量
   * @param climbDeg 本次上抬角度（度）
   * @param climbMaxDeg 上抬累计上限（度）
   * @param recoverMs 从上限回落所需时间
   */
  applyRecoil(push: number, climbDeg: number, climbMaxDeg: number, recoverMs: number): void {
    if (this.health.isDead) return;

    // 枪口上抬
    this.recoilClimbMaxDeg = Math.max(0.01, climbMaxDeg);
    this.recoilRecoverMs = Math.max(60, recoverMs);
    this.recoilClimbDeg = Math.min(this.recoilClimbMaxDeg, this.recoilClimbDeg + climbDeg);

    // 自身被向后推（火箭/霰弹/狙击才有明显位移）
    if (push > 0) {
      this.pushTimer = 220;
      const a = this.aimAngle;
      const vx = this.body.velocity.x - Math.cos(a) * push;
      const vy = this.body.velocity.y - Math.sin(a) * push * 0.35;
      this.container.setVelocity(
        Phaser.Math.Clamp(vx, -PLAYER_CONFIG.maxHorizontalSpeed, PLAYER_CONFIG.maxHorizontalSpeed),
        vy,
      );
    }
  }

  /** 触发一次攻击动作（刺击/踢），供武器系统调用 */
  setAttack(kind: 'stab' | 'kick' | 'slash', durationMs: number): void {
    this.attackKind = kind;
    this.attackTimer = durationMs;
    this.attackDuration = Math.max(1, durationMs);
  }

  /** 当前攻击类型（无攻击时为 null） */
  get attack(): 'stab' | 'kick' | 'slash' | null {
    return this.attackTimer > 0 ? this.attackKind : null;
  }

  /** 攻击动作进度 0→1（0 = 未开始/已结束） */
  get attackProgress(): number {
    return this.attackTimer > 0 ? 1 - this.attackTimer / this.attackDuration : 0;
  }

  /**
   * 挥砍角度偏移（弧度，仅 slash 用）：从上往下扫过约 97°。
   * 用于同时驱动"手臂朝向"和"刀刃朝向"，让挥砍看起来是一整条弧。
   */
  get slashOffset(): number {
    if (this.attack !== 'slash') return 0;
    const p = this.attackProgress;
    const eased = 1 - Math.pow(1 - p, 2); // 前段快、后段收
    return -0.95 + 1.7 * eased;
  }

  /** 肩部位置（世界坐标）：瞄准角计算与枪口起点基准 */
  get shoulderWorld(): { x: number; y: number } {
    return {
      x: this.container.x,
      y: this.container.y + this.visual.y + StickmanRenderer.SHOULDER_Y,
    };
  }

  /** 手部世界坐标（近战判定/挥砍起点） */
  get handWorld(): { x: number; y: number } {
    return {
      x: this.container.x + this.facing * this.handLocal.x,
      y: this.container.y + this.visual.y + this.handLocal.y,
    };
  }

  /** 绘制用瞄准角（含后坐力上抬） */
  private get renderAim(): number {
    return this.aim;
  }

  /**
   * 枪口位置（世界坐标）：手部 + 武器长度。
   * 子弹必须从这里出，否则会从墙里穿出来。
   */
  get muzzle(): { x: number; y: number } {
    const held = this.heldWeapon;
    const gunLen = held ? (getWeapon(held.id)?.visual.length ?? 0) : 0;
    const hx = this.container.x + this.facing * this.handLocal.x;
    const hy = this.container.y + this.visual.y + this.handLocal.y;
    const aim = this.aim;
    return {
      x: hx + Math.cos(aim) * gunLen,
      y: hy + Math.sin(aim) * gunLen,
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

    // 后坐力上抬回落（线性回落到 0）
    if (this.recoilClimbDeg > 0) {
      const drop = (this.recoilClimbMaxDeg / this.recoilRecoverMs) * deltaMs;
      this.recoilClimbDeg = Math.max(0, this.recoilClimbDeg - drop);
    }
    // 后坐力推力窗口
    if (this.pushTimer > 0) this.pushTimer = Math.max(0, this.pushTimer - deltaMs);

    // 追踪下落速度峰值（用于摔落伤害）
    if (!this.isGrounded && this.body.velocity.y > 0) {
      this.fallSpeedSeen = Math.max(this.fallSpeedSeen, this.body.velocity.y);
    }

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
        : this.pushTimer > 0
          ? this.body.velocity.x * 0.94 // 后坐力击退中：只做轻微衰减，让它滑出去
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

    // ===== 朝向：优先跟随瞄准（鼠标），否则跟随移动 =====
    if (cmd.aimAngle !== null) {
      this.facing = Math.cos(cmd.aimAngle) >= 0 ? 1 : -1;
    } else if (cmd.moveX !== 0) {
      this.facing = cmd.moveX > 0 ? 1 : -1;
    }
    this.moveDir = cmd.moveX;
    // 倒着走：面向与移动方向相反
    this.backward = cmd.moveX !== 0 && Math.sign(cmd.moveX) !== this.facing;

    // 瞄准角：明确角度优先；null → 跟随朝向
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
    // 死亡：尸体姿势与闪烁由专门的时序驱动，跳过常规姿势
    if (this.health.isDead) {
      this.updateDeathPose();
      return;
    }

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
      // ---- 摔落伤害：速度越高伤害越高 ----
      const impactSpeed = this.fallSpeedSeen;
      this.fallSpeedSeen = 0;
      this.lastLandingSpeed = impactSpeed;
      if (impactSpeed > PLAYER_CONFIG.fallSafeSpeed) {
        const fallDamage = (impactSpeed - PLAYER_CONFIG.fallSafeSpeed) * PLAYER_CONFIG.fallDamagePerSpeed;
        this.applyDamage({ amount: fallDamage, kind: 'env', knockback: { x: 0, y: 0 } });
      }

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
      // 持枪时前臂指向瞄准方向（挥砍时跟随刀身扫过）
      aim:
        (this.heldWeapon || this.grenadeMode) && !this.health.isDead
          ? this.renderAim + this.slashOffset
          : null,
      backward: this.backward,
      attackKind: this.attack,
      attackProgress: this.attackProgress,
    });

    // 手部位置：渲染器在瞄准时输出；空手时用肩根近似
    this.handLocal = StickmanRenderer.lastAimHand ?? {
      x: this.facing * StickmanRenderer.SHOULDER_W,
      y: StickmanRenderer.SHOULDER_Y + StickmanRenderer.SHOULDER_DY + StickmanRenderer.ARM_REACH,
    };

    // 握着的手榴弹（优先于武器）
    if (this.grenadeMode && !this.health.isDead) {
      const grenadeVisual = getWeapon('grenade')?.visual;
      if (grenadeVisual) {
        drawHeldWeapon(this.graphics, {
          visual: grenadeVisual,
          facing: this.facing,
          aim: this.renderAim,
          hand: this.handLocal,
        });
      }
    } else if (this.heldWeapon && !this.health.isDead) {
      const visual = getWeapon(this.heldWeapon.id)?.visual;
      if (visual) {
        // 刺击时武器沿瞄准方向前送（近战戳得远，枪械只有轻微后坐）
        const held = this.heldWeapon;
        const isMelee = held ? getWeapon(held.id)?.attackMode === 'melee' : false;
        const thrust = Math.sin(this.attackProgress * Math.PI) * (isMelee ? 16 : 4);
        drawHeldWeapon(this.graphics, {
          visual,
          facing: this.facing,
          aim: this.renderAim + this.slashOffset,
          hand: {
            x: this.handLocal.x + this.facing * Math.cos(this.aimAngle) * thrust,
            y: this.handLocal.y + Math.sin(this.aimAngle) * thrust,
          },
        });
      }
    }

    // 斜面时整体下移视觉（平滑值，避免抖动闪烁）
    this.visual.y = this.smSurfCenter;

    // 存活时确保不透明（死亡表现由 updateDeathPose 控制 alpha）
    if (!this.health.isDead) this.visual.setAlpha(1);
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
