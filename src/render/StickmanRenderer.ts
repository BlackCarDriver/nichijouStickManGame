import Phaser from 'phaser';
import {
  RIG_BONES,
  WALK,
  GROUND_OFFSET,
  LEG_LENGTH,
  gaitFoot,
  solveLegIK,
  chain2,
  upVec,
} from './StickmanRig';
import type { Vec2 } from './StickmanRig';

/** 火柴人姿势状态（动画状态机） */
export type StickmanPose = 'idle' | 'walk' | 'jump' | 'fall' | 'hit' | 'crouch';

export interface StickmanDrawOptions {
  color: number;
  /** 步态时间（秒） */
  gaitTime: number;
  pose: StickmanPose;
  moving: boolean;
  grounded: boolean;
  hitIntensity: number;
  hitPhase: number;
  velocityX: number;
  velocityY: number;
  /** 落地冲击进度 0~1（1 = 刚落地，0 = 恢复完毕） */
  landImpact?: number;
  /** 落地冲击强度 0~1 */
  landImpactStrength?: number;
  /** 起跳预备进度 0~1（1 = 刚开始压缩） */
  jumpAnticipation?: number;
  /** 左脚处地面相对偏移（斜面时贴合用，正 = 更低） */
  groundYL?: number;
  /** 右脚处地面相对偏移 */
  groundYR?: number;
  /** 是否蹲下 */
  crouching?: boolean;
  /** 面向（1=右 -1=左）。瞄准手臂的角度换算需要它 */
  facing?: 1 | -1;
  /** 是否倒着走（面向与移动方向相反 → 步态反向 + 身体后仰） */
  backward?: boolean;
  /** 当前攻击动作类型 */
  attackKind?: 'stab' | 'thrust' | 'kick' | 'slash' | 'punch' | null;
  /** 攻击动作进度 0→1 */
  attackProgress?: number;
  /**
   * 瞄准角（世界弧度）。非空时"前臂"改为指向瞄准方向（持枪姿势），
   * 并由 StickmanRenderer.lastAimHand 输出手部位置供武器渲染/枪口计算使用。
   */
  aim?: number | null;
}

/**
 * 火柴人骨骼绘制。
 *
 * 数学基础来自 stick-motion 技能（FK 手臂 + IK 腿 + 足部锁定步态）；
 * 动作表现规范来自 spine-animation 技能：
 * - **关节协调**：躯干/髋/肩有反向旋转（contrapposto），而非整块僵硬摆动
 * - **跟随（follow-through）**：手臂相位滞后于腿，头/躯干滞后于髋
 * - **冲击吸收**：落地时下蹲→恢复，而非弹一下就结束
 * - **预备（anticipation）**：起跳瞬间压缩
 * - 僵硬感的根源不是幅度不够，而是缺少这些层次
 */
export class StickmanRenderer {
  /** 髋部相对原点的 y（站立基准值：腿接近伸直，不半蹲） */
  static readonly HIP_Y = 5;
  /**
   * 行走时髋部额外下降量。
   * 降到刚好让步幅可达（胸盆略降也是真实走路姿态），
   * 但必须足够小——否则走路时会比站立明显变短。当前 5px ≈ 身高 4.7%。
   */
  private static readonly WALK_HIP_DROP = 5;
  /** 肩部相对原点 */
  static readonly SHOULDER_Y = -34;

  private static readonly HEAD_R = RIG_BONES.HEAD_R;
  /** 线宽层次：躯干 > 腿 > 手臂 */
  private static readonly W_TORSO = 7;
  private static readonly W_LEG = 5.5;
  private static readonly W_ARM = 4;

  /**
   * 肩宽半宽（px）：手臂根部相对躯干的固定偏移。
   * 所有姿势必须共用同一值——否则换姿势时手臂会从躯干“脱开”。
   */
  static readonly SHOULDER_W = 3.5;
  /** 手臂根部相对肩部的垂直偏移（固定，避免脱开） */
  static readonly SHOULDER_DY = 1.5;

