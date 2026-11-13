import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { TEXT_RESOLUTION } from '../config/display';

interface Bubble {
  text: Phaser.GameObjects.Text;
  /** 已累计的数值（短时间内连续命中会合并显示） */
  total: number;
  /** 剩余显示时间（ms） */
  remain: number;
  /** 是否包含暴击（决定后缀与字号） */
  crit: boolean;
  /** 气泡类型（不同类不合并） */
  kind: BubbleKind;
}

/**
 * 气泡类型：
 * - damage      受伤（红 -）
 * - heal        治疗（绿 +）
 * - shield      获得护盾（灰 +）
 * - shieldLoss  护盾被消耗（灰 -）
 */
export type BubbleKind = 'damage' | 'heal' | 'shield' | 'shieldLoss';

interface BubbleStyle {
  color: string;
  stroke: string;
  prefix: string;
}

const BUBBLE_STYLES: Record<BubbleKind, BubbleStyle> = {
  damage: { color: '#ff5a5a', stroke: '#2a0a0a', prefix: '-' },
  heal: { color: '#4ade80', stroke: '#0a2a12', prefix: '+' },
  shield: { color: '#c8d0dc', stroke: '#1a2028', prefix: '+' },
  shieldLoss: { color: '#c8d0dc', stroke: '#1a2028', prefix: '-' },
};

/**
 * 伤害数字气泡（从受击者头顶冒出来，上浮后淡出）。
 *
 * 两个关键取舍：
 * 1. **合并短时间内的多次伤害**：激光每秒 18 跳、霰弹 7 颗弹丸，
 *    如果不合并，屏幕上会瞬间炸出一片"−4"，完全读不出来。
 * 2. 用 Text 对象 + 手动上浮（不用 tween），这样气泡可以随"合并"实时更新数值。
 */
export class DamageNumbers {
  private readonly scene: Phaser.Scene;
  /** "playerId:kind" → 当前气泡（同目标的不同类型可以同时显示） */
  private readonly bubbles = new Map<string, Bubble>();

  /** 合并窗口（ms）：这段时间内的伤害累加到同一个气泡 */
  private static readonly MERGE_WINDOW = 320;
  /** 上浮速度（px/秒） */
  private static readonly RISE_SPEED = 46;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** 显示一次伤害（会自动与同目标的近期伤害合并） */
  show(player: Player, amount: number, opts: { crit?: boolean; kind?: BubbleKind } = {}): void {
    const kind: BubbleKind = opts.kind ?? 'damage';
    const style = BUBBLE_STYLES[kind];
    const rounded = Math.max(1, Math.round(amount));
    const key = `${player.id}:${kind}`;
    const existing = this.bubbles.get(key);

    if (existing && existing.kind === kind) {
      existing.total += rounded;
      existing.remain = DamageNumbers.MERGE_WINDOW;
      existing.crit = existing.crit || opts.crit === true;
      existing.text.setText(`${style.prefix}${existing.total}`);
      existing.text.setFontSize(existing.crit ? '27px' : '18px');
      existing.text.setFontStyle(existing.crit ? 'bold' : 'normal');
      existing.text.setColor(existing.crit ? '#ff2d2d' : style.color);
      // 合并时轻微放大一下，提示"又打了一层"
      existing.text.setScale(1.18);
      return;
    }

    // 类型不同（例如"扣血"紧跟着"回血"）→ 先收掉旧气泡，避免数字串味
    if (existing) {
      existing.text.destroy();
      this.bubbles.delete(key);
    }

    const x = player.container.x + (Math.random() - 0.5) * 12;
    const y = player.container.y - 74;
    const text = this.scene.add.text(x, y, `${style.prefix}${rounded}`, {
      fontFamily: 'monospace',
      // 暴击：更粗 + 更大（不用感叹号）
      fontSize: opts.crit ? '27px' : '18px',
      fontStyle: opts.crit ? 'bold' : 'normal',
      color: opts.crit ? '#ff2d2d' : style.color,
      stroke: style.stroke,
      strokeThickness: 4,
    });
    text.setResolution(TEXT_RESOLUTION);
    text.setOrigin(0.5, 1);
    text.setDepth(1002);
    this.bubbles.set(key, {
      text,
      total: rounded,
      remain: DamageNumbers.MERGE_WINDOW,
      crit: opts.crit === true,
      kind,
    });
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const [key, bubble] of this.bubbles) {
      bubble.remain -= deltaMs;
      bubble.text.y -= DamageNumbers.RISE_SPEED * dt;
      // 缩放回 1
      bubble.text.setScale(Phaser.Math.Linear(bubble.text.scaleX, 1, 0.25));
      // 末段淡出
      bubble.text.setAlpha(Math.min(1, bubble.remain / 160));

      if (bubble.remain <= 0) {
        bubble.text.destroy();
        this.bubbles.delete(key);
      }
    }
  }

  destroy(): void {
    for (const [, bubble] of this.bubbles) bubble.text.destroy();
    this.bubbles.clear();
  }
}
