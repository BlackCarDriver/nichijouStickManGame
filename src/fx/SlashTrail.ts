import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getWeapon } from '../combat/WeaponFormat';

interface Sample {
  /** 刀身当前角度（世界弧度） */
  angle: number;
  /** 采样后经过的时间（ms），用于淡出 */
  age: number;
}

interface Swing {
  samples: Sample[];
  color: number;
  /** 扇形内半径（肩 → 内弧） */
  inner: number;
  /** 扇形外半径（肩 → 刀尖） */
  outer: number;
}

/**
 * 挥砍残影（扇形刀光）。
 *
 * 之前只是一条连接起止角度的直线（弦），看起来像"闪了一下"。
 * 现在逐帧采样**刀身实际扫过的角度**，把相邻采样之间扫出的楔形拼成一个扇形，
 * 边缘越新越亮、越旧越淡 → 读作"刀真的扫过一片区域"。
 *
 * 采样点在 slash 结束后继续老化淡出，所以残影会自然消散。
 */
export class SlashTrail {
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly swings = new Map<number, Swing>();

  /** 一个刀光最多保留多少个采样点 */
  private static readonly MAX_SAMPLES = 16;
  /** 残影存活时间（ms）：超过后整片清掉 */
  private static readonly LIFE_MS = 260;
  /** 内半径占外半径的比例（留出"刀柄到中段"的空心） */
  private static readonly INNER_RATIO = 0.34;
  /** 相邻采样的最小角度差（弧度），避免静止时堆叠成一团 */
  private static readonly MIN_ANGLE_STEP = 0.012;

  constructor(scene: Phaser.Scene) {
    this.g = scene.add.graphics();
    // ADD 混合：刀光叠加处会发亮，像真的光刃扫过
    this.g.setBlendMode(Phaser.BlendModes.ADD);
    this.g.setDepth(848);
  }

  update(deltaMs: number, players: Player[]): void {
    for (const player of players) {
      const swinging = player.attack === 'slash' && !player.health.isDead;
      const weapon = player.heldWeapon ? getWeapon(player.heldWeapon.id) : undefined;
      const visual = weapon?.visual;

      if (swinging && visual) {
        const swing = this.swings.get(player.id) ?? {
          samples: [],
          color: player.color,
          inner: 0,
          outer: 0,
        };

        // 扇形半径：圆心用肩部，外弧到刀尖
        const shoulder = player.shoulderWorld;
        const hand = player.handWorld;
        const pivotDist = Math.hypot(hand.x - shoulder.x, hand.y - shoulder.y);
        swing.outer = pivotDist + visual.length;
        swing.inner = swing.outer * SlashTrail.INNER_RATIO;
        swing.color = player.color;

        const angle = player.aim + player.slashOffset;
        const last = swing.samples[swing.samples.length - 1];
        if (!last || Math.abs(angle - last.angle) >= SlashTrail.MIN_ANGLE_STEP) {
          swing.samples.push({ angle, age: 0 });
          if (swing.samples.length > SlashTrail.MAX_SAMPLES) swing.samples.shift();
        }
        this.swings.set(player.id, swing);
      } else if (this.swings.has(player.id)) {
        // 不再挥砍：采样继续老化，全部超时就移除
        const swing = this.swings.get(player.id)!;
        let alive = false;
        for (const s of swing.samples) {
          s.age += deltaMs;
          if (s.age < SlashTrail.LIFE_MS) alive = true;
        }
        if (!alive) this.swings.delete(player.id);
      }

      // 老化（挥砍中也要老化，否则残影不会消散）
      const swing = this.swings.get(player.id);
      if (swing && swinging) {
        for (const s of swing.samples) s.age += deltaMs;
        // 丢掉过老的采样
        while (swing.samples.length > 1 && swing.samples[0].age > SlashTrail.LIFE_MS) {
          swing.samples.shift();
        }
      }
    }

    this.draw(players);
  }

  private draw(players: Player[]): void {
    this.g.clear();

    for (const player of players) {
      const swing = this.swings.get(player.id);
      if (!swing || swing.samples.length < 2) continue;

      const shoulder = player.shoulderWorld;
      // 注意：shoulderWorld 会随呼吸/姿态微动，但扇形圆心用当前肩部即可
      const poly: { x: number; y: number }[] = [];

      for (let i = 1; i < swing.samples.length; i++) {
        const a = swing.samples[i - 1];
        const b = swing.samples[i];
        const tNew = i / swing.samples.length; // 0..1，越新越大
        const fadeA = this.alphaFor(a.age);
        const fadeB = this.alphaFor(b.age);
        const alpha = Math.min(fadeA, fadeB) * (0.35 + 0.5 * tNew);
        if (alpha <= 0.01) continue;

        poly.length = 0;
        poly.push({
          x: shoulder.x + Math.cos(a.angle) * swing.inner,
          y: shoulder.y + Math.sin(a.angle) * swing.inner,
        });
        poly.push({
          x: shoulder.x + Math.cos(a.angle) * swing.outer,
          y: shoulder.y + Math.sin(a.angle) * swing.outer,
        });
        poly.push({
          x: shoulder.x + Math.cos(b.angle) * swing.outer,
          y: shoulder.y + Math.sin(b.angle) * swing.outer,
        });
        poly.push({
          x: shoulder.x + Math.cos(b.angle) * swing.inner,
          y: shoulder.y + Math.sin(b.angle) * swing.inner,
        });

        this.g.fillStyle(swing.color, alpha);
        this.g.fillPoints(poly, true);
      }

      // 刀尖的亮边（最新采样的外弧端点）
      const newest = swing.samples[swing.samples.length - 1];
      const tipAlpha = this.alphaFor(newest.age) * 0.9;
      if (tipAlpha > 0.02) {
        const tip = {
          x: shoulder.x + Math.cos(newest.angle) * swing.outer,
          y: shoulder.y + Math.sin(newest.angle) * swing.outer,
        };
        this.g.lineStyle(3, 0xffffff, tipAlpha * 0.5);
        this.g.lineBetween(
          shoulder.x + Math.cos(newest.angle) * swing.inner,
          shoulder.y + Math.sin(newest.angle) * swing.inner,
          tip.x,
          tip.y,
        );
      }
    }
  }

  /** 采样年龄 → 透明度（线性淡出） */
  private alphaFor(age: number): number {
    if (age >= SlashTrail.LIFE_MS) return 0;
    return 1 - age / SlashTrail.LIFE_MS;
  }

  destroy(): void {
    this.g.destroy();
    this.swings.clear();
  }
}