  /** 手臂总长（上臂 + 前臂）：持枪时手部到肩根的直线距离 */
  static readonly ARM_REACH = RIG_BONES.UPPER_ARM + RIG_BONES.FOREARM;

  /**
   * draw() 的输出：瞄准手臂末端（visual 局部坐标）。
   * 武器渲染与枪口位置必须与手臂末端一致，否则枪会脱手 / 子弹从错位置出。
   * 每次 draw() 开头重置，瞄准时写入。
   */
  static lastAimHand: Vec2 | null = null;

  /** 跟随滞后时长（秒）：末端相对根节点的延迟 */
  private static readonly FOLLOW_LAG = 0.055;

  static draw(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    g.clear();
    this.lastAimHand = null;
    const speedPxPerSec = Math.abs(o.velocityX) * 60;

    // 攻击动作优先（短暂覆盖行走/站立姿势）
    const progress = o.attackProgress ?? 0;
    if (progress > 0) {
      if (o.attackKind === 'kick') {
        this.drawKick(g, o);
        return;
      }
      if (o.attackKind === 'thrust') {
        this.drawThrust(g, o);
        return;
      }
      if (o.attackKind === 'slash') {
        this.drawSlash(g, o);
        return;
      }
      if (o.attackKind === 'punch') {
        this.drawPunch(g, o);
        return;
      }
    }

    switch (o.pose) {
      case 'walk':
        this.drawWalk(g, o, speedPxPerSec);
        break;
      case 'jump':
        this.drawAirborne(g, o, true);
        break;
      case 'fall':
        this.drawAirborne(g, o, false);
        break;
      case 'hit':
        this.drawHit(g, o);
        break;
      case 'crouch':
        this.drawCrouch(g, o);
        break;
      default:
        this.drawIdle(g, o);
    }
  }

  /** 左脚地面 y（含斜向偏移） */
  private static gyL(o: StickmanDrawOptions): number {
    return GROUND_OFFSET + (o.groundYL ?? 0);
  }

  /** 右脚地面 y（含斜向偏移） */
  private static gyR(o: StickmanDrawOptions): number {
    return GROUND_OFFSET + (o.groundYR ?? 0);
  }

  // ---------------- 蹲下 ----------------

  /**
   * 蹲下：深蹲（髋部大幅降低、双脚外展、躯干前倾）。
   * 移动时叠加蹲走小步动画（双腿交替迈步 + 抬脚 + 手臂微摆 + 身体起伏），
   * 而不是固定姿势拖行。
   */
  private static drawCrouch(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    const walking = o.moving;
    const T = 0.44; // 蹲走周期（略快于普通走路）
    const phase = 2 * Math.PI * (o.gaitTime / T);
    const s = Math.sin(phase);

    // 身体起伏：走动时每步一个起伏，静止时轻微呼吸
    const bob = walking ? -Math.abs(s) * 1.8 : Math.sin(o.gaitTime * 1.9) * 0.9;
    // 深蹲：髋部降低（腿伸展约 42%，总高约为站立身高的 76%）
    const hipY = this.HIP_Y + 24 + bob;
    // 走动时重心轻微左右转移
    const hip: Vec2 = { x: walking ? s * 1.6 : 0, y: hipY };

    const gyL = this.gyL(o);
    const gyR = this.gyR(o);

    // 腿：蹲走时双腿交替小步（一前一后 + 抬脚）
    const stepAmp = walking ? 8 : 0;
    const lift = walking ? 6 : 0;
    const footLX = -15 + s * stepAmp;
    const footRX = 15 - s * stepAmp;
    const footLY = gyL - Math.max(0, s) * lift;
    const footRY = gyR - Math.max(0, -s) * lift;
    this.drawLegIK(g, o.color, hip, { x: footLX, y: footLY });
    this.drawLegIK(g, o.color, hip, { x: footRX, y: footRY });

    // 躯干：深蹲前倾明显（leanFactor 越小越前倾）
    const shoulder = this.drawTorso(g, o.color, hip, 45, walking ? s * 2 : 0);  // 深蹲：大幅度前倾（探头蹲伏）
    this.drawHead(g, o.color, shoulder, 45, 1.5);

    // 手臂：**两只手都朝前**（蹲伏时双手在身前），前后错开形成层次，避免贴住倾斜的躯干
    const armSwing = walking ? s * 11 : 0;
    this.drawArmFK(g, o, shoulder, 1, 52 + armSwing, 34);
    this.drawArmFK(g, o, shoulder, -1, 24 + armSwing, 30);
  }

