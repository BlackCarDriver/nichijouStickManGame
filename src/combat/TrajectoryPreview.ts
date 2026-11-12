import Phaser from 'phaser';
import { PROJECTILE_GRAVITY } from './WeaponFormat';
import { raycast, getWorldBodies } from './Raycast';
import { parseColor } from '../config/materials';

interface Vec2 {
  x: number;
  y: number;
}

export interface PreviewPath {
  points: Vec2[];
  /** 第一次接触点（null = 一直飞到射程尽头） */
  hit: Vec2 | null;
}

/**
 * 抛物线预览（"蚂蚁线"）—— 投掷类共用（手榴弹、匕首/长矛投掷）。
 *
 * 用与真实投掷物**同一套**重力与射线步进做模拟，所以"看到的落点 = 实际落点"。
 * 只模拟到**第一次接触**为止（不模拟弹跳），读起来更清楚。
 *
 * 蚂蚁线 = 沿路径等距点 + 随时间滚动的相位。
 */
export class TrajectoryPreview {
  private readonly scene: Phaser.Scene;
  private readonly g: Phaser.GameObjects.Graphics;
  private time = 0;

  private static readonly DOT_SPACING = 17;
  private static readonly DOT_SCROLL = 55;
  private static readonly SIM_DT = 1 / 60;
  private static readonly SIM_MAX_STEPS = 240;

  constructor(scene: Phaser.Scene, depth = 828) {
    this.scene = scene;
    this.g = scene.add.graphics();
    this.g.setDepth(depth);
  }

  /** 推进蚂蚁线动画相位 */
  tick(deltaMs: number): void {
    this.time += deltaMs / 1000;
  }

  /** 清空上一帧的绘制 */
  clear(): void {
    this.g.clear();
  }

  /** 模拟一段抛物线弹道 */
  compute(
    from: Vec2,
    aim: number,
    speed: number,
    range: number,
    ignore: Array<MatterJS.BodyType | undefined | null>,
  ): PreviewPath {
    const bodies = getWorldBodies(this.scene);
    let x = from.x;
    let y = from.y;
    let vx = Math.cos(aim) * speed;
    let vy = Math.sin(aim) * speed;
    let traveled = 0;

    const points: Vec2[] = [{ x, y }];

    for (let i = 0; i < TrajectoryPreview.SIM_MAX_STEPS; i++) {
      vy += PROJECTILE_GRAVITY * TrajectoryPreview.SIM_DT;
      const nx = x + vx * TrajectoryPreview.SIM_DT;
      const ny = y + vy * TrajectoryPreview.SIM_DT;
      const stepLen = Math.hypot(nx - x, ny - y);
      if (stepLen < 1e-4) break;

      const hits = raycast(
        bodies,
        { x, y },
        { x: (nx - x) / stepLen, y: (ny - y) / stepLen },
        stepLen,
        { ignore, maxHits: 1 },
      );
      if (hits[0]) {
        points.push(hits[0].point);
        return { points, hit: hits[0].point };
      }

      x = nx;
      y = ny;
      traveled += stepLen;
      points.push({ x, y });
      if (traveled >= range) break;
    }

    return { points, hit: null };
  }

  /** 画出预览（不清空，调用方先 clear()，便于一次画多条） */
  drawPath(path: PreviewPath, colorHex: string, alpha = 1): void {
    const color = parseColor(colorHex, 0x8fd06a);
    const scroll = (this.time * TrajectoryPreview.DOT_SCROLL) % TrajectoryPreview.DOT_SPACING;

    let nextDot = scroll;
    let accumulated = 0;

    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1];
      const b = path.points[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-4) continue;

      while (nextDot <= accumulated + segLen) {
        const t = (nextDot - accumulated) / segLen;
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        this.g.fillStyle(0xffffff, 0.5 * alpha);
        this.g.fillCircle(px, py, 1.9);
        this.g.fillStyle(color, 0.28 * alpha);
        this.g.fillCircle(px, py, 4.2);
        nextDot += TrajectoryPreview.DOT_SPACING;
      }
      accumulated += segLen;
    }

    if (path.hit) {
      this.g.lineStyle(2, color, 0.85 * alpha);
      this.g.strokeCircle(path.hit.x, path.hit.y, 9);
      this.g.lineStyle(1.5, 0xffffff, 0.6 * alpha);
      this.g.lineBetween(path.hit.x - 13, path.hit.y, path.hit.x + 13, path.hit.y);
      this.g.lineBetween(path.hit.x, path.hit.y - 13, path.hit.x, path.hit.y + 13);
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
