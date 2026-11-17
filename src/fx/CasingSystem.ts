import Phaser from 'phaser';
import { getWorldBodies, raycast } from '../combat/Raycast';

/**
 * 抛壳特效（**纯视觉**，不参与物理）。
 *
 * 为什么不建 Matter 刚体：机枪 12 发/秒，按住 3 秒就是 36 个刚体，
 * 还要注册进 WorldRegistry、参与每帧碰撞、联机同步 —— 为一个"壳"完全不合算。
 * 这里沿用 FxSystem 的思路：**池化数组 + 单个 Graphics 每帧重画**，
 * 每发只做「重力 → 落地一次小反弹 → 旋转减速 → 静止 → 淡出」，
 * 落地高度用**出生时向下的一条射线**确定（每发一条，不产生任何物理体）。
 *
 * 深度放在世界物之上、玩家之下（玩家默认 depth 0，地图 -1/-2）：
 * 弹壳落在角色身后，不会盖住火柴人。
 */
export interface CasingSpawnOptions {
  /** 抛壳口（世界坐标） */
  x: number;
  y: number;
  /** 枪管"上侧"单位向量：弹壳往这一侧抛 */
  outX: number;
  outY: number;
  /** 枪管方向（用于往回飘一点，符合"壳往后飞"的观感） */
  backX: number;
  backY: number;
  color: number;
  /** 弹壳长度（px，沿旋转轴） */
  length: number;
  /** 弹壳宽度（px） */
  width: number;
  /** 初速（px/帧，16.7ms 一帧）；不填 = 5 */
  speed?: number;
  /** 需要忽略的刚体（射手自己，否则射线会打到自己的手臂） */
  ignoreBody?: MatterJS.BodyType | null;
}

interface Casing {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  /** 落地高度（负数/Infinity = 下方没有地面，直接掉出屏幕） */
  groundY: number;
  /** 已经弹过一次：下一次触地就静止 */
  bounced: boolean;
  /** 已静止在落点上（开始倒计时淡出） */
  landed: boolean;
  /** 静止后的剩余存活时间（ms） */
  restMs: number;
  length: number;
  width: number;
  color: number;
}

export class CasingSystem {
  private readonly scene: Phaser.Scene;
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly casings: Casing[] = [];

  /** 同屏弹壳上限（超出后复用最老的） */
  private static readonly MAX_CASINGS = 90;
  /** 重力（px/帧²） */
  private static readonly GRAVITY = 0.42;
  /** 落地静止后停留多久再淡出（ms） */
  private static readonly REST_MS = 900;
  /** 淡出时长（ms） */
  private static readonly FADE_MS = 420;
  /** 默认初速（px/帧） */
  private static readonly DEFAULT_SPEED = 5;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.g = scene.add.graphics();
    // -0.5：在地图（-1/-2）之上、玩家（0）之下
    this.g.setDepth(-0.5);
  }

  /** 抛出一枚弹壳 */
  spawn(o: CasingSpawnOptions): void {
    const speed = o.speed ?? CasingSystem.DEFAULT_SPEED;
    const jitter = (Math.random() - 0.5) * 1.2;
    // 主要沿枪管上侧弹出，同时带一点向后的分速度 + 随机抖动
    const vx = o.outX * speed + o.backX * speed * 0.42 + (Math.random() - 0.5) * jitter;
    const vy = o.outY * speed + o.backY * speed * 0.42 + (Math.random() - 0.5) * jitter;

    this.push({
      x: o.x,
      y: o.y,
      vx,
      vy,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.75,
      groundY: this.groundBelow(o.x, o.y, o.ignoreBody),
      bounced: false,
      landed: false,
      restMs: CasingSystem.REST_MS,
      length: o.length,
      width: o.width,
      color: o.color,
    });
  }

  /** 从 (x, y) 向下打一条射线，返回可落地的 y；没有地面则返回 Infinity */
  private groundBelow(x: number, y: number, ignoreBody: MatterJS.BodyType | null | undefined): number {
    const hits = raycast(getWorldBodies(this.scene), { x, y }, { x: 0, y: 1 }, 2400, {
      ignore: ignoreBody ? [ignoreBody] : [],
      maxHits: 1,
    });
    return hits.length > 0 ? hits[0].point.y : Infinity;
  }

  private push(casing: Casing): void {
    if (this.casings.length >= CasingSystem.MAX_CASINGS) {
      this.casings.shift();
    }
    this.casings.push(casing);
  }

  /** 每帧调用：推进所有弹壳并一次性重绘 */
  update(deltaMs: number): void {
    const dt = deltaMs / 16.6667;
    const cam = this.scene.cameras.main;
    const offscreenY = cam.scrollY + cam.height + 400;

    this.g.clear();
    if (this.casings.length === 0) return;

    for (let i = this.casings.length - 1; i >= 0; i--) {
      const c = this.casings[i];

      if (!c.landed) {
        // ---- 空中：抛物线 + 旋转 ----
        c.vy += CasingSystem.GRAVITY * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.rot += c.spin * dt;

        if (c.y >= c.groundY && c.vy > 0) {
          if (!c.bounced) {
            // 第一次触地：小反弹 + 快速失去旋转
            c.bounced = true;
            c.y = c.groundY;
            c.vy = -c.vy * 0.32;
            c.vx *= 0.55;
            c.spin *= 0.35;
          } else {
            // 第二次触地：躺在原地
            c.y = c.groundY;
            c.vx = 0;
            c.vy = 0;
            c.spin = 0;
            c.landed = true;
            c.restMs = CasingSystem.REST_MS;
          }
        } else if (!Number.isFinite(c.groundY) && c.y > offscreenY) {
          this.casings.splice(i, 1);
          continue;
        }
      } else {
        // ---- 落地后：停留一会儿再淡出 ----
        c.restMs -= deltaMs;
        if (c.restMs <= 0) {
          this.casings.splice(i, 1);
          continue;
        }
      }

      const alpha =
        c.restMs < CasingSystem.FADE_MS ? Phaser.Math.Clamp(c.restMs / CasingSystem.FADE_MS, 0, 1) : 1;
      this.drawCasing(c, alpha);
    }
  }

  private drawCasing(c: Casing, alpha: number): void {
    const g = this.g;
    g.save();
    g.translateCanvas(c.x, c.y);
    g.rotateCanvas(c.rot);
    // 壳体
    g.fillStyle(c.color, alpha);
    g.fillRect(-c.length / 2, -c.width / 2, c.length, c.width);
    // 一道高光，远看才不会像"土黄色小方块"
    g.fillStyle(0xffffff, alpha * 0.45);
    g.fillRect(-c.length / 2, -c.width / 2, c.length * 0.6, Math.max(1, c.width * 0.34));
    g.restore();
  }

  destroy(): void {
    this.g.destroy();
    this.casings.length = 0;
  }
}