  // ---------------- 站立 ----------------

  /**
   * 站立：呼吸起伏 + 重心轻微左右转移 + 手臂滞后微摆。
   * （spine-animation：避免"处处恒定运动"，但也不能完全静止）
   */
  private static drawIdle(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    const t = o.gaitTime;
    // 呼吸：慢速上下
    const breathe = Math.sin(t * 1.9) * 1.4;
    // 重心转移：更慢的左右微移（不对称节奏，避免机械感）
    const sway = Math.sin(t * 0.9) * 1.6;

    const squat = this.landImpactSquat(o);
    const hip: Vec2 = { x: sway * 0.6, y: this.HIP_Y + breathe + squat };
    const gyL = this.gyL(o) + squat;
    const gyR = this.gyR(o) + squat;

    // 腿：脚踩地（落地冲击时腿弯曲吸收）
    this.drawLegIK(g, o.color, hip, { x: -8 + sway * 0.3, y: gyL });
    this.drawLegIK(g, o.color, hip, { x: 8 + sway * 0.3, y: gyR });

    // 躯干：轻微反向倾斜（重心转移）
    const shoulder = this.drawTorso(g, o.color, hip, Math.abs(sway) * 0.4, -sway * 0.35);
    this.drawHead(g, o.color, shoulder, Math.abs(sway) * 0.4, breathe * 0.4);

    // 手臂：滞后于身体（follow-through）
    const lagSway = Math.sin((t - this.FOLLOW_LAG) * 0.9) * 3;
    this.drawArmFK(g, o, shoulder, 1, 10 - sway + lagSway, 0.32);
    this.drawArmFK(g, o, shoulder, -1, -10 - sway + lagSway, 0.32);
  }

  // ---------------- 近战：突刺 / 挥砍 ----------------

  /**
   * 三段式动作曲线（spine-animation：预备 → 出击 → 跟随/收势）。
   * 返回 -0.35~1 的"发力值"：负值=反向预备，1=打到底。
   *
   * 为什么不用简单的 0→1→0 正弦：正弦没有"蓄力"和"急停"，
   * 读起来像慢悠悠地挥一下，没有打击感。
   */
  private static strikeCurve(p: number, windup = 0.2, strikeEnd = 0.5): number {
    if (p < windup) {
      // 预备：反向蓄力（值到 -0.35）
      const t = p / windup;
      return -0.35 * (1 - Math.pow(1 - t, 2));
    }
    if (p < strikeEnd) {
      // 出击：从 -0.35 冲到 1（先慢后快，冲击段加速）
      const t = (p - windup) / (strikeEnd - windup);
      const e = t * t * (3 - 2 * t);
      return -0.35 + 1.35 * e;
    }
    // 收势：从 1 缓回 0
    const t = (p - strikeEnd) / Math.max(0.01, 1 - strikeEnd);
    return 1 - Math.pow(t, 0.6);
  }

