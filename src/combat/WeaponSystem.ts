import Phaser from 'phaser';
import { MATERIALS, parseColor } from '../config/materials';
import type { Player } from '../entities/Player';
import type { WorldRegistry } from '../world/WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageSystem } from './DamageSystem';
import type { ProjectileSystem } from './ProjectileSystem';
import { getWeapon, createHeldWeapon } from './WeaponFormat';
import type { WeaponJson } from './WeaponFormat';
import { raycast, getWorldBodies } from './Raycast';

/**
 * 武器系统：装备、开火节流、弹药与耐久消耗。
 *
 * 分两种开火方式：
 *   - shoot：生成逻辑弹道子弹（有飞行时间，速度由武器配置决定）
 *   - beam ：瞬时光束 hitscan（激光枪，贯穿路径上的目标，零后续开销）
 *
 * melee（刺击）/ throw（投掷）在 W3/W4 实现，这里先不消耗。
 */
export class WeaponSystem {
  private readonly scene: Phaser.Scene;
  private readonly projectiles: ProjectileSystem;
  private readonly damageSystem: DamageSystem;
  private readonly registry: WorldRegistry;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;
  /** playerId → 剩余冷却（秒） */
  private readonly cooldowns = new Map<number, number>();

  constructor(
    scene: Phaser.Scene,
    projectiles: ProjectileSystem,
    damageSystem: DamageSystem,
    registry: WorldRegistry,
    bodyToPlayer: Map<number, Player>,
    fx: FxSystem,
  ) {
    this.scene = scene;
    this.projectiles = projectiles;
    this.damageSystem = damageSystem;
    this.registry = registry;
    this.bodyToPlayer = bodyToPlayer;
    this.fx = fx;
  }

  /** 装备武器（null = 空手） */
  equip(player: Player, weaponId: string | null): void {
    if (!weaponId) {
      player.heldWeapon = null;
      return;
    }
    player.heldWeapon = createHeldWeapon(weaponId) ?? null;
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const [id, cd] of this.cooldowns) {
      const next = cd - dt;
      if (next <= 0) this.cooldowns.delete(id);
      else this.cooldowns.set(id, next);
    }
  }

  /** 尝试开火。返回是否真的打出了一发 */
  tryFire(player: Player): boolean {
    const held = player.heldWeapon;
    if (!held || player.health.isDead) return false;
    if (this.cooldowns.has(player.id)) return false;

    const weapon = getWeapon(held.id);
    if (!weapon) return false;

    // 弹药耗尽 → 武器作废（W5 会实体化掉落成可拾取物）
    if (held.ammo === 0) {
      this.breakWeapon(player, 'empty');
      return false;
    }

    let fired = false;
    switch (weapon.attackMode) {
      case 'shoot':
        fired = this.fireProjectile(player, weapon);
        break;
      case 'beam':
        fired = this.fireBeam(player, weapon);
        break;
      default:
        return false; // melee / throw：W3、W4
    }
    if (!fired) return false;

    if (held.ammo > 0) held.ammo -= 1;
    held.durability -= weapon.durabilityPerShot;
    this.cooldowns.set(player.id, 1 / Math.max(0.01, weapon.fireRate));

    if (held.durability <= 0) {
      this.breakWeapon(player, 'broken');
    }
    return true;
  }

  /** 发射逻辑弹道子弹 */
  private fireProjectile(player: Player, weapon: WeaponJson): boolean {
    const bullet = weapon.bullet;
    if (!bullet) return false;
    const from = player.muzzle;
    const angle = player.aim;

    this.projectiles.spawn({
      weaponId: player.heldWeapon?.id ?? '',
      x: from.x,
      y: from.y,
      angle,
      damage: weapon.damage,
      knockback: weapon.knockback,
      ownerId: player.id,
      ownerBody: player.body,
      bullet,
    });

    // 枪口闪光（朝前）
    this.fx.hitSpark(from, { x: Math.cos(angle), y: Math.sin(angle) }, parseColor(bullet.color));
    return true;
  }

  /**
   * 瞬时光束（hitscan）：贯穿路径上的玩家与可穿透物体，
   * 遇到"不可穿透的物体"（墙/金属/地面）终止。
   */
  private fireBeam(player: Player, weapon: WeaponJson): boolean {
    const beam = weapon.beam;
    if (!beam) return false;

    const from = player.muzzle;
    const angle = player.aim;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const bodies = getWorldBodies(this.scene);

    const hits = raycast(bodies, from, dir, beam.range, {
      ignore: [player.body],
      maxHits: 48,
    });

    const color = parseColor(beam.color, 0x7ef9ff);
    let endPoint = { x: from.x + dir.x * beam.range, y: from.y + dir.y * beam.range };
    const damagedBodies = new Set<number>();

    for (const hit of hits) {
      if (damagedBodies.has(hit.body.id)) continue;
      damagedBodies.add(hit.body.id);

      const target = this.bodyToPlayer.get(hit.body.id);
      if (target) {
        this.damageSystem.damagePlayer(target, {
          amount: weapon.damage,
          kind: 'bullet',
          sourceId: player.id,
          point: hit.point,
          normal: hit.normal,
          knockback: { x: dir.x * weapon.knockback, y: dir.y * weapon.knockback * 0.5 - 1.5 },
        });
        continue; // 贯穿玩家
      }

      const runtime = this.registry.resolve(hit.body);
      if (!runtime) {
        endPoint = hit.point;
        break;
      }
      this.damageSystem.damageObject(runtime, {
        amount: weapon.damage,
        kind: 'bullet',
        sourceId: player.id,
        point: hit.point,
        normal: hit.normal,
      });

      // 可穿透材质（纸箱）继续；其余（墙/地面/金属）挡住光束
      if (!MATERIALS[runtime.material]?.bulletPierce) {
        endPoint = hit.point;
        break;
      }
    }

    this.fx.beam(from, endPoint, color, beam.duration, beam.width);
    return true;
  }

  /** 武器作废：从玩家手上摘掉并给反馈 */
  private breakWeapon(player: Player, reason: 'empty' | 'broken'): void {
    const id = player.heldWeapon?.id ?? '';
    player.heldWeapon = null;
    this.fx.burst(player.muzzle, reason === 'broken' ? 0xffa94d : 0x9aa5b1);
    this.scene.events.emit('weapon-lost', player, id, reason);
  }
}
