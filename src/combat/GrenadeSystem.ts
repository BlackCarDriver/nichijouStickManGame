import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import type { ProjectileSystem } from './ProjectileSystem';
import { getWeapon } from './WeaponFormat';
import type { BulletConfig } from './WeaponFormat';
import { TrajectoryPreview } from './TrajectoryPreview';
import { buildThrownBullet } from './WeaponSystem';

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
  /** 背包上限：腰上只挂一发（拾取时若已有一发则不再拾取） */
  static readonly MAX = 1;

  private readonly projectiles: ProjectileSystem;
  private readonly preview: TrajectoryPreview;
  /** 攻击批次 id（用于同批次伤害绕过无敌帧） */
  private attackSeq = 0;

  constructor(scene: Phaser.Scene, projectiles: ProjectileSystem) {
    this.projectiles = projectiles;
    this.preview = new TrajectoryPreview(scene, 828);
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

  /** 投出（左键）。成功返回 true */  throwGrenade(player: Player): boolean {
    if (!player.grenadeMode || player.grenadeCount <= 0 || player.health.isDead) return false;
    const weapon = getWeapon('grenade');
    const cfg = weapon?.throw;
    if (!weapon || !cfg) return false;

    const from = player.muzzle;
    // 与投掷武器共用同一份弹道配置构造函数（联机中继要用同一份参数重建）
    const bullet: BulletConfig = { ...buildThrownBullet(weapon), kind: 'grenade', size: 5, trail: 0 };

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

  /**
   * 引爆腰上挂着的手榴弹（被子弹击中时由场景调用）。
   * 只负责“消耗这一发 + 退出持握状态”，爆炸本身由 ExplosionSystem 处理。
   * @returns 是否真的爆炸了
   */
  detonate(player: Player): boolean {
    if (player.grenadeCount <= 0 || player.health.isDead) return false;
    player.grenadeCount = 0;
    player.grenadeMode = false;
    return true;
  }

  /** 每帧调用：为所有持握中的手榴弹画弹道预览 */
  update(deltaMs: number, players: Player[]): void {
    this.preview.tick(deltaMs);
    this.preview.clear();

    for (const player of players) {
      if (!player.grenadeMode || player.health.isDead) continue;
      const weapon = getWeapon('grenade');
      const cfg = weapon?.throw;
      if (!weapon || !cfg) continue;
      const path = this.preview.compute(
        player.muzzle,
        player.aim,
        cfg.speed,
        cfg.range,
        [player.body],
        TrajectoryPreview.PREVIEW_LENGTH,
      );
      this.preview.drawPath(path, weapon.visual.color, 1);
    }
  }

  destroy(): void {
    this.preview.destroy();
  }
}