  /**
   * 突刺（匕首/长矛）：**预备 → 弓步突进 → 收势**。
   * 持械的前臂由 aim 覆盖，始终指向准星，所以"刺"的方向与瞄准一致。
   */
  private static drawThrust(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    const p = Math.min(1, Math.max(0, o.attackProgress ?? 0));
    const k = this.strikeCurve(p); // -0.35(蓄力) → 1(打到底) → 0
    const groundY = GROUND_OFFSET;

    // 髋部：蓄力时后坐，出击时前压
    const hip: Vec2 = { x: -3 + 13 * k, y: this.HIP_Y + 3 + 3 * Math.max(0, k) };

    // 前腿弓步迈出；蓄力时后腿略收（重心后压）
    this.drawLegIK(g, o.color, hip, { x: 10 + 18 * k, y: groundY });
    this.drawLegIK(g, o.color, hip, { x: -12 - 12 * Math.max(0, k) + 4 * Math.min(0, k), y: groundY });

    // 躯干：前压（出击）/ 后仰（蓄力）
    const shoulder = this.drawTorso(g, o.color, hip, 6 + 16 * k, 3);
    this.drawHead(g, o.color, shoulder, 8 + 14 * k, 0);

    // 后臂：与出击反向摆动（配重，跟随动作）
    this.drawArmFK(g, o, shoulder, -1, -30 - 34 * k, 30);
    // 前臂（aim 覆盖时会被替换成"指向准星"）
    this.drawArmFK(g, o, shoulder, 1, 60, 8);
  }

  /**
   * 出拳：直拳。
   * 借力链条是"蹬地 → 转腰 → 送肩 → 出拳"，所以画面上要有：
   * 后脚蹬（微抬）→ 肩膀前送（torso twist）→ 前臂直出 → 收拳。
   * 前臂方向由 aim 覆盖（跟着准星），这里负责身体部分的发力。
   */
  private static drawPunch(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    const p = Math.min(1, Math.max(0, o.attackProgress ?? 0));
    const k = this.strikeCurve(p, 0.18, 0.45); // 快速蓄力 → 爆发 → 收
    const groundY = GROUND_OFFSET;

    // 髋部：出拳瞬间前压 + 轻微下沉（重心转移）
    const hip: Vec2 = { x: -2 + 7 * Math.max(0, k), y: this.HIP_Y + 2 + 2 * Math.max(0, k) };

    // 前脚踏实、后脚蹬地（出击时后脚跟抬起 → 用更短的目标点表现）
    this.drawLegIK(g, o.color, hip, { x: 9 + 6 * k, y: groundY });
    this.drawLegIK(g, o.color, hip, { x: -11, y: groundY - 5 * Math.max(0, k) });

    // 转腰送肩：下半身稳住、上半身拧转
    const shoulder = this.drawTorso(g, o.color, hip, 3 + 7 * k, 12 * k);
    this.drawHead(g, o.color, shoulder, 3 + 5 * k, 0);

    // 后臂收紧护脸（与出拳反向，形成配重）
    this.drawArmFK(g, o, shoulder, -1, -14 - 22 * k, 46);
    // 前臂：aim 覆盖时直指准星（直拳）
    this.drawArmFK(g, o, shoulder, 1, 58, 6);
  }

  /**
   * 挥砍（光刀）：双腿开立稳住重心 + 躯干随挥砍扭转。
   * 手臂扫过由 aim + slashOffset 驱动（Player 的 slashSwingCurve 已含预备/出击/收势），
   * 这里让身体跟着走：出击瞬间前倾下沉最明显。
   */
  private static drawSlash(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    const p = Math.min(1, Math.max(0, o.attackProgress ?? 0));
    const power = this.strikeCurve(p, 0.18, 0.55);
    const groundY = GROUND_OFFSET;
    const hip: Vec2 = { x: 2 - 5 * power, y: this.HIP_Y + 4 + 2 * Math.max(0, power) };

    // 双腿开立（发力时前腿吃重，后腿撑住）
    this.drawLegIK(g, o.color, hip, { x: -16 - 4 * Math.max(0, power), y: groundY });
    this.drawLegIK(g, o.color, hip, { x: 16 + 6 * power, y: groundY });

    // 躯干：前倾 + 侧向扭转（跟随挥砍方向）
    const shoulder = this.drawTorso(g, o.color, hip, 6 + 10 * power, -10 * power);
    this.drawHead(g, o.color, shoulder, 7 + 9 * power, 0);

    // 后臂随挥砍甩开
    this.drawArmFK(g, o, shoulder, -1, -16 - 26 * power, 34);
    // 前臂由 aim 覆盖（跟着刀扫）
    this.drawArmFK(g, o, shoulder, 1, 40, 10);
  }

