import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getRenderScale } from '../config/display';

/**
 * 镜头系统（camera-systems 技能驱动）：
 * - 帧率无关的指数平滑跟随（1 - exp(-rate*dt)，而非固定 lerp）
 * - look-ahead 预判：镜头朝移动/面向方向提前偏移，跳跃时向上升方向看
 * - 边界 clamp：镜头视图（含视口半宽）不越出地图，且在边界平滑停住
 * - 屏幕震动钩子：由 game-feel 的 trauma 模型写入 offset（预留）
 *
 * 独立类：M6 联机时每个玩家可各自持有一个 rig，或在多目标间切换。
 */
export class CameraRig {
  /** 平滑速率：越高跟随越紧，越低越飘（推荐 5~12） */
  private static readonly FOLLOW_RATE = 6;
  /** 预判距离：镜头提前看向运动方向 */
  private static readonly LOOK_AHEAD_DIST = 70;
  /** 垂直预判：平台跳跃类镜头向上升方向看（lead the jump） */
  private static readonly LOOK_AHEAD_VERTICAL = 40;
  /** 预判缓入速率（避免急甩） */
  private static readonly LOOK_EASE_RATE = 8;
  /** 镜头当前位置（平滑后的焦点，独立于目标，避免抖动） */
  private readonly focus = new Phaser.Math.Vector2();
  /** 当前 look-ahead 偏移（ease in/out） */
  private readonly leadOffset = new Phaser.Math.Vector2();
  /** 目标是否已初始化（首帧直接跳到位，不做平滑） */
  private initialized = false;
  /** 屏幕震动偏移（game-feel 写入，跟随之上叠加） */
  readonly shakeOffset = new Phaser.Math.Vector2();
  /** 目标缩放（按武器切换），每帧平滑逼近 */
  private zoomTarget: number;
  /** 变焦速率：越大切换越快（约 0.25s 收敛） */
  private static readonly ZOOM_RATE = 5.5;

  constructor(
    private readonly camera: Phaser.Cameras.Scene2D.Camera,
    private readonly mapWidth: number,
    private readonly mapHeight: number,
    zoom: number,
  ) {
    this.zoomTarget = zoom;
    camera.setZoom(zoom);
  }

  /**
   * 渲染分辨率变化（性能降级）时调用：相机 zoom 同比缩放，
   * 保证"看到的世界范围"完全不变，只是画布像素变少。
   */
  rescale(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.zoomTarget *= factor;
    this.camera.setZoom(this.camera.zoom * factor);
  }

  /** 设置目标缩放（武器切换时调用）；镜头会平滑过渡，不会瞬跳 */
  setZoomTarget(zoom: number): void {
    const k = getRenderScale();
    this.zoomTarget = Phaser.Math.Clamp(zoom, 0.4 * k, 2.2 * k);
  }

  /** 每帧更新：目标玩家位置 → 平滑跟随 + 预判 + 边界 clamp + 震动叠加 */
  update(target: Player, dtMs: number): void {
    const dt = dtMs / 1000;
    const t = 1 - Math.exp(-CameraRig.FOLLOW_RATE * dt); // 帧率无关的指数平滑

    // 目标原始位置
    const targetX = target.container.x;
    const targetY = target.container.y;

    // 首帧直接到位，避免开场镜头横穿地图
    if (!this.initialized) {
      this.focus.set(targetX, targetY);
      this.initialized = true;
    }

    // look-ahead：朝移动方向预判；面向优先（idle 时看向面向方向）
    const facing = target.facing;
    const vx = target.body.velocity.x;
    const vy = target.body.velocity.y;
    // 移动方向（无速度时用面向）
    const dirX = Math.abs(vx) > 20 ? Math.sign(vx) : facing;
    // 垂直：上升时镜头向上看（lead the jump），下落时回中
    const dirY = vy < -30 ? -1 : 0;

    const leadX = dirX * CameraRig.LOOK_AHEAD_DIST;
    const leadY = dirY * CameraRig.LOOK_AHEAD_VERTICAL;

    // 预判缓入/缓出（避免急甩）
    const le = 1 - Math.exp(-CameraRig.LOOK_EASE_RATE * dt);
    this.leadOffset.x += (leadX - this.leadOffset.x) * le;
    this.leadOffset.y += (leadY - this.leadOffset.y) * le;

    // 平滑跟随（目标 + 预判）
    this.focus.x += (targetX + this.leadOffset.x - this.focus.x) * t;
    this.focus.y += (targetY + this.leadOffset.y - this.focus.y) * t;

    // 变焦：按当前武器平滑逼近目标缩放（狙击拉远 / 近战拉近）
    const zoomNow = this.camera.zoom;
    const zt = 1 - Math.exp(-CameraRig.ZOOM_RATE * dt);
    const zNext = Phaser.Math.Linear(zoomNow, this.zoomTarget, zt);
    if (Math.abs(zNext - zoomNow) > 0.0004) this.camera.setZoom(zNext);
    const zoomView = Math.abs(zNext - zoomNow) > 0.0004 ? zNext : zoomNow;

    // 边界 clamp：视口（半宽/半高）不越出地图
    const viewW = this.camera.width / zoomView;
    const viewH = this.camera.height / zoomView;
    const halfW = viewW / 2;
    const halfH = viewH / 2;
    const minX = halfW;
    const maxX = Math.max(halfW, this.mapWidth - halfW);
    const minY = halfH;
    const maxY = Math.max(halfH, this.mapHeight - halfH);
    const clampedX = Phaser.Math.Clamp(this.focus.x, minX, maxX);
    const clampedY = Phaser.Math.Clamp(this.focus.y, minY, maxY);

    // 屏幕震动叠加（跟随之上，不会"打架"——camera-systems 明确要求）
    this.camera.centerOn(
      clampedX + this.shakeOffset.x,
      clampedY + this.shakeOffset.y,
    );
  }

  /** 传送/重生后调用：立即复位焦点，避免平滑横穿地图（camera-systems 明确要求） */
  snapTo(x: number, y: number): void {
    this.focus.set(x, y);
    this.leadOffset.set(0, 0);
    this.initialized = true;
    this.camera.centerOn(x, y);
  }
}
