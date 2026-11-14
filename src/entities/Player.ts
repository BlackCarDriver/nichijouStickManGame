import Phaser from 'phaser';
import { Entity } from '../core/Entity';
import type { InputCommand } from '../core/InputCommand';
import { StickmanRenderer } from '../render/StickmanRenderer';
import { TEXT_RESOLUTION } from '../config/display';
import type { StickmanPose } from '../render/StickmanRenderer';
import { GameFeel } from '../feel/GameFeel';
import { COLLISION_CATEGORY, PLAYER_MASK_ALL } from '../core/CollisionCategories';
import { emptyInput } from '../core/InputCommand';
import { Health } from './Health';
import type { DamageInfo } from '../combat/DamageInfo';
import { getWeapon } from '../combat/WeaponFormat';
import { parseColor } from '../config/materials';
import type { HeldWeapon } from '../combat/WeaponFormat';
import type { SuperModeConfig } from '../combat/WeaponFormat';
import type { ActionClip, ActionPose } from '../editor/ActionFormat';
import { sampleAction } from '../editor/ActionFormat';
import { drawHeldWeapon, drawWeaponGlow } from '../render/WeaponRenderer';
import { raycast, getWorldBodies } from '../combat/Raycast';

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
  /**
   * 头部区域：碰撞体中心上方多少 px 以内算"头"（暴击区）。
   * 碰撞体高 96（中心 ±48），火柴人的头画在中心上方 41~63px，
   * 取 30 作为分界 → 顶部 18px 的碰撞带就是头部。
   */
  headZoneOffset: 30,
  /**
   * 自动上台阶的高度（px）。
   * 地上的木板/薄板（16~24px）不该把玩家卡住，应该能直接踩上去。
   */
  stepHeight: 34,
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

/**
 * 挥砍的角度曲线（弧度，叠加在瞄准角上）。
 * 按 spine-animation 的阶段划分：**预备 → 出击 → 跟随收势**，
 * 而不是一条匀速扫过去的直线（那样读不出"发力"）。
 *   - 预备 0~18%：向后上方抬刀（反向蓄力，幅度小、时间短）
 *   - 出击 18~55%：快速扫下（ease-out，冲击段加速明显）
 *   - 收势 55~100%：缓慢归位（跟随动作）
 */