  // ---------------- 踢腿 ----------------

  /**
   * 踢腿：支撑腿站稳，前腿快速向前上方蹬出（前 45% 时间伸出，后 55% 收回），
   * 躯干后仰保持平衡（contrapposto），手臂张开。
   */
  private static drawKick(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    const p = Math.min(1, Math.max(0, o.attackProgress ?? 0));
    // 伸出曲线：0→1 快速，然后收回
    const extend = p < 0.45 ? p / 0.45 : 1 - (p - 0.45) / 0.55;
    const eased = Math.sin(Math.min(1, extend) * Math.PI * 0.5);

    const hip: Vec2 = { x: -2 * eased, y: this.HIP_Y };
    const gyL = this.gyL(o);
    const gyR = this.gyR(o);

    // 支撑腿（后）
    this.drawLegIK(g, o.color, hip, { x: -9 - 3 * eased, y: gyL });
    // 踢出的腿（前）：向前上方
    this.drawLegIK(g, o.color, hip, {
      x: 26 * eased + 6,
      y: gyR - 46 * eased,
    });

    // 躯干后仰
    const shoulder = this.drawTorso(g, o.color, hip, -6 * eased, -3 * eased);
    this.drawHead(g, o.color, shoulder, -6 * eased, 0);

    // 手臂：张开保持平衡（瞄准时仍指向准星）
    this.drawArmFK(g, o, shoulder, 1, 55 + 20 * eased, 18);
    this.drawArmFK(g, o, shoulder, -1, -35 - 25 * eased, 24);
  }

  // ---------------- 行走 ----------------

  /**
   * 行走：确定性步态（足部锁定）+ 关节协调 + 跟随。
   *
   * 步频固定为 WALK.T（不起伏）；但小短腿的可达步幅有限，
   * 若完全按足部锁定要求，脚会超出腿长被 IK 截断。
   * 因此对步幅做**均匀缩放**到可达范围：步频自然，代价是轻微滑步。
   */
  private static drawWalk(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions, speedPxPerSec: number): void {
    const speed = Math.max(70, speedPxPerSec);
    const squat = this.landImpactSquat(o);
    const T = WALK.T; // 固定步频（恢复之前的手感）
    // 倒着走：步态在时间上反向（脚往后迈），躯干改为后仰
    const bw = o.backward === true;
    const t = bw ? -o.gaitTime : o.gaitTime;
    const leanSign = bw ? -1 : 1;

    // 髋部起伏（双步节奏）+ 行走时骨盆略降（让步幅可达，也符合人走路姿态）
    const bounce = -WALK.bounce * Math.abs(Math.sin(2 * Math.PI * (t / T)));
    const hipY = this.HIP_Y + this.WALK_HIP_DROP + bounce + squat;

    // 可达横向步幅：由髋到地面高度与腿长决定
    const hipToGround = GROUND_OFFSET - hipY;
    const reachLimit = Math.sqrt(Math.max(16, LEG_LENGTH * LEG_LENGTH - hipToGround * hipToGround)) * 0.95;
    // 所需幅度 vs 可达幅度 → 均匀缩放，避免脚被 IK 截断而悬空
    const relAmp = speed * T * WALK.duty;
    const strideScale = Math.min(1, reachLimit / Math.max(1, relAmp / 2));

    // 步态：左右腿相差半周期
    const fR = gaitFoot(t, 0, T, WALK.duty, speed, WALK.stepHeight);
    const fL = gaitFoot(t, 0.5, T, WALK.duty, speed, WALK.stepHeight);

    const gyL = this.gyL(o) + squat;
    const gyR = this.gyR(o) + squat;

    // 重心左右转移（幅度小，避免“拖行”感）
    const weightShift = Math.sin(2 * Math.PI * (t / T)) * 1.1;
    const hip: Vec2 = { x: weightShift, y: hipY };

    // 腿：步幅按可达范围缩放；左右脚各用各自的地面高度（斜面贴合）
    this.drawLegIK(g, o.color, hip, { x: fR.relX * strideScale, y: gyR + fR.relY * strideScale });
    this.drawLegIK(g, o.color, hip, { x: fL.relX * strideScale, y: gyL + fL.relY * strideScale });

    // 躯干：前倾（速度相关）+ 髋肩反向旋转（contrapposto）
    const leanT = Math.min(1, Math.abs(speedPxPerSec) / 350);
    const phase = 2 * Math.PI * (t / T);
    const pelvisRot = Math.sin(phase) * 3.1;
    const shoulderRot = -Math.sin(phase) * 4.2;
    const shoulder = this.drawTorso(g, o.color, hip, leanT * 5.6 * leanSign, pelvisRot + shoulderRot);

    // 头：滞后于躯干（overlap）
    const headBob = Math.sin(2 * Math.PI * ((t - this.FOLLOW_LAG) / T)) * 1.6;
    this.drawHead(g, o.color, shoulder, leanT * 5.6 * leanSign, headBob);

    // 手臂：相位**滞后**腿（follow-through），摆幅随速度（不宜过大，否则显得腿没动）
    const armAmp = 17 + leanT * 8;
    const armPhase = 2 * Math.PI * ((t - this.FOLLOW_LAG) / T);
    const swingR = armAmp * Math.sin(armPhase);
    const swingL = -armAmp * Math.sin(armPhase);
    const elbowBase = 12 + leanT * 6;
    this.drawArmFK(g, o, shoulder, 1, swingR, elbowBase + weightShift * 1.5);
    this.drawArmFK(g, o, shoulder, -1, swingL, elbowBase - weightShift * 1.5);
  }

