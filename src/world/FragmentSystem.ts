import Phaser from 'phaser';
import { parseColor } from '../config/materials';

/**
 * 破坏碎片系统（破坏反馈 B 档）。
 *
 * 物体被摧毁时炸出几块小碎块：有短暂物理、自动休眠，约 1.2s 后淡出移除。
 * 有总量上限，避免连锁爆炸时碎片把帧率打崩。
 */
interface Fragment {
  body: MatterJS.BodyType;
  gfx: Phaser.GameObjects.Graphics;
  color: number;
  remain: number;
  maxLife: number;
  size: number;
}

export class FragmentSystem {
  private readonly scene: Phaser.Scene;
  private fragments: Fragment[] = [];

  /** 同时存在的碎片上限 */
  private static readonly MAX_FRAGMENTS = 70;
  private static readonly LIFE_MS = 1200;
  private static readonly FRAGMENT_GRAVITY_ENABLED = true;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  get count(): number {
    return this.fragments.length;
  }

  /**
   * 在物体中心炸出碎片。
   * @param colorHex 材质颜色（hex 字符串）
   * @param pieces 碎片数量
   */
  burst(
    x: number,
    y: number,
    colorHex: string,
    pieces = 5,
    spread = 26,
  ): void {
    const color = parseColor(colorHex, 0xffffff);
    for (let i = 0; i < pieces; i++) {
      if (this.fragments.length >= FragmentSystem.MAX_FRAGMENTS) {
        this.removeOldest();
      }
      const size = 4 + Math.random() * 7;
      const fx = x + (Math.random() - 0.5) * spread;
      const fy = y + (Math.random() - 0.5) * spread;
      const body = this.scene.matter.add.rectangle(fx, fy, size, size, {
        friction: 0.6,
        frictionStatic: 0.8,
        restitution: 0.2,
        density: 0.001,
        label: 'fragment',
        isStatic: !FragmentSystem.FRAGMENT_GRAVITY_ENABLED,
      });
      // 向外炸开
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 5;
      this.scene.matter.body.setVelocity(body, {
        x: Math.cos(angle) * speed,
        y: Math.sin(angle) * speed - 3,
      });
      this.scene.matter.body.setAngularVelocity(body, (Math.random() - 0.5) * 0.4);

      const gfx = this.scene.add.graphics();
      gfx.setDepth(840);
      gfx.fillStyle(color, 1);
      gfx.fillRect(-size / 2, -size / 2, size, size);

      this.fragments.push({
        body,
        gfx,
        color,
        remain: FragmentSystem.LIFE_MS,
        maxLife: FragmentSystem.LIFE_MS,
        size,
      });
    }
  }

  update(deltaMs: number): void {
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const f = this.fragments[i];
      f.remain -= deltaMs;
      if (f.remain <= 0) {
        this.fragments.splice(i, 1);
        this.dispose(f);
        continue;
      }
      // 跟随物理体
      f.gfx.setPosition(f.body.position.x, f.body.position.y);
      f.gfx.setRotation(f.body.angle);
      // 末尾淡出
      const alpha = Math.min(1, f.remain / 350);
      f.gfx.setAlpha(alpha);
    }
  }

  private removeOldest(): void {
    const f = this.fragments.shift();
    if (f) this.dispose(f);
  }

  private dispose(f: Fragment): void {
    this.scene.matter.world.remove(f.body);
    f.gfx.destroy();
  }

  destroy(): void {
    for (const f of this.fragments) this.dispose(f);
    this.fragments = [];
  }
}
