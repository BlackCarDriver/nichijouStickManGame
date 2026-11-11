import Phaser from 'phaser';

/** squash & stretch 目标的最小接口（Graphics/Container 都满足） */
interface Scalable {
  scene: Phaser.Scene;
  setScale(x: number, y: number): void;
}

/**
 * 游戏手感工具（game-feel 技能驱动）：
 * - trauma 屏幕震动模型：shake = trauma²（小冲击几乎不动，大冲击震得明显），
 *   sin 噪声驱动（平滑、自终止，而非每帧随机——随机会像静电一样嗡嗡响）
 * - squash & stretch：事件瞬间挤压 + 缓动回弹（overshoot）
 * - 供事件钩子调用（落地/跳跃/受击/拾取），反馈要短暂且回到静止
 */
export class GameFeel {
  /** 震动衰减速度（trauma 每秒损失） */
  private static readonly SHAKE_DECAY = 1.2;
  /** 最大震动偏移（像素） */
  private static readonly MAX_OFFSET_X = 14;
  private static readonly MAX_OFFSET_Y = 9;
  /** 最大震动旋转（弧度） */
  private static readonly MAX_ROLL = 0.05;
  /** 震动噪声相位 */
  private shakeTime = 0;
  /** 当前 trauma 0~1 */
  private trauma = 0;

  /**
   * 每帧调用：计算屏幕震动偏移，写入 cameraRig.shakeOffset（跟随之上叠加）。
   * @param camera 相机（用于 roll 旋转）
   * @param shakeOffset 外部持有的偏移向量（CameraRig 提供）
   * @param dtMs 帧间隔毫秒
   */
  update(camera: Phaser.Cameras.Scene2D.Camera, shakeOffset: Phaser.Math.Vector2, dtMs: number): void {
    if (this.trauma <= 0) {
      if (shakeOffset.lengthSq() > 0) shakeOffset.set(0, 0);
      return;
    }
    const dt = dtMs / 1000;
    this.trauma = Math.max(0, this.trauma - GameFeel.SHAKE_DECAY * dt);
    const shake = this.trauma * this.trauma; // 二次方：小冲击柔和，大冲击锋利
    this.shakeTime += dt * 30;

    // 平滑伪随机：sin 采样，不是每帧 Math.random（会嗡嗡响）
    shakeOffset.set(
      GameFeel.MAX_OFFSET_X * shake * Math.sin(this.shakeTime * 1.7),
      GameFeel.MAX_OFFSET_Y * shake * Math.sin(this.shakeTime * 2.3),
    );
    camera.setRotation(GameFeel.MAX_ROLL * shake * Math.sin(this.shakeTime * 1.1));
  }

  /** 添加震动（受击/爆炸/踢飞调用；多次命中累加，不重置） */
  addTrauma(amount: number): void {
    this.trauma = Phaser.Math.Clamp(this.trauma + amount, 0, 1);
  }

  /**
   * 事件瞬间的 squash & stretch：缩放 + 缓动回弹（TRANS_BACK 过冲）。
   * @param target 要挤压的游戏对象（Player 的 graphics 等；面向翻转在 visual 上不冲突）
   * @param scaleX 瞬时横向缩放
   * @param scaleY 瞬时纵向缩放
   * @param durationMs 回弹时长
   */
  static pop(target: Scalable, scaleX: number, scaleY: number, durationMs = 180): void {
    const scene = target.scene;
    // 事件瞬间挤压
    target.setScale(scaleX, scaleY);
    // 缓动回弹（BACK 过冲后稳定），比线性更"有生命力"
    scene.tweens.add({
      targets: target,
      scaleX: 1,
      scaleY: 1,
      duration: durationMs,
      ease: 'Back.easeOut',
    });
  }
}