function slashSwingCurve(p: number): number {
  const WINDUP_START = 0.5;
  const WINDUP_END = -0.6;
  const SWEEP_END = 0.75;

  if (p < 0.18) {
    const t = p / 0.18;
    // 快速抬到预备位（ease-out）
    const e = 1 - Math.pow(1 - t, 2);
    return WINDUP_START + (WINDUP_END - WINDUP_START) * e;
  }
  if (p < 0.55) {
    const t = (p - 0.18) / 0.37;
    // 出击：先慢后快再略缓（力量的"甩"感）
    const e = t * t * (3 - 2 * t);
    return WINDUP_END + (SWEEP_END - WINDUP_END) * e;
  }
  const t = (p - 0.55) / 0.45;
  // 收势：指数归位，末端几乎不动
  return SWEEP_END * (1 - (1 - Math.pow(1 - t, 3)));
}

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
  /** 光刀的发光层（ADD 混合，叠在角色之上） */
  private readonly glowGraphics: Phaser.GameObjects.Graphics;
  /** 超级战士身体光晕层（ADD 混合，画在角色背后） */
  private readonly bodyGlowGraphics: Phaser.GameObjects.Graphics;
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
  /** 护盾上限（防弹衣/超级战士共用同一个上限） */
  /** 普通角色的护盾上限（一件防弹衣 +50，最多两件） */
  static readonly BASE_MAX_SHIELD = 100;
  /** 超级战士（光刀）的护盾上限 */
  static readonly MAX_SHIELD = 500;
  readonly health = new Health({ maxHp: PLAYER_CONFIG.maxHp, maxShield: Player.BASE_MAX_SHIELD });
  /** 死亡后剩余复活倒计时（ms） */
  private respawnTimer = 0;

  // ---- 联机（netControlled）----
  /** 血量/死亡由网络事件驱动：本地伤害结算与自动复活关闭 */
  netControlled = false;
  /** 是否本地倒计时自动复活（联机时由服务端下发 respawn 事件） */
  autoRespawn = true;
  /** 环境伤害（摔落）上报钩子：联机模式下交给网络层（房主为所有玩家开启） */
  envDamageReporter?: (amount: number, player?: Player) => void;

  // ---- 联机展示：聊天室头像（圆形贴图）/ 昵称 / 聊天气泡 ----
  /** HUD 用的圆形头像贴图 key */
  avatarCircleKey?: string;
  private headAvatar?: Phaser.GameObjects.Image;
  private nameLabel?: Phaser.GameObjects.Text;
  private chatBubble?: {
    root: Phaser.GameObjects.Container;
    bg: Phaser.GameObjects.Graphics;
    text: Phaser.GameObjects.Text;
    remainMs: number;
  };
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

  // ---- 增益 / 超级战士 ----
  /** 是否处于超级战士状态（光刀专属） */
  private superMode = false;
  /** 移速倍率（超级战士等增益） */
  private buffSpeedMul = 1;
  /** 跳跃初速度倍率（>1 = 跳得更高） */
  private buffJumpMul = 1;
  /** 武器槽是否锁定（超级战士不能换武器） */
  weaponLocked = false;
  /** 超级战士身体光晕颜色 */
  private superGlowColor = 0xffe066;
  /**
   * 手部位置（visual 局部坐标）：由 StickmanRenderer 在瞄准时输出。
   * 武器从这里画、子弹从这里出，保证"枪口 = 子弹起点"。
   */
  private handLocal = { x: 0, y: StickmanRenderer.SHOULDER_Y };
  /** 双手武器的握杆中心（长矛使用），普通武器仍使用前手 */
  private weaponHandLocal = { x: 0, y: StickmanRenderer.SHOULDER_Y };
  private weaponAimOverride: number | null = null;

  // ---- 攻击动作（刺击/踢）----
  private attackKind: 'stab' | 'thrust' | 'kick' | 'slash' | 'punch' | null = null;
  private actionId: string | null = null;
  private actionStartMs = 0;
  private readonly actionClips: Map<string, ActionClip>;
  private attackTimer = 0;
  private attackDuration = 1;

  /** 最近一次命中自己的攻击批次 id（同批次可重复命中，如霰弹枪多弹丸） */
  private lastHitAttackId: number | undefined;
  /** 最近一次伤害的来源实体 id（击杀归属） */
  private lastDamageSourceId: number | undefined;
  /** 联机：本地已提前播过受击表现（含击退）的攻击批次，hp 到达时不再重复播 */
  private previewedAttackId: number | undefined;
  /** 最近一次伤害的武器 id 与类型（死亡回放用） */
  private lastHitWeaponId: string | undefined;
  private lastHitKind: string | undefined;

  private static readonly HIT_INVULN_MS = 180;

  /**
   * 腰上挂着的手榴弹的局部锚点（visual 局部坐标，+x = 面向方向）。
   * y ≈ 髋部（HIP_Y=5 略下方），x 取负值 = 挂在腰带后侧（不遮挡躯干）。
   */
  private static readonly WAIST_LOCAL = { x: -5, y: 7 };

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
  /** 联机：房主下发的着地状态（非 null 时优先于本地射线） */
  private remoteGroundedHint: boolean | null = null;
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
  private jumpLockout = 0;

  // ---- 动画状态机 ----
  private pose: StickmanPose = 'idle';
  /** 步态时间（秒）：行走时按速度累加，驱动确定性步态 */
  private gaitTime = 0;
  private hitTimer = 0;
  private hitPhase = 0;
  private hitTilt = 0;
  /** 受击姿态时长（原来 600ms 太长，动辄整屏乱舞） */
  private static readonly HIT_DURATION = 190;
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

  constructor(scene: Phaser.Scene, x: number, y: number, color: number, actionClips: ActionClip[] = []) {
    super();
    this.scene = scene;
    this.actionClips = new Map(actionClips.map((clip) => [clip.id, clip]));
    this.color = color;
    this.spawnX = x;
    this.spawnY = y;

    this.container = scene.add.container(x, y) as MatterContainer;
    this.visual = scene.add.container(0, 0);
    this.graphics = scene.add.graphics();
    this.visual.add(this.graphics);
    // 发光层用 ADD 混合：多层叠加会"真的变亮"，而不是越叠越灰
    this.glowGraphics = scene.add.graphics();
    this.glowGraphics.setBlendMode(Phaser.BlendModes.ADD);
    this.visual.add(this.glowGraphics);
    // 身体光晕层（超级战士）：插到最底层，才能"从身体后面透出来"
    this.bodyGlowGraphics = scene.add.graphics();
    this.bodyGlowGraphics.setBlendMode(Phaser.BlendModes.ADD);
    this.visual.addAt(this.bodyGlowGraphics, 0);
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
    // 联机：被快照驱动的远端玩家以房主下发的着地状态为准
    // （本地射线基于插值位置，跨端不一致时会导致 jump/fall 姿态乱跳）
    if (this.remoteGroundedHint !== null) return this.remoteGroundedHint;
    return this.rayGrounded || this.standingOnOneWay;
  }

  /**
   * 联机（非房主）：用房主的权威状态直接驱动该玩家。
   *
   * 远端玩家不再靠本地物理"猜"，而是按 100ms 缓冲插值回放；
   * 因此每帧会把刚体位置/速度写成权威值（Matter 是 Verlet 积分，
   * 必须用 setPosition/setVelocity 才会同步 positionPrev，避免产生巨大隐含速度）。
   */
  driveRemoteState(x: number, y: number, vx: number, vy: number, grounded: boolean): void {
    this.remoteGroundedHint = grounded;
    this.container.setPosition(x, y);
    this.container.setVelocity(vx, vy);
  }

  /** 切回"本地模拟"（房主变更时用）：清掉快照带来的着地提示 */
  clearRemoteDrive(): void {
    this.remoteGroundedHint = null;
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

    /**
     * 关键：击退必须开一个"推力窗口"。
     * 否则站在地面的玩家下一帧就会被移动控制（无输入 → 水平速度归零）抹掉，
     * 表现就是"被打中只是抖了一下，完全没被踢飞"。
     * 窗口长度按击退强度给：轻武器短短一下就够，踢/爆炸给足滑行时间。
     */
    this.pushTimer = Math.max(
      this.pushTimer,
      Math.min(280, 40 + Math.abs(knockbackX) * 12 + Math.abs(knockbackY) * 4),
    );

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
    // 联机：伤害由服务端仲裁，本地不做生命值结算
    if (this.netControlled) return 0;
    if (this.health.isDead) return 0;

    // 同一攻击批次（霰弹的多颗弹丸 / 激光的连续 tick）允许穿透无敌帧
    const sameAttack = info.attackId !== undefined && info.attackId === this.lastHitAttackId;
    const bypass = info.ignoreInvuln === true || sameAttack;

    const outcome = this.health.applyDamage(info.amount, bypass);
    const hpApplied = outcome.hp;
    const absorbed = outcome.shield;
    if (hpApplied <= 0 && absorbed <= 0) return 0;

    if (info.attackId !== undefined) this.lastHitAttackId = info.attackId;
    this.lastDamageSourceId = info.sourceId;
    this.lastHitWeaponId = info.weaponId;
    this.lastHitKind = info.kind;

    if (absorbed > 0) {
      // 护盾吸收：拿出来血事件（顿帧/音效/火花），但不弹伤害数字
      this.scene.events.emit('player-shielded', this, absorbed, info.kind);
    }

    if (hpApplied > 0) {
      // 广播：顿帧 / 音效 / 表现层都监听这个
      // 第 5 个参数是"本次攻击的伤害值"（未按剩余血量截断）：
      // 血量只剩 1 时挨 100 伤害，气泡应该显示 100 而不是 1
      this.scene.events.emit(
        'player-damaged',
        this,
        hpApplied,
        info.kind,
        info.critical === true,
        info.amount,
      );
    }

    // 击退 + 受击姿态（hit() 内部会广播 player-hit → 屏幕震动）
    // 高频低伤（激光 tick）用短后仰，否则会被持续锁在受击姿势里
    const kb = info.knockback ?? { x: 0, y: 0 };
    const light = info.ignoreInvuln === true || sameAttack;
    this.hit(kb.x, kb.y, light ? 80 : 190);
    // 短无敌：避免连发武器在同一瞬间把玩家打穿（AK 高频子弹）
    if (!light) this.health.setInvulnerable(Player.HIT_INVULN_MS);

    if (this.health.isDead) this.die();
    return hpApplied;
  }

  /**
   * 联机：以服务端下发的数值结算受击。
   *
   * 与 applyDamage 的区别：不再自己算血/护盾/无敌，只负责
   *  1) 写入权威数值；
   *  2) 用前后差值触发表现事件（伤害数字、护盾吸收、顿帧、音效）；
   *  3) 处理击退、受击姿态与死亡。
   */
  applyNetDamage(n: NetDamageEvent): void {
    // 服务端已复活但本地还停在尸体状态：直接恢复
    if (this.health.isDead && !n.dead) {
      this.respawnTimer = 0;
      this.health.setState(n.hp, n.shield, false);
      this.visual.setAlpha(1);
      this.container.setRotation(0);
      this.scene.events.emit('player-respawn', this);
      return;
    }
    if (this.health.isDead) return;

    const prevHp = this.health.hp;
    const prevShield = this.health.shield;
    const hpApplied = Math.max(0, prevHp - n.hp);
    const absorbed = Math.max(0, prevShield - n.shield);

    this.health.setState(n.hp, n.shield, n.dead);
    if (n.sourceId !== undefined && n.sourceId >= 0) this.lastDamageSourceId = n.sourceId;
    if (n.weaponId !== undefined) this.lastHitWeaponId = n.weaponId;
    if (n.kind !== undefined) this.lastHitKind = n.kind;

    if (absorbed > 0) {
      this.scene.events.emit('player-shielded', this, absorbed, n.kind);
    }
    if (hpApplied > 0) {
      this.scene.events.emit('player-damaged', this, hpApplied, n.kind, n.crit, n.amount, n.attackId);
    }

    if (n.dead) {
      this.die();
      return;
    }

    // 已经本地提前播过受击姿态/击退 → 这里只补数值，避免"晚到的二次打击感"
    if (!this.hasPreviewedAttack(n.attackId)) {
      const kb = n.knockback ?? { x: 0, y: 0 };
      this.hit(kb.x, kb.y, 190);
    }
    this.health.setInvulnerable(Player.HIT_INVULN_MS);
  }

  /**
   * 联机：提前播"被命中"的表现（受击姿态 + 击退），不改血量。
   *
   * 触发时机是**本地自己看到那一发打中了**（自己的子弹命中对手，或对手的子弹命中自己），
   * 因此反馈和画面是同一帧的，不用等 `hp` 一个来回。
   */
  previewHit(knockback: { x: number; y: number } | undefined, attackId?: number): void {
    if (this.health.isDead) return;
    if (attackId !== undefined && attackId === this.previewedAttackId) return;
    this.previewedAttackId = attackId;
    const kb = knockback ?? { x: 0, y: 0 };
    this.hit(kb.x, kb.y, 150);
  }

  /** 该攻击批次是否已经提前播过受击表现（`applyNetDamage` 用它去重） */
  hasPreviewedAttack(attackId?: number): boolean {
    return attackId !== undefined && attackId === this.previewedAttackId;
  }

  /** 联机：首次进入/重连时用服务端快照初始化（不触发伤害表现） */
  applyNetSnapshot(s: { hp: number; shield: number; dead: boolean }): void {
    this.health.setState(s.hp, s.shield, s.dead);
    if (this.health.isDead) {
      this.respawnTimer = 0;
      this.visual.setAlpha(0.55);
    }
  }

  /** 最近一次致伤/致命伤害的武器 id（'fist'/'kick' 等特殊值；环境伤害为 undefined） */
  get lastHitWeapon(): string | undefined {
    return this.lastHitWeaponId;
  }

  /** 最近一次致伤/致命伤害的类型（bullet/melee/explosion/kick/env） */
  get lastHitType(): string | undefined {
    return this.lastHitKind;
  }

  /** 联机：服务端指定的复活位置 */
  netRespawn(x: number, y: number): void {
    this.respawn(x, y);
  }

  // ==========================================================
  //  联机展示：头像 / 昵称 / 聊天气泡
  // ==========================================================

  /** 设置头顶昵称（灰色小字）与头像贴图 */
  setIdentity(nick: string, circleKey?: string): void {
    this.setDisplayName(nick);
    if (circleKey) this.setHeadAvatar(circleKey);
  }

  setDisplayName(nick: string): void {
    const name = nick.trim();
    if (!name) return;
    if (!this.nameLabel) {
      this.nameLabel = this.scene.add.text(0, 0, name, {
        fontFamily: 'PingFang SC, Microsoft YaHei, monospace',
        fontSize: '11px',
        color: '#c3cad6',
        stroke: '#0a0c12',
        strokeThickness: 3,
      });
      this.nameLabel.setOrigin(0.5, 1);
      this.nameLabel.setResolution(TEXT_RESOLUTION);
      this.visual.add(this.nameLabel);
    }
    this.nameLabel.setText(name);
  }

  /** 用圆形头像贴图替换头部（没有贴图时保留程序化彩色圆头） */
  setHeadAvatar(circleKey: string): void {
    if (!this.scene.textures.exists(circleKey)) return;
    this.avatarCircleKey = circleKey;
    const size = StickmanRenderer.HEAD_R * 2 * 1.12;
    if (!this.headAvatar) {
      this.headAvatar = this.scene.add.image(0, 0, circleKey);
      this.visual.add(this.headAvatar);
    }
    this.headAvatar.setTexture(circleKey);
    this.headAvatar.setDisplaySize(size, size);
  }

  /** 头顶聊天气泡（聊天室消息） */
  showChat(text: string, durationMs = 5200): void {
    const clean = text.trim();
    if (!clean) return;
    if (!this.chatBubble) {
      const root = this.scene.add.container(0, 0);
      const bg = this.scene.add.graphics();
      const label = this.scene.add.text(0, 0, '', {
        fontFamily: 'PingFang SC, Microsoft YaHei, monospace',
        fontSize: '12px',
        color: '#0f172a',
        wordWrap: { width: 168, useAdvancedWrap: true },
        align: 'center',
      });
      label.setOrigin(0.5, 0.5);
      label.setResolution(TEXT_RESOLUTION);
      root.add([bg, label]);
      root.setDepth(6);
      this.visual.add(root);
      this.chatBubble = { root, bg, text: label, remainMs: durationMs };
    }
    const bubble = this.chatBubble;
    bubble.text.setText(clean);
    bubble.remainMs = durationMs;

    // 底板：白色圆角 + 底部小尖角（跟着文字尺寸走）
    const padX = 7;
    const padY = 5;
    const w = Math.min(184, bubble.text.width + padX * 2);
    const h = bubble.text.height + padY * 2;
    const g = bubble.bg;
    g.clear();
    g.fillStyle(0xf7f9fc, 0.96);
    g.lineStyle(1.5, 0xffffff, 0.9);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, 7);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, 7);
    g.fillStyle(0xf7f9fc, 0.96);
    g.fillTriangle(-5, h / 2 - 1, 5, h / 2 - 1, 0, h / 2 + 6);
    bubble.root.setVisible(true);
    bubble.root.setAlpha(1);
  }

  /** 每帧把头像/昵称/气泡贴到头部位置（由 draw 调用） */
  private syncHeadDecor(): void {
    const head = StickmanRenderer.lastHead;
    if (!head) return;
    const dead = this.health.isDead;
    // visual 会按 facing 整体水平镜像（火柴人左右朝向），但昵称/气泡/头像不能跟着反：
    // - 文本用反向 scaleX 抵消
    // - 头像用 flipX 抵消（保留 setDisplaySize 的缩放）
    const facing = this.facing;
    if (this.headAvatar) {
      this.headAvatar.setVisible(!dead);
      this.headAvatar.setPosition(head.x, head.y);
      this.headAvatar.setFlipX(facing < 0);
    }
    if (this.nameLabel) {
      this.nameLabel.setVisible(!dead);
      this.nameLabel.setPosition(head.x, head.y - StickmanRenderer.HEAD_R - 3);
      this.nameLabel.setScale(facing, 1);
    }
    if (this.chatBubble) {
      const b = this.chatBubble;
      const h = b.text.height + 10;
      b.root.setPosition(head.x, head.y - StickmanRenderer.HEAD_R - 12 - h / 2);
      b.root.setScale(facing, 1);
      b.root.setVisible(!dead && b.remainMs > 0);
      // 末尾 500ms 淡出
      b.root.setAlpha(Math.max(0, Math.min(1, b.remainMs / 500)));
    }
  }

  // ==========================================================
  //  增益 / 超级战士（光刀）
  // ==========================================================

  get isSuperMode(): boolean {
    return this.superMode;
  }

  /** 拾取光刀 → 超级战士：叠加护盾 + 加速跳跃 + 身体发光，且锁定武器槽 */
  enterSuperMode(cfg: SuperModeConfig): void {
    if (this.superMode) return;
    this.superMode = true;
    this.weaponLocked = true;
    // 光刀战士护盾上限提高到 500，再叠加配置里的护盾
    this.health.setMaxShield(Player.MAX_SHIELD);
    this.buffSpeedMul = cfg.speedMul ?? 1.3;
    this.buffJumpMul = cfg.jumpMul ?? 1.1;
    if (cfg.glow) this.superGlowColor = parseColor(cfg.glow, this.superGlowColor);
    this.health.addShield(cfg.shield ?? 0);
    this.scene.events.emit('super-mode', this, true);
  }

  /** 退出超级战士（死亡/失去光刀时）*/ 
  exitSuperMode(): void {
    if (!this.superMode) return;
    this.superMode = false;
    this.weaponLocked = false;
    // 退出超级战士：护盾上限回落，超出部分直接丢弃
    this.health.setMaxShield(Player.BASE_MAX_SHIELD);
    this.buffSpeedMul = 1;
    this.buffJumpMul = 1;
    this.scene.events.emit('super-mode', this, false);
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
    // 死亡 → 超级战士解除（增益/武器锁找回，护盾随 health.reset() 清空）
    this.exitSuperMode();
    // 死亡 → 武器消失（最初确认的规则；近战武器因为取消了耐久度，
    // 需要靠"死亡掉落"来维持流转，否则一旦拿到光刀就永久持有）
    if (this.heldWeapon) {
      const id = this.heldWeapon.id;
      this.heldWeapon = null;
      this.scene.events.emit('weapon-lost', this, id, 'death', { ammo: 0 });
    }
    this.respawnTimer = PLAYER_CONFIG.respawnDelayMs;
    this.scene.events.emit('player-died', this, this.lastDamageSourceId);
  }

  /** 复活：回到出生点、满血、短无敌 */
  private respawn(x = this.spawnX, y = this.spawnY): void {
    this.respawnTimer = 0;
    this.health.reset();
    this.health.setInvulnerable(PLAYER_CONFIG.spawnInvulnMs);
    this.container.setPosition(x, y);
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
  setAttack(
    kind: 'stab' | 'thrust' | 'kick' | 'slash' | 'punch',
    durationMs: number,
    actionId?: string,
  ): void {
    this.attackKind = kind;
    this.actionId = actionId ?? (this.heldWeapon?.id === 'spear' && kind === 'thrust' ? 'spear_thrust' : null);
    this.actionStartMs = this.scene.time.now;
    this.attackTimer = durationMs;
    this.attackDuration = Math.max(1, durationMs);
  }

  /** 当前攻击类型（无攻击时为 null） */
  get attack(): 'stab' | 'thrust' | 'kick' | 'slash' | 'punch' | null {
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
    return slashSwingCurve(this.attackProgress);
  }

  /** 肩部位置（世界坐标）：瞄准角计算与枪口起点基准 */
  get shoulderWorld(): { x: number; y: number } {
    return {
      x: this.container.x,
      y: this.container.y + this.visual.y + StickmanRenderer.SHOULDER_Y,
    };
  }

  /**
   * 腰上挂着的手榴弹的世界坐标（子弹是否击中榴弹用）。
   * 局部坐标 +x = 面向方向，因此背后的偏移要乘 facing；
   * visual 整体有 smSurfCenter 的斜面下移，这里一并计入。
   */
  get waistWorld(): { x: number; y: number } {
    return {
      x: this.container.x + this.facing * Player.WAIST_LOCAL.x,
      y: this.container.y + this.visual.y + Player.WAIST_LOCAL.y,
    };
  }

  /** 命中点是否落在头部（暴击区） */
  isHeadHit(pointY: number): boolean {
    return pointY <= this.container.y - PLAYER_CONFIG.headZoneOffset;
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

    if (this.chatBubble && this.chatBubble.remainMs > 0) {
      this.chatBubble.remainMs = Math.max(0, this.chatBubble.remainMs - deltaMs);
    }

    // ---- 生命值 / 死亡 → 复活 ----
    this.health.update(deltaMs);
    if (this.health.isDead) {
      if (this.respawnTimer > 0) {
        this.respawnTimer = Math.max(0, this.respawnTimer - deltaMs);
      }
      if (this.autoRespawn && this.respawnTimer <= 0) {
        this.respawn();
      }
      // 死亡期间不接受操作（物理与渲染照常：尸体继续被打飞）
      cmd = emptyInput();
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
    const buffMul = this.buffSpeedMul;
    const maxVx = PLAYER_CONFIG.maxHorizontalSpeed * buffMul;
    // 着地且无输入 → 精确归零（避免在斜面上因碰撞法线推力而缓慢滑落）
    const targetVx =
      cmd.moveX !== 0
        ? cmd.moveX * PLAYER_CONFIG.moveSpeed * speedMul * buffMul
        : this.pushTimer > 0
          ? this.body.velocity.x * 0.94 // 后坐力击退中：只做轻微衰减，让它滑出去
          : this.isGrounded
            ? 0
            : this.body.velocity.x * 0.85;
    const cappedVx = Phaser.Math.Clamp(targetVx, -maxVx, maxVx);
    this.container.setVelocityX(cappedVx);

    // 走出低矮障碍（木板/薄板）：自动抬上台阶，而不是被卡住
    if (cmd.moveX !== 0) {
      this.tryStepUp(cmd.moveX);
    }

    // ===== 跳跃求解：缓冲 + 土狼时间同时满足才跳（一起消耗，防二段跳）=====
    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0) {
      this.container.setVelocityY(PLAYER_CONFIG.jumpVelocity * this.buffJumpMul);
      this.jumpBufferTimer = 0;
      this.coyoteTimer = 0;
      this.jumpLockout = PLAYER_CONFIG.jumpLockout;
      this.jumpAnticipation = Player.JUMP_ANTICIPATION_DURATION; // 起跳前摇（下一帧起显示压缩姿态）
      GameFeel.pop(this.graphics, 0.85, 1.15, 200);
    }

    // 跳跃高度固定：不再根据按键时长缩短跳跃（玩家反馈"时高时低"），
    // 好处是同一段输入在任何端/任何帧率下轨迹一致，联机预测也更稳。
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
    // 注意：以下两种情况必须保留向上速度，否则会被"抹掉"
    //   1. 起跳后的短暂锁定期（jumpLockout）—— 否则跳跃被吃掉
    //   2. 受击推力窗口（pushTimer）—— 否则被踢飞/爆炸时上抛不生效，只是横向滑出去
    if (
      this.isGrounded &&
      this.body.velocity.y < 0 &&
      this.jumpLockout <= 0 &&
      this.pushTimer <= 0
    ) {
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
   * 自动上台阶。
   *
   * 做法：在身体前方（半个身位外）从「脚底上方 stepHeight」向下探一条竖线，
   * 命中面的高度差在 (3, stepHeight] 区间内就把人抬上去。
   *
   * 为什么能区分"矮台阶"和"高墙"：
   * 竖直探测若**从墙体内部开始**，射线会先打到墙的**下边缘**（≈ 地面高度），
   * 高度差≈0 → 直接被 `rise < 3` 过滤掉，所以高墙不会把人"吸"上去。
   */
  private tryStepUp(moveDir: number): void {
    if (!this.isGrounded) return;

    const feetY = this.feetY;
    const probeX = this.container.x + Math.sign(moveDir) * (PLAYER_CONFIG.bodyWidth / 2 + 4);
    const startY = feetY - PLAYER_CONFIG.stepHeight;

    const hits = raycast(
      getWorldBodies(this.scene),
      { x: probeX, y: startY },
      { x: 0, y: 1 },
      PLAYER_CONFIG.stepHeight + 4,
      { ignore: [this.body], maxHits: 1 },
    );
    const hit = hits[0];
    if (!hit) return;

    const rise = feetY - hit.point.y;
    if (rise < 3 || rise > PLAYER_CONFIG.stepHeight) return;

    // 抬到台阶面上（留 1px 余量，避免正好卡在边界）
    this.container.setPosition(this.container.x, this.container.y - rise - 1);
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

    // 攻击动作计时器（没有这一行 → attackProgress 恒为 0，姿势永远不显示）
    if (this.attackTimer > 0) {
      this.attackTimer = Math.max(0, this.attackTimer - deltaMs);
      if (this.attackTimer === 0) {
        this.attackKind = null;
        this.actionId = null;
      }
    }

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
        if (this.netControlled) {
          this.envDamageReporter?.(fallDamage, this);
        } else {
          this.applyDamage({ amount: fallDamage, kind: 'env', knockback: { x: 0, y: 0 } });
        }
      }

      const fallSpeed = this.body.velocity.y;
      // 下落速度 → 冲击强度（力的大小决定吸收深度）
      this.landImpactStrength = Phaser.Math.Clamp(fallSpeed / 18, 0.15, 1);
      this.landImpact = Player.LAND_IMPACT_DURATION;
      const intensity = Phaser.Math.Clamp(fallSpeed / 15, 0.15, 0.45);
      GameFeel.pop(this.graphics, 1 + intensity, 1 - intensity, 160);
    }
  }

  private actionPoseForRender(): ActionPose | undefined {
    let id = this.actionId;
    if (!id && this.attack === null && this.pose === 'idle') {
      if (!this.heldWeapon) id = 'unarmed_idle';
      else if (getWeapon(this.heldWeapon.id)?.visual.style === 'spear') id = 'spear_idle';
    }
    if (!id) return undefined;
    const clip = this.actionClips.get(id);
    if (!clip) return undefined;
    const elapsed = id.endsWith('_idle')
      ? clip.loop
        ? this.scene.time.now
        : 0
      : this.scene.time.now - this.actionStartMs;
    return sampleAction(clip, Math.max(0, elapsed));
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
      facing: this.facing,
      attackKind: this.attack,
      attackProgress: this.attackProgress,
      actionPose: this.actionPoseForRender(),
    });

    // 手部位置：渲染器在瞄准时输出；空手时用肩根近似
    this.handLocal = StickmanRenderer.lastAimHand ?? {
      x: this.facing * StickmanRenderer.SHOULDER_W,
      y: StickmanRenderer.SHOULDER_Y + StickmanRenderer.SHOULDER_DY + StickmanRenderer.ARM_REACH,
    };
    this.weaponHandLocal = StickmanRenderer.lastWeaponHand ?? this.handLocal;
    this.weaponAimOverride = StickmanRenderer.lastWeaponAim;

    // 头顶装饰（头像/昵称/聊天气泡）：跟着本帧头部位置
    this.syncHeadDecor();

    // 超级战士身体光晕（每帧重画，非超级状态时清空）
    this.drawBodyGlow();

    // 光刀发光层（每帧重画；非光刀时清空）
    this.glowGraphics.clear();
    if (
      !this.grenadeMode &&
      this.heldWeapon &&
      !this.health.isDead &&
      getWeapon(this.heldWeapon.id)?.visual.style === 'lightsaber'
    ) {
      const visual = getWeapon(this.heldWeapon.id)?.visual;
      if (visual) {
        drawWeaponGlow(this.glowGraphics, {
          visual,
          facing: this.facing,
          aim: this.renderAim + this.slashOffset,
          hand: this.handLocal,
          colorOverride: this.color,
          glowOverride: this.color,
        });
      }
    }

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
        const weaponHand = visual.style === 'spear' ? this.weaponHandLocal : this.handLocal;
        const weaponAim =
          visual.style === 'spear' && this.weaponAimOverride !== null
            ? this.weaponAimOverride
            : this.renderAim + this.slashOffset;
        const weaponThrust = visual.style === 'spear' ? 0 : thrust;
        drawHeldWeapon(this.graphics, {
          visual,
          facing: this.facing,
          aim: weaponAim,
          // 光刀的颜色跟随持有者（红火柴人 → 红光刃）
          colorOverride: visual.style === 'lightsaber' ? this.color : undefined,
          hand: {
            x: weaponHand.x + this.facing * Math.cos(this.aimAngle) * weaponThrust,
            y: weaponHand.y + Math.sin(this.aimAngle) * weaponThrust,
          },
        });
      }
    }

    // 腰上挂着的手榴弹（未取出、且身上确实有榴弹时显示）
    this.drawWaistGrenade();

    // 斜面时整体下移视觉（平滑值，避免抖动闪烁）
    this.visual.y = this.smSurfCenter;

    // 存活时确保不透明（死亡表现由 updateDeathPose 控制 alpha）
    if (!this.health.isDead) this.visual.setAlpha(1);
  }

  /**
   * 画腰上挂着的手榴弹。
   * 用武器渲染器画（保证与手里/地上的手榴弹是同一个模型），
   * 朝下悬挂：aim = π/2，并把绘制起点回推半个长度，使榴弹本体落在腰部锚点上。
   */
  private drawWaistGrenade(): void {
    if (this.grenadeCount <= 0 || this.grenadeMode || this.health.isDead) return;
    const visual = getWeapon('grenade')?.visual;
    if (!visual) return;
    const anchor = Player.WAIST_LOCAL;
    drawHeldWeapon(this.graphics, {
      visual,
      facing: this.facing,
      aim: Math.PI / 2,
      hand: { x: anchor.x, y: anchor.y - visual.length * 0.4 },
    });
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
    // world 可能已在场景关闭时被置空（见 ImpactDamageSystem.destroy 的注释）
    this.scene.matter?.world?.off('collisionactive', this.handleCollisionActive, this);
    this.scene.matter?.world?.remove(this.body);
    this.headAvatar?.destroy();
    this.nameLabel?.destroy();
    this.chatBubble?.root.destroy(true);
    this.bodyGlowGraphics.destroy();
    this.glowGraphics.destroy();
    this.visual.destroy();
    this.container.destroy();
  }

  /**
   * 身体光晕（超级战士）：多层同心圆 + ADD 混合 + 呼吸脉动。
   * 画在 visual 最底层（角色背后），所以只能是“从身体边缘透出来的淡淡黄光”。
   */
  private drawBodyGlow(): void {
    const g = this.bodyGlowGraphics;
    g.clear();
    if (!this.superMode || this.health.isDead) return;

    // 身体光晕（超级战士）：低透明度的边缘光 + 呼吸，不用几块实心圆盖住角色。
    const t = (this.scene.time.now % 1600) / 1600;
    const pulse = 0.72 + 0.28 * Math.sin(t * Math.PI * 2);
    // 身体光跟随火柴人颜色，保持与光刀的颜色统一。
    const color = this.color;

    // 大范围只保留极淡的底光，靠轮廓线建立“被光包住”的感觉。
    g.fillStyle(color, 0.018 * pulse);
    g.fillCircle(0, -20, 58);
    g.lineStyle(8, color, 0.045 * pulse);
    g.strokeEllipse(0, -21, 76, 108);

    // 头部与躯干的局部光环，让发光状态在小尺寸下仍然可读。
    g.lineStyle(3, color, 0.12 * pulse);
    g.strokeCircle(0, -60, 15);
    g.lineStyle(4, color, 0.075 * pulse);
    g.strokeEllipse(0, -17, 42, 64);

    // 两条很短的侧向光痕，打破“套了圆形光晕”的廉价感。
    g.lineStyle(2, color, 0.16 * pulse);
    g.lineBetween(-31, -45, -22, -48);
    g.lineBetween(22, -48, 31, -45);
  }
}

/** 联机受击事件（服务端 hp 消息） */
export interface NetDamageEvent {
  hp: number;
  shield: number;
  dead: boolean;
  amount: number;
  kind: string;
  crit: boolean;
  point?: { x: number; y: number };
  knockback?: { x: number; y: number };
  sourceId?: number;
  /** 造成这次伤害的武器 id（死亡回放用） */
  weaponId?: string;
  /** 攻击批次 id（打击反馈去重用） */
  attackId?: number;
}
