import Phaser from 'phaser';

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: number;
}

interface Ring {
  x: number;
  y: number;
  radius: number;
  life: number;
  maxLife: number;
  color: number;
}

interface Beam {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  maxLife: number;
  color: number;
  width: number;
}

/**
 * 轻量特效系统（对象池）。
 *
 * 设计取舍：火花/射线用一个 Graphics 每帧重画，而不是为每个粒子建
 * GameObject / 粒子发射器 —— 连发武器每秒会产生几十个粒子，
 * 前者零分配（数组复用），后者会持续制造 GC 压力（performance-optimization 技能）。
 */
export class FxSystem {
  private readonly scene: Phaser.Scene;
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly sparks: Spark[] = [];
  private readonly beams: Beam[] = [];
  private readonly rings: Ring[] = [];
  /** 火花池上限（超出后复用最老的） */
  private static readonly MAX_SPARKS = 240;
  private static readonly MAX_BEAMS = 32;
  private static readonly MAX_RINGS = 8;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.g = scene.add.graphics();
    this.g.setDepth(900);
  }

  /** 命中火花：沿法线方向溅出一小簇短线 */
  hitSpark(point: { x: number; y: number }, normal: { x: number; y: number } | undefined, color = 0xffe08a): void {
    const nx = normal?.x ?? 0;
    const ny = normal?.y ?? -1;
    const count = 5;
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * 1.6;
      const speed = 3 + Math.random() * 5;
      // 以法线为主方向，加一点随机散射
      const vx = (nx + spread * -ny) * speed;
      const vy = (ny + spread * nx) * speed;
      this.pushSpark({
        x: point.x,
        y: point.y,
        vx,
        vy,
        life: 160 + Math.random() * 120,
        maxLife: 280,
        size: 1.5 + Math.random() * 1.8,
        color,
      });
    }
  }

  /** 物体破坏：向外爆散的一圈火花 */
  burst(point: { x: number; y: number }, color = 0xffffff): void {
    const count = 14;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const speed = 2.5 + Math.random() * 5.5;
      this.pushSpark({
        x: point.x,
        y: point.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        life: 220 + Math.random() * 260,
        maxLife: 480,
        size: 2 + Math.random() * 2.5,
        color,
      });
    }
  }

  /** 射线/弹道（调试枪与激光用） */
  beam(
    from: { x: number; y: number },
    to: { x: number; y: number },
    color = 0x7ef9ff,
    lifeMs = 140,
    width = 2,
  ): void {
    if (this.beams.length >= FxSystem.MAX_BEAMS) this.beams.shift();
    this.beams.push({
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      life: lifeMs,
      maxLife: lifeMs,
      color,
      width,
    });
  }

  /** 爆炸扩散环：一个迅速扩张并淡出的圆环（读作"冲击波"） */
  ring(x: number, y: number, radius: number, color = 0xffa94d, lifeMs = 260): void {
    if (this.rings.length >= FxSystem.MAX_RINGS) this.rings.shift();
    this.rings.push({ x, y, radius, life: lifeMs, maxLife: lifeMs, color });
  }

  /**
   * 受击闪白：按物体的**真实多边形**叠加白色，短暂淡出。
   *
   * 不能用 AABB（原实现）：倾斜的长方体/三角形用包围盒画，白块会溢出物体轮廓。
   * 这里直接拿 Matter body 的世界顶点画填充多边形，形状永远贴合。
   */
  flashShape(vertices: ReadonlyArray<{ x: number; y: number }> | undefined, color = 0xffffff): void {
    if (!vertices || vertices.length < 3) return;
    const g = this.scene.add.graphics();
    g.setDepth(880);
    g.fillStyle(color, 0.55);
    g.beginPath();
    g.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) {
      g.lineTo(vertices[i].x, vertices[i].y);
    }
    g.closePath();
    g.fillPath();
    this.scene.tweens.add({
      targets: g,
      alpha: 0,
      duration: 130,
      ease: 'Quad.easeOut',
      onComplete: () => g.destroy(),
    });
  }

  /** 受击闪白（AABB 版，保留给无顶点的场合） */
  flashBounds(bounds: MatterJS.IBound | undefined, color = 0xffffff): void {
    if (!bounds) return;
    const w = bounds.max.x - bounds.min.x;
    const h = bounds.max.y - bounds.min.y;
    if (w <= 0 || h <= 0) return;
    const rect = this.scene.add.rectangle(
      bounds.min.x + w / 2,
      bounds.min.y + h / 2,
      w,
      h,
      color,
      0.55,
    );
    rect.setDepth(880);
    this.scene.tweens.add({
      targets: rect,
      alpha: 0,
      duration: 130,
      ease: 'Quad.easeOut',
      onComplete: () => rect.destroy(),
    });
  }

  private pushSpark(spark: Spark): void {
    if (this.sparks.length >= FxSystem.MAX_SPARKS) {
      this.sparks.shift();
    }
    this.sparks.push(spark);
  }

  /** 每帧调用：推进粒子并一次性重绘 */
  update(deltaMs: number): void {
    const dt = deltaMs / 16.6667;
    this.g.clear();

    // 火花
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= deltaMs;
      if (s.life <= 0) {
        this.sparks.splice(i, 1);
        continue;
      }
      s.vy += 0.35 * dt; // 轻微重力
      s.vx *= 0.97;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const alpha = Phaser.Math.Clamp(s.life / s.maxLife, 0, 1);
      this.g.fillStyle(s.color, alpha);
      this.g.fillCircle(s.x, s.y, s.size);
    }

    // 射线
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= deltaMs;
      if (b.life <= 0) {
        this.beams.splice(i, 1);
        continue;
      }
      const alpha = Phaser.Math.Clamp(b.life / b.maxLife, 0, 1);
      this.g.lineStyle(Math.max(1, b.width * alpha), b.color, alpha);
      this.g.lineBetween(b.x1, b.y1, b.x2, b.y2);
    }

    // 爆炸扩散环
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= deltaMs;
      if (r.life <= 0) {
        this.rings.splice(i, 1);
        continue;
      }
      const t = 1 - r.life / r.maxLife; // 0 → 1
      const alpha = (1 - t) * 0.85;
      const rr = r.radius * (0.35 + 0.65 * t);
      this.g.lineStyle(Math.max(1, 6 * (1 - t)), r.color, alpha);
      this.g.strokeCircle(r.x, r.y, rr);
      this.g.lineStyle(1.5, 0xffffff, alpha * 0.6);
      this.g.strokeCircle(r.x, r.y, rr * 0.82);
    }
  }

  destroy(): void {
    this.g.destroy();
    this.sparks.length = 0;
    this.beams.length = 0;
    this.rings.length = 0;
  }
}
