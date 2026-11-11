/**
 * 火柴人关节骨架（移植自 stick-motion 技能的核心数学）。
 *
 * 设计原则（技能强制规则）：
 * 1. 骨骼长度固定，只有角度/足部目标变化 → 不可能画出解剖学错误的肢体
 * 2. 腿用「足部目标点 + IK 求解」，不用原始膝角 → 脚不可能浮空/穿地
 * 3. 走路循环用确定性步态函数（gaitFoot）→ 支撑脚在世界空间静止，不滑步
 *
 * 角度约定（度）：
 * - down 参考（手臂/腿）：0 = 垂直向下，+90 = 朝向 +X（面向方向）
 * - up 参考（躯干/颈）：0 = 垂直向上
 * - 肘/膝弯曲是相对父骨骼的角度（子绝对角 = 父绝对角 + 弯曲）
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface Vec2 {
  x: number;
  y: number;
}

/** 骨骼比例（单位 = 头半径）。总高约 106px，脚底对齐碰撞体底部（+48） */
export const RIG_BONES = {
  HEAD_R: 12,
  NECK: 12 * 0.35,
  TORSO: 12 * 3.1,
  UPPER_ARM: 12 * 1.55,
  FOREARM: 12 * 1.4,
  THIGH: 12 * 1.9,
  SHIN: 12 * 1.85,
  FOOT: 12 * 0.85,
} as const;

/** 腿总长（髋 → 踝） */
export const LEG_LENGTH = RIG_BONES.THIGH + RIG_BONES.SHIN;

/** 脚底到原点的目标 y（与碰撞体半高对齐，保证脚踩在地面视觉位置） */
export const GROUND_OFFSET = 48;

/**
 * 膝盖弯曲方向。取 -1 使膝盖朝面向方向（前方）弯曲：
 * 站立时膝略向前（人的膝盖不会被“反折”到身后），迈步时膝盖领前。
 * IK 有两个对称解，两者都能精确到达目标，kneeSign 只决定膝盖偏向哪侧。
 */
export const KNEE_SIGN = -1;

/** down 参考：0 = 垂直向下 */
export function downVec(angleDeg: number, len: number, facing: 1 | -1): Vec2 {
  const a = angleDeg * D2R;
  return { x: facing * len * Math.sin(a), y: len * Math.cos(a) };
}

/** up 参考：0 = 垂直向上 */
export function upVec(angleDeg: number, len: number, facing: 1 | -1): Vec2 {
  const a = angleDeg * D2R;
  return { x: facing * len * Math.sin(a), y: -len * Math.cos(a) };
}

/**
 * 两骨骼解析 IK（腿）。
 * 给定髋位置与踝目标点，返回满足目标的大腿绝对角与相对膝弯曲。
 *
 * 注意 kneeSign 必须**减去**（不是加），否则膝盖会朝反方向折叠
 * （技能明确记录的坑：公式仍能跑，但姿势会变成"折起的娃娃"）。
 */
export function solveLegIK(
  hipX: number,
  hipY: number,
  footX: number,
  footY: number,
  facing: 1 | -1,
  L1 = RIG_BONES.THIGH,
  L2 = RIG_BONES.SHIN,
  kneeSign = KNEE_SIGN,
): { thighAngle: number; kneeBend: number } {
  const dx = (footX - hipX) * facing;
  const dy = footY - hipY;
  let d = Math.hypot(dx, dy);
  const maxD = L1 + L2 - 0.01;
  const minD = Math.abs(L1 - L2) + 0.5;
  d = Math.min(Math.max(d, minD), maxD);

  const angleToFoot = Math.atan2(dx, dy); // down 参考角（弧度）
  const cosB = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
  const B = Math.acos(Math.min(1, Math.max(-1, cosB)));
  const cosC = (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2);
  const C = Math.acos(Math.min(1, Math.max(-1, cosC)));

  // B 是髋处"髋→目标线"与大腿的夹角，必须减去（见上方注释）
  const thighAngle = (angleToFoot - kneeSign * B) * R2D;
  const kneeBend = kneeSign * (Math.PI - C) * R2D;
  return { thighAngle, kneeBend };
}

/**
 * 两骨骼 FK 链：给定根、第一节骨角度与长度、第二节相对弯曲与长度，
 * 返回关节（肘/膝）与末端（手/脚）的世界坐标。也用于手臂。
 */
export function chain2(
  rootX: number,
  rootY: number,
  angle1Deg: number,
  len1: number,
  bend2Deg: number,
  len2: number,
  facing: 1 | -1,
  ref: 'down' | 'up' = 'down',
): { joint: Vec2; end: Vec2 } {
  const v = ref === 'down' ? downVec : upVec;
  const p1 = v(angle1Deg, len1, facing);
  const joint = { x: rootX + p1.x, y: rootY + p1.y };
  const angle2 = angle1Deg + bend2Deg;
  const p2 = v(angle2, len2, facing);
  const end = { x: joint.x + p2.x, y: joint.y + p2.y };
  return { joint, end };
}

// ================= 步态（确定性足部锁定） =================

export const WALK: { T: number; duty: number; speed: number; stepHeight: number; bounce: number } = {
  /** 一个步态周期时长（秒）。0.5 = 2Hz，步频适中且步幅需求小 */
  T: 0.45,
  /** 支撑相占比（0.62 ≈ 走路） */
  duty: 0.62,
  /** 移动速度（px/秒）；必须与实际移动速度一致，否则足部锁定失效 */
  speed: 192,
  /** 抬脚高度（px）：小短腿用小抬脚 */
  stepHeight: 10,
  /** 髋部起伏（纯视觉，不影响足部锁定） */
  bounce: 2,
};

export interface FootGait {
  /** 相对髋的水平偏移 */
  relX: number;
  /** 相对地面的 Y（0 = 在地面，负 = 抬起） */
  relY: number;
  /** 周期内相位 0..1 */
  phi: number;
  /** 是否处于摆动相（脚离地） */
  swinging: boolean;
}

/**
 * 足部步态（纯函数，无状态、无随机）：
 * 支撑相脚在世界空间保持静止（不滑步），摆动相沿弧线前摆。
 *
 * 数学保证：支撑相 relX 以 speed 的速率线性后退，而髋部以 speed 前进，
 * 两者相加 = 0 → 脚在世界空间不动。这是代数保证，不是调参。
 *
 * @param t 已走路时间（秒）
 * @param phaseOffset 相位偏移（左右腿相差 0.5）
 */
export function gaitFoot(
  t: number,
  phaseOffset: number,
  T = WALK.T,
  duty = WALK.duty,
  speed = WALK.speed,
  stepHeight = WALK.stepHeight,
): FootGait {
  const phi = (((t / T + phaseOffset) % 1) + 1) % 1;
  const relAmp = speed * T * duty; // 一个支撑相内髋部前进的距离
  let relX: number;
  let relY: number;
  const swinging = phi >= duty;

  if (!swinging) {
    const u = phi / duty; // 支撑相 0..1
    relX = relAmp / 2 - relAmp * u;
    relY = 0;
  } else {
    const u = (phi - duty) / (1 - duty); // 摆动相 0..1
    const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // easeInOutQuad
    relX = -relAmp / 2 + relAmp * eased;
    relY = -stepHeight * Math.sin(Math.PI * u); // 抬起再落下
  }

  return { relX, relY, phi, swinging };
}

/** 平滑插值（用于姿态过渡，避免姿势跳变） */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}