  // ---------------- 空中 ----------------

  /**
   * 空中：上升/顶点/下落的连续变化（不是二态切换）。
   * spine-animation：跳跃应有"起跳 → 空中轨迹 → 冲击吸收 → 稳定"，
   * 而不是"单一垂直正弦波 + 与飞行无关的身体伸展"。
   */
  private static drawAirborne(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions, rising: boolean): void {
    const squat = this.landImpactSquat(o);
    const anticipate = o.jumpAnticipation ?? 0; // 起跳前摇（压缩）
    const vy = Math.abs(o.velocityY);
    // 0 = 顶点（慢），1 = 高速
    const speedT = Math.min(1, vy / 14);

    const hip: Vec2 = { x: 0, y: this.HIP_Y + squat + anticipate * 4 };
    const groundY = GROUND_OFFSET + squat;

    if (rising) {
      // 上升：收腿（速度越快收得越紧 → 与飞行关联）
      const tuck = speedT;
      this.drawLegIK(g, o.color, hip, {
        x: -10 - tuck * 8,
        y: groundY - 12 - tuck * 14,
      });
      this.drawLegIK(g, o.color, hip, {
        x: 10 + tuck * 6,
        y: groundY - 8 - tuck * 10,
      });
      const shoulder = this.drawTorso(g, o.color, hip, tuck * 3, -2);
      this.drawHead(g, o.color, shoulder, tuck * 3, -1.5);
      // 手臂上举（发力），速度越快越靠上
      const armUp = 130 + tuck * 30;
      this.drawArmFK(g, o, shoulder, 1, armUp, -24 + tuck * 10);
      this.drawArmFK(g, o, shoulder, -1, -armUp, -24 + tuck * 10);
    } else {
      // 下落：腿张开准备落地，速度越快张得越开（预示冲击）
      const spread = 10 + speedT * 8;
      this.drawLegIK(g, o.color, hip, { x: -spread, y: groundY - 4 - speedT * 4 });
      this.drawLegIK(g, o.color, hip, { x: spread, y: groundY - 2 - speedT * 2 });
      const shoulder = this.drawTorso(g, o.color, hip, 2 + speedT * 2, -3 - speedT * 3);
      this.drawHead(g, o.color, shoulder, 2 + speedT * 2, 1.5);
      // 手臂张开（平衡/准备触地）
      const armSpread = 100 + speedT * 25;
      this.drawArmFK(g, o, shoulder, 1, armSpread, -14);
      this.drawArmFK(g, o, shoulder, -1, -armSpread, -14);
    }
  }

