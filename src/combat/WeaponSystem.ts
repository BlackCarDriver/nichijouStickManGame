import Phaser from 'phaser';
import { MATERIALS, parseColor } from '../config/materials';
import type { Player } from '../entities/Player';
import type { WorldRegistry } from '../world/WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageSystem } from './DamageSystem';
import type { ProjectileSystem } from './ProjectileSystem';
import { getWeapon, createHeldWeapon } from './WeaponFormat';
import type { WeaponJson, BulletConfig } from './WeaponFormat';
import { raycast, getWorldBodies } from './Raycast';

/** 玩家这一帧的攻击意图 */
export interface AttackInput {
  /** 本帧刚按下（单发/近战用） */
  attack: boolean;
  /** 持续按住（全自动武器用） */
  attackHeld: boolean;
}

const KICK = {
  range: 76,
  damage: 12,
  knockback: 13,
  cooldownSec: 0.42,
  /** 判定角度容差（弧度）：只踢前方半圆 */
  halfAngle: Math.PI * 0.55,
} as const;

/**
 * 武器系统：装备、开火节流、弹药与耐久消耗、近战刺击、投掷、踢。
 *
 * 三种主攻击（由 weapons.json 的 attackMode 决定）：
 *   - shoot：逻辑弹道子弹（抛物线，有飞行时间）
 *   - beam ：瞬时光束 hitscan（激光，贯穿）
 *   - melee ：近战刺击（匕首/长矛）
 *   - throw ：投掷（手榴弹；匕首/长矛的"投掷"走 trySecondary）
 */
