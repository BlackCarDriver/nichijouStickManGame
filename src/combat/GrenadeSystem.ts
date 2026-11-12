import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import type { ProjectileSystem } from './ProjectileSystem';
import { getWeapon, PROJECTILE_GRAVITY } from './WeaponFormat';
import type { BulletConfig } from './WeaponFormat';
import { raycast, getWorldBodies } from './Raycast';
import { parseColor } from '../config/materials';

interface Vec2 {
  x: number;
  y: number;
}

/**
 * 手榴弹系统。
 *
 * 与普通武器不同，手榴弹是**背包道具**而不是武器槽：
 * - 拾取时**不替换手上的武器**，直接进背包（上限 MAX）
 * - 按 G 取出 → 手上显示手榴弹 + **半透明抛物蚂蚁线**（弹道预览）
 * - 左键投出 → 固定初速、落点由方向决定；投出后**自动切回上一个武器**
 * - 再按一次 G 可以收起（不消耗）
 */
export class GrenadeSystem {
  /** 背包上限 */
  static readonly MAX = 3;

  private readonly scene: Phaser.Scene;
  private readonly projectiles: ProjectileSystem;
  private readonly g: Phaser.GameObjects.Graphics;
  /** 蚂蚁线动画相位（秒） */
  private time = 0;
  /** 攻击批次 id（用于同批次伤害绕过无敌帧） */
  private attackSeq = 0;

  /** 蚂蚁线点间距（px） */
  private static readonly DOT_SPACING = 17;
  /** 蚂蚁线动画速度（px/秒） */
  private static readonly DOT_SCROLL = 55;
  /** 预览模拟步长（秒） */
  private static readonly SIM_DT = 1 / 60;
  /** 预览最多模拟步数（约 4 秒） */
  private static readonly SIM_MAX_STEPS = 240;

  constructor(scene: Phaser.Scene, projectiles: ProjectileSystem) {
    this.scene = scene;
    this.projectiles = projectiles;
    this.g = scene.add.graphics();
    // 在角色之上、子弹之下
    this.g.setDepth(828);
  }

  /** 按 G：取出 / 收起手榴弹。返回是否处于持握状态 */
  toggle(player: Player): boolean {
    if (player.health.isDead) return player.grenadeMode;
    if (player.grenadeMode) {
      player.grenadeMode = false;
      return false;
    }
    if (player.grenadeCount <= 0) return false;
    player.grenadeMode = true;
    return true;
  }

  /** 投出（左键）。成功返回 true */
  throwGrenade(player: Player): boolean {
    if (!player.grenadeMode || player.grenadeCount <= 0 || player.health.isDead) return false;
    const weapon = getWeapon('grenade');
    const cfg = weapon?.throw;
    if (!weapon || !cfg) return false;

    const from = player.muzzle;
    const bullet: BulletConfig = {
      kind: 'grenade',
      speed: cfg.speed,
      gravity: undefined, // 用全局重力
      range: cfg.range,
      size: 5,
      color: weapon.visual.color,
      trail: 0,
      maxBounces: 0,
      bounceDamageMul: 1,
      pierceDamageMul: 1,
      piercePlayers: false,
      bounceAny: cfg.bounceAny,
      bounceRestitution: cfg.bounceRestitution,
    };

    this.projectiles.spawn({
      weaponId: 'grenade',
      x: from.x,
      y: from.y,
      angle: player.aim,
      damage: cfg.damage ?? weapon.damage,
      knockback: weapon.knockback,
      ownerId: player.id,
      ownerBody: player.body,
      bullet,
      explosion: weapon.explosion,
      fuseMs: cfg.fuseMs,
      attackId: ++this.attackSeq,
    });

    player.grenadeCount -= 1;
    // 投出后自动切回上一个武器（武器从未被卸下，这里只需退出榴弹模式）
    player.grenadeMode = false;
    player.setAttack('stab', 160);
    return true;
  }

  /** 每帧调用：为重画所有持握中的手榴弹画弹道预览 */
  update(deltaMs: number, players: Player[]): void {
    this.time += deltaMs / 1000;
    this.g.clear();

    for (const player of players) {
      if (!player.grenadeMode || player.health.isDead) continue;
      const path = this.simulate(player);
      if (!path) continue;
      this.drawPreview(path.points, path.hit);
    }
  }

  /**
   * 模拟弹道（固定初速 + 全局重力），返回折线点与命中点。
   * 预览只画到**第一次接触**为止（不模拟反弹，读起来更清楚）。
   */
  private simulate(player: Player): { points: Vec2[]; hit: Vec2 | null } | null {
    const weapon = getWeapon('grenade');
    const cfg = weapon?.throw;
    if (!cfg) return null;

    const from = player.muzzle;
    const aim = player.aim;
    const speed = cfg.speed;
    const maxRange = cfg.range;
    const g = PROJECTILE_GRAVITY;
    const bodies = getWorldBodies(this.scene);

    let x = from.x;
    let y = from.y;
    let vx = Math.cos(aim) * speed;
    let vy = Math.sin(aim) * speed;
    let traveled = 0;

    const points: Vec2[] = [{ x, y }];

    for (let i = 0; i < GrenadeSystem.SIM_MAX_STEPS; i++) {
      vy += g * GrenadeSystem.SIM_DT;
      const nx = x + vx * GrenadeSystem.SIM_DT;
      const ny = y + vy * GrenadeSystem.SIM_DT;
      const stepLen = Math.hypot(nx - x, ny - y);
      if (stepLen < 1e-4) break;

      const hits = raycast(
        bodies,
        { x, y },
        { x: (nx - x) / stepLen, y: (ny - y) / stepLen },
        stepLen,
        { ignore: [player.body], maxHits: 1 },
      );
      if (hits[0]) {
        points.push(hits[0].point);
        return { points, hit: hits[0].point };
      }

      x = nx;
      y = ny;
      traveled += stepLen;
      points.push({ x, y });
      if (traveled >= maxRange) break;
    }

    return { points, hit: null };
  }

  /** 画"蚂蚁线"：等距点 + 滚动相位 → 看起来像在流动 */
  private drawPreview(points: Vec2[], hit: Vec2 | null): void {
    const color = parseColor(getWeapon('grenade')?.visual.color ?? '#4e6b3a', 0x8fd06a);
    const scroll = (this.time * GrenadeSystem.DOT_SCROLL) % GrenadeSystem.DOT_SPACING;

    let nextDot = scroll;
    let accumulated = 0;

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-4) continue;

      // 沿这一段按等距插值画点
      while (nextDot <= accumulated + segLen) {
        const t = (nextDot - accumulated) / segLen;
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        this.g.fillStyle(0xffffff, 0.5);
        this.g.fillCircle(px, py, 1.9);
        this.g.fillStyle(color, 0.28);
        this.g.fillCircle(px, py, 4.2);
        nextDot += GrenadeSystem.DOT_SPACING;
      }
      accumulated += segLen;
    }

    if (hit) {
      // 落点标记：圆圈 + 十字
      this.g.lineStyle(2, color, 0.85);
      this.g.strokeCircle(hit.x, hit.y, 9);
      this.g.lineStyle(1.5, 0xffffff, 0.6);
      this.g.lineBetween(hit.x - 13, hit.y, hit.x + 13, hit.y);
      this.g.lineBetween(hit.x, hit.y - 13, hit.x, hit.y + 13);
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
