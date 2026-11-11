import Phaser from 'phaser';

/** 火柴人姿势状态（动画状态机） */
export type StickmanPose = 'idle' | 'walk' | 'jump' | 'fall' | 'hit';

export interface StickmanDrawOptions {
  color: number;
  /** 动画相位（walk/hit 共用，推进速度不同） */
  phase: number;
  pose: StickmanPose;
  moving: boolean;
  grounded: boolean;
  /** 受击乱舞强度 0~1（hit 状态用） */
  hitIntensity: number;
  /** 受击乱舞相位（快速变化） */
  hitPhase: number;
}

/**
 * 火柴人骨骼绘制（动画与物理混合驱动：主体物理由 Matter 负责，姿态由本渲染器程序化绘制）。
 * 坐标系原点 = 碰撞体中心（脚底 y=+48，头顶 y≈-63）。
 * - 面向：外层 Container 的 scaleX 控制
 * - 倾斜/旋转：外层 Container 的 rotation 控制（受击乱飞）
 */
export class StickmanRenderer {
  static readonly HEAD_R = 11;
  static readonly SHOULDER_Y = -40;
  static readonly HIP_Y = -12;
  static readonly FOOT_Y = 48;

  // 腿：两段（大腿 30 + 小腿 30 = 60，站立时髋→脚正好 +60）
  static readonly THIGH_L = 30;
  static readonly SHIN_L = 30;
  // 臂：两段（上臂 13 + 前臂 12，手自然下垂到 y≈-15）
  static readonly UPPER_ARM_L = 13;
  static readonly FOREARM_L = 12;

  static draw(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    g.clear();
    g.lineStyle(4, o.color, 1);

    switch (o.pose) {
      case 'walk':
        this.drawWalk(g, o);
        break;
      case 'jump':
        this.drawJump(g);
        break;
      case 'fall':
        this.drawFall(g);
        break;
      case 'hit':
        this.drawHit(g, o);
        break;
      default:
        this.drawIdle(g);
    }

    // 头（idle 状态头固定；walk 状态头随身体起伏由 drawWalk 重绘）
    if (o.pose !== 'walk') {
      g.fillStyle(o.color, 1);
      g.fillCircle(0, -52, this.HEAD_R);
    }
  }

  /** 站立：腿微分开直立，手臂自然下垂 */
  private static drawIdle(g: Phaser.GameObjects.Graphics): void {
    g.lineBetween(0, this.SHOULDER_Y, 0, this.HIP_Y);
    // 腿
    g.lineBetween(0, this.HIP_Y, -9, this.FOOT_Y);
    g.lineBetween(0, this.HIP_Y, 9, this.FOOT_Y);
    // 手臂（自然下垂，肘微弯）
    this.arm(g, 0, this.SHOULDER_Y, 0, 0.12, 0.2);
    this.arm(g, 0, this.SHOULDER_Y, 0, 0.12, -0.2);
  }

  /**
   * 行走：膝盖弯曲迈步 + 身体起伏（bob）+ 前倾 + 手臂反向摆动。
   * 相比旧版（直腿均匀摆动），本版更像"人走路"。
   */
  private static drawWalk(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    const ph = o.phase;
    // 身体起伏：每步一个起伏（双步节奏）
    const bob = -Math.abs(Math.sin(ph)) * 3.5;
    // 前倾（朝 facing 方向，幅度较小保持简洁）
    const lean = 3;
    const shY = this.SHOULDER_Y + bob;
    const hiY = this.HIP_Y + bob;

    // 身体（肩比髋略前倾）
    g.lineBetween(lean, shY, 0, hiY);

    // 腿：两段（髋→膝→脚），摆动腿抬膝弯曲
    this.leg(g, 0, hiY, ph, 0, 0.5, 0.85);
    this.leg(g, 0, hiY, ph, Math.PI, 0.5, 0.85);

    // 手臂：与同侧腿反相摆动，带肘关节
    this.arm(g, lean, shY, ph + Math.PI, 0, 0.4);
    this.arm(g, lean, shY, ph + Math.PI, Math.PI, 0.4);

    // 头（随身体起伏）
    g.fillStyle(o.color, 1);
    g.fillCircle(lean, -52 + bob, this.HEAD_R);
  }