  // ---------------- 受击 ----------------

  /**
   * 受击：一个**简单的后仰护身**姿势（原实现是四肢按相位乱舞，帧数太多显得杂乱）。
   * 打击感交给顿帧 + 闪白 + 击退位移，姿势本身只需要读得出"被打到了"。
   */
  private static drawHit(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    const squat = this.landImpactSquat(o);
    const hip: Vec2 = { x: -2, y: this.HIP_Y + squat + 2 };
    const groundY = GROUND_OFFSET + squat;

    // 双腿微屈站稳
    this.drawLegIK(g, o.color, hip, { x: -9, y: groundY });
    this.drawLegIK(g, o.color, hip, { x: 6, y: groundY });

    // 躯干后仰 + 头跟着仰
    const shoulder = this.drawTorso(g, o.color, hip, -8, -4);
    this.drawHead(g, o.color, shoulder, -8, 0);

    // 手臂抬起护住正面（瞄准时前臂仍指向准星）
    this.drawArmFK(g, o, shoulder, 1, 32, 28);
    this.drawArmFK(g, o, shoulder, -1, 16, 32);
  }

  // ---------------- 公共部件 ----------------

  /** 落地冲击 → 下蹲深度（先压到底再缓慢恢复） */
  private static landImpactSquat(o: StickmanDrawOptions): number {
    const impact = o.landImpact ?? 0;
    if (impact <= 0) return 0;
    const strength = o.landImpactStrength ?? 0.3;
    // 冲击曲线：快速压到最深，然后缓慢恢复（非对称，符合冲击吸收）
    const depth = 10 * strength;
    return depth * impact * impact;
  }

  /**
   * 躯干（FK up 参考）。
   * @param tiltDeg 前倾角度（度，0 = 垂直向上；正值向面向方向倾斜）
   * @param twistDeg 肩部相对髋的旋转（正 = 朝面向方向转）
   * @returns 肩部位置
   */
  private static drawTorso(
    g: Phaser.GameObjects.Graphics,
    color: number,
    hip: Vec2,
    tiltDeg: number,
    twistDeg = 0,
  ): Vec2 {
    const torsoAngle = tiltDeg + twistDeg * 0.35;
    const v = upVec(torsoAngle, RIG_BONES.TORSO, 1);
    const shoulder = { x: hip.x + v.x, y: hip.y + v.y };
    g.lineStyle(this.W_TORSO, color, 1);
    g.lineBetween(hip.x, hip.y, shoulder.x, shoulder.y);
    return shoulder;
  }