export class WeaponSystem {
  private readonly scene: Phaser.Scene;
  private readonly projectiles: ProjectileSystem;
  private readonly damageSystem: DamageSystem;
  private readonly registry: WorldRegistry;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly fx: FxSystem;
  /** playerId → 剩余攻击冷却（秒） */
  private readonly cooldowns = new Map<number, number>();
  /** playerId → 剩余踢冷却（秒） */
  private readonly kickCooldowns = new Map<number, number>();

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
    this.tickMap(this.cooldowns, dt);
    this.tickMap(this.kickCooldowns, dt);
  }

  private tickMap(map: Map<number, number>, dt: number): void {
    for (const [id, cd] of map) {
      const next = cd - dt;
      if (next <= 0) map.delete(id);
      else map.set(id, next);
    }
  }

  /**
   * 主攻击（左键/空格）。
   * 全自动武器在按住时持续开火；单发武器只在按下的那一帧开火。
   */
  tryAttack(player: Player, input: AttackInput): boolean {
    const held = player.heldWeapon;
    if (!held || player.health.isDead) return false;

    const weapon = getWeapon(held.id);
    if (!weapon) return false;

    // 全自动 → 按住即连射；其余 → 只有按下瞬间触发
    if (!(weapon.automatic ? input.attackHeld || input.attack : input.attack)) return false;
    if (this.cooldowns.has(player.id)) return false;

    // 弹药耗尽 → 武器脱手（W5 会实体化掉落）
    if (held.ammo === 0) {
      this.releaseWeapon(player, 'empty');
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
      case 'melee':
        fired = this.stab(player, weapon);
        break;
      case 'throw':
        fired = this.throwWeapon(player, weapon);
        break;
      default:
        return false;
    }
    if (!fired) return false;

    this.consume(player, weapon, held.ammo > 0);
    return true;
  }

  /**
   * 副攻击（右键 / Shift）：上下文相关。
   * 手持可投掷的近战武器（匕首/长矛）→ 投掷（消耗该武器）；
   * 其他情况 → 踢。
   */
  trySecondary(player: Player): boolean {
    if (player.health.isDead) return false;
    const held = player.heldWeapon;
    const weapon = held ? getWeapon(held.id) : undefined;
    if (weapon?.attackMode === 'melee' && weapon.throw) {
      if (this.cooldowns.has(player.id)) return false;
      if (this.throwWeapon(player, weapon)) {
        this.consume(player, weapon, false);
        return true;
      }
      return false;
    }
    return this.kick(player);
  }

  /** 踢：把敌人弹飞（伤害较小，击退很大），同时推开面前的可推物体 */
  tryKick(player: Player): boolean {
    return this.kick(player);
  }

  private kick(player: Player): boolean {
    if (this.kickCooldowns.has(player.id)) return false;
    this.kickCooldowns.set(player.id, KICK.cooldownSec);
    player.setAttack('kick', 260);

    const aim = player.aim;
    const fromX = player.container.x;
    const fromY = player.container.y;
    const dirX = Math.cos(aim);
    const dirY = Math.sin(aim);
    const cosHalf = Math.cos(KICK.halfAngle);
    let hitSomething = false;

    // 玩家
    for (const other of this.bodyToPlayer.values()) {
      if (other === player || other.health.isDead) continue;
      const dx = other.container.x - fromX;
      const dy = other.container.y - fromY;
      const dist = Math.hypot(dx, dy);
      if (dist > KICK.range) continue;
      const dot = dist < 1 ? 1 : (dx * dirX + dy * dirY) / dist;
      if (dot < cosHalf) continue;

      this.damageSystem.damagePlayer(other, {
        amount: KICK.damage,
        kind: 'kick',
        sourceId: player.id,
        point: { x: other.container.x, y: other.container.y },
        knockback: {
          x: dirX * KICK.knockback,
          y: dirY * KICK.knockback * 0.4 - 7,
        },
      });
      hitSomething = true;
    }

    // 可推物体（箱子/球）
    const bodies = getWorldBodies(this.scene);
    for (const body of bodies) {
      if (body.isStatic || body.isSensor) continue;
      if (body === player.body) continue;
      const dx = body.position.x - fromX;
      const dy = body.position.y - fromY;
      const dist = Math.hypot(dx, dy);
      if (dist > KICK.range + 20) continue;
      const dot = dist < 1 ? 1 : (dx * dirX + dy * dirY) / dist;
      if (dot < cosHalf) continue;
      const k = body.mass * 6 * (1 / 277);
      this.scene.matter.body.applyForce(body, body.position, {
        x: dirX * k,
        y: (dirY * k) - body.mass * 2 * (1 / 277),
      });
      hitSomething = true;
    }

    if (hitSomething) {
      this.fx.hitSpark(
        { x: fromX + dirX * 40, y: fromY + dirY * 40 },
        { x: dirX, y: dirY },
        0xffffff,
      );
    }
    return true;
  }

  /** 消耗弹药/耐久，并在耗尽时处理武器去向 */
  private consume(player: Player, weapon: WeaponJson, usesAmmo: boolean): void {
    const held = player.heldWeapon;
    if (!held) return;
    if (usesAmmo && held.ammo > 0) held.ammo -= 1;
    held.durability -= weapon.durabilityPerShot;
    this.cooldowns.set(player.id, 1 / Math.max(0.01, weapon.fireRate));

    if (held.durability <= 0) {
      this.releaseWeapon(player, 'broken');
    } else if (held.ammo === 0) {
      // 弹匣打空 → 武器脱手（W5：实体化为地上的可拾取物）
      this.releaseWeapon(player, 'empty');
    }
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
      explosion: weapon.explosion,
    });

    this.fx.hitSpark(from, { x: Math.cos(angle), y: Math.sin(angle) }, parseColor(bullet.color));
    player.setAttack('stab', 90); // 轻微后坐
    return true;
  }

  /** 瞬时光束（hitscan）：贯穿玩家与可穿透材质，遇阻终止 */
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
    const damaged = new Set<number>();

    for (const hit of hits) {
      if (damaged.has(hit.body.id)) continue;
      damaged.add(hit.body.id);

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
      if (!MATERIALS[runtime.material]?.bulletPierce) {
        endPoint = hit.point;
        break;
      }
    }

    this.fx.beam(from, endPoint, color, beam.duration, beam.width);
    player.setAttack('stab', 90);
    return true;
  }

  /** 近战刺击：手/武器尖端向前一条短射线 */
  private stab(player: Player, weapon: WeaponJson): boolean {
    const melee = weapon.melee;
    if (!melee) return false;

    const from = player.muzzle;
    const angle = player.aim;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    player.setAttack('stab', 200);

    const hits = raycast(getWorldBodies(this.scene), from, dir, melee.reach, {
      ignore: [player.body],
      maxHits: 1,
    });
    const hit = hits[0];
    if (!hit) return true; // 挥空也算一次攻击（消耗耐久）

    const target = this.bodyToPlayer.get(hit.body.id);
    if (target) {
      this.damageSystem.damagePlayer(target, {
        amount: weapon.damage,
        kind: 'melee',
        sourceId: player.id,
        point: hit.point,
        normal: hit.normal,
        knockback: { x: dir.x * weapon.knockback, y: dir.y * weapon.knockback * 0.4 - 2 },
      });
      return true;
    }

    const runtime = this.registry.resolve(hit.body);
    if (runtime) {
      this.damageSystem.damageObject(runtime, {
        amount: weapon.damage,
        kind: 'melee',
        sourceId: player.id,
        point: hit.point,
        normal: hit.normal,
      });
    }
    return true;
  }

  /** 投掷武器（匕首/长矛 → 插入停留；手榴弹 → 引信爆炸） */
  private throwWeapon(player: Player, weapon: WeaponJson): boolean {
    const cfg = weapon.throw;
    if (!cfg) return false;

    const from = player.muzzle;
    const angle = player.aim;
    player.setAttack('stab', 160);

    const bullet: BulletConfig = {
      kind: weapon.attackMode === 'melee' ? 'thrown' : 'grenade',
      speed: cfg.speed,
      gravity: cfg.gravity ?? 800,
      range: cfg.range,
      size: weapon.visual.thickness * 0.6,
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
      weaponId: weapon.visual.style,
      x: from.x,
      y: from.y,
      angle,
      damage: cfg.damage ?? weapon.damage,
      knockback: weapon.knockback,
      ownerId: player.id,
      ownerBody: player.body,
      bullet,
      explosion: weapon.explosion,
      fuseMs: cfg.fuseMs,
      stickMs: cfg.stickMs,
    });

    // 近战投掷：武器脱手（超出后就没有了）
    if (weapon.attackMode === 'melee') {
      this.releaseWeapon(player, 'thrown');
    }
    return true;
  }

  /**
   * 武器脱手。
   * - empty：弹匣打空 → 广播事件（W5 的 PickupSystem 会在地面生成可拾取物）
   * - broken：耐久耗尽 → 销毁
   * - thrown：投掷出去 → 不返回
   */
  private releaseWeapon(player: Player, reason: 'empty' | 'broken' | 'thrown'): void {
    const held = player.heldWeapon;
    if (!held) return;
    const id = held.id;
    const snapshot = { id, ammo: held.ammo, durability: held.durability };
    player.heldWeapon = null;

    if (reason === 'broken') {
      this.fx.burst(player.muzzle, 0xffa94d);
    }
    this.scene.events.emit('weapon-lost', player, id, reason, snapshot);
  }
}