  /** 上升：腿并拢弯曲，双手上举（发力感） */
  private static drawJump(g: Phaser.GameObjects.Graphics): void {
    g.lineBetween(0, this.SHOULDER_Y, 0, this.HIP_Y);
    // 腿并拢弯曲
    g.lineBetween(0, this.HIP_Y, -5, 38);
    g.lineBetween(0, this.HIP_Y, 5, 38);
    // 手臂上举
    g.lineBetween(0, this.SHOULDER_Y, -13, -44);
    g.lineBetween(0, this.SHOULDER_Y, 13, -44);
  }

  /** 下落：腿微张，手臂张开（像跳伞，有下坠感） */
  private static drawFall(g: Phaser.GameObjects.Graphics): void {
    g.lineBetween(0, this.SHOULDER_Y, 0, this.HIP_Y);
    g.lineBetween(0, this.HIP_Y, -11, 44);
    g.lineBetween(0, this.HIP_Y, 11, 44);
    g.lineBetween(0, this.SHOULDER_Y, -23, -32);
    g.lineBetween(0, this.SHOULDER_Y, 23, -32);
  }

  /**
   * 受击乱舞：四肢大幅快速摆动（配合外层 Container 旋转 = 身体旋转），
   * 模拟"短暂物理乱飞"的视觉效果（主体位移仍由 Matter 物理驱动）。
   */
  private static drawHit(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    const ph = o.hitPhase;
    // 身体弓起（受击反应）
    g.lineBetween(0, this.SHOULDER_Y, 0, this.HIP_Y);
    // 四肢乱舞：大幅摆动 + 快速相位
    this.leg(g, 0, this.HIP_Y, ph, 0, 1.0, 1.4);
    this.leg(g, 0, this.HIP_Y, ph, Math.PI, 1.0, 1.4);
    this.arm(g, 0, this.SHOULDER_Y, ph, 0, 0.9);
    this.arm(g, 0, this.SHOULDER_Y, ph, Math.PI, 0.9);
  }

  /**
   * 两段腿（髋→膝→脚）。
   * @param amp 大腿摆角幅度（walk≈0.5，hit≈1.0）
   * @param kneeAmp 膝弯曲幅度（摆动腿抬膝）
   */
  private static leg(
    g: Phaser.GameObjects.Graphics,
    hipX: number,
    hipY: number,
    phase: number,
    side: number,
    amp: number,
    kneeAmp: number,
  ): void {
    const thigh = Math.sin(phase + side) * amp;
    const kneeX = hipX + Math.sin(thigh) * this.THIGH_L;
    const kneeY = hipY + Math.cos(thigh) * this.THIGH_L;
    // 膝弯曲：摆动腿抬起时弯曲（脚离地），支撑腿伸直
    const bend = Math.max(0, Math.sin(phase + side)) * kneeAmp;
    const shin = thigh + bend;
    const footX = kneeX + Math.sin(shin) * this.SHIN_L;
    const footY = kneeY + Math.cos(shin) * this.SHIN_L;
    g.lineBetween(hipX, hipY, kneeX, kneeY);
    g.lineBetween(kneeX, kneeY, footX, footY);
  }

  /** 两段手臂（肩→肘→手），带轻微肘弯 */
  private static arm(
    g: Phaser.GameObjects.Graphics,
    shoulderX: number,
    shoulderY: number,
    phase: number,
    side: number,
    amp: number,
  ): void {
    const swing = Math.sin(phase + side) * amp;
    const elbowX = shoulderX + Math.sin(swing) * this.UPPER_ARM_L;
    const elbowY = shoulderY + Math.cos(swing) * this.UPPER_ARM_L;
    const fore = swing + 0.15;
    const handX = elbowX + Math.sin(fore) * this.FOREARM_L;
    const handY = elbowY + Math.cos(fore) * this.FOREARM_L;
    g.lineBetween(shoulderX, shoulderY, elbowX, elbowY);
    g.lineBetween(elbowX, elbowY, handX, handY);
  }
}