  /**
   * 头部：**沿躯干的倾斜方向**延伸（骨骼链一致），而不是永远垂直。
   * @param tiltDeg 躯干前倾角（度），必须与 drawTorso 传入值一致
   * @param offsetY 额外的纵向微调（呼吸/点头）
   */
  private static drawHead(
    g: Phaser.GameObjects.Graphics,
    color: number,
    shoulder: Vec2,
    tiltDeg = 0,
    offsetY = 0,
  ): void {
    const rad = (tiltDeg * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    // 脖子沿躯干方向
    const neck = {
      x: shoulder.x + sin * RIG_BONES.NECK,
      y: shoulder.y - cos * RIG_BONES.NECK,
    };
    // 头心继续沿同一方向偏移（保持骨骼链笔直）
    const headX = neck.x + sin * this.HEAD_R * 0.75;
    const headY = neck.y - cos * this.HEAD_R * 0.75 + offsetY;
    g.fillStyle(color, 1);
    g.fillCircle(headX, headY, this.HEAD_R);
  }

  /** 腿部 IK（足部目标点 → 绝对到达；若目标超出腿长则钳制，避免肢体被拉断） */
  private static drawLegIK(
    g: Phaser.GameObjects.Graphics,
    color: number,
    hip: Vec2,
    footTarget: Vec2,
  ): void {
    // 目标超出可达范围时收回到可达圆上（否则脚会悬空在目标外的实际上）
    const dx = footTarget.x - hip.x;
    const dy = footTarget.y - hip.y;
    const dist = Math.hypot(dx, dy);
    const maxD = RIG_BONES.THIGH + RIG_BONES.SHIN - 0.5;
    let tx = footTarget.x;
    let ty = footTarget.y;
    if (dist > maxD) {
      const k = maxD / dist;
      tx = hip.x + dx * k;
      ty = hip.y + dy * k;
    }
    const { thighAngle, kneeBend } = solveLegIK(hip.x, hip.y, tx, ty, 1);
    const { joint, end } = chain2(
      hip.x,
      hip.y,
      thighAngle,
      RIG_BONES.THIGH,
      kneeBend,
      RIG_BONES.SHIN,
      1,
      'down',
    );
    g.lineStyle(this.W_LEG, color, 1);
    g.lineBetween(hip.x, hip.y, joint.x, joint.y);
    g.lineBetween(joint.x, joint.y, end.x, end.y);
    g.fillStyle(color, 1);
    g.fillCircle(joint.x, joint.y, 2.4);
  }

  /**
   * 手臂 FK（肩角 + 肘相对弯曲）。
   * @param side 1 = 左臂 / -1 = 右臂；根据固定肩宽计算根部位置（保证不脱离躯干）
   * @param shoulderAngle 肩部绝对角（down 参考，正 = 向前）
   * @param elbowBendDeg 肘相对弯曲（度）
   */
  private static drawArmFK(
    g: Phaser.GameObjects.Graphics,
    o: StickmanDrawOptions,
    shoulder: Vec2,
    side: 1 | -1,
    shoulderAngle: number,
    elbowBendDeg: number,
  ): void {
    // 持枪瞄准：前臂（side=1）指向瞄准方向，肘部伸直
    if (o.aim != null && side === 1) {
      /**
       * 这里的角度必须换算掉 facing：
       * 下面 chain2 固定传 facing=1（局部坐标），而外层 visual 又按 facing 翻转，
       * 所以世界方向 = (facing * sinθ, cosθ)。要让世界方向 = (cosφ, sinφ)：
       *   sinθ = facing·cosφ ，cosθ = sinφ  →  θ = atan2(facing·cosφ, sinφ)
       * （facing=1 时化简为 90°−φ，与原实现一致；facing=-1 时才是正确的镜像）
       */
      const facing = o.facing ?? 1;
      shoulderAngle = (Math.atan2(facing * Math.cos(o.aim), Math.sin(o.aim)) * 180) / Math.PI;
      elbowBendDeg = 0;
    }
    // 根部位置：固定肩宽 + 固定垂直偏移 → 任何姿势下手臂都连在躯干上
    const rootX = shoulder.x + side * this.SHOULDER_W;
    const rootY = shoulder.y + this.SHOULDER_DY;
    const { joint, end } = chain2(
      rootX,
      rootY,
      shoulderAngle,
      RIG_BONES.UPPER_ARM,
      elbowBendDeg,
      RIG_BONES.FOREARM,
      1,
      'down',
    );
    g.lineStyle(this.W_ARM, o.color, 1);
    g.lineBetween(rootX, rootY, joint.x, joint.y);
    g.lineBetween(joint.x, joint.y, end.x, end.y);
    g.fillStyle(o.color, 1);
    g.fillCircle(joint.x, joint.y, 2.1);

    // 瞄准时输出手部位置（供武器渲染与枪口计算）
    if (o.aim != null && side === 1) {
      this.lastAimHand = { x: end.x, y: end.y };
    }
  }
}
