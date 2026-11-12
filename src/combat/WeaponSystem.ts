import Phaser from 'phaser';
import { MATERIALS, parseColor } from '../config/materials';
import type { Player } from '../entities/Player';
import type { WorldRegistry } from '../world/WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageSystem } from './DamageSystem';
import type { ProjectileSystem } from './ProjectileSystem';
import { getWeapon, createHeldWeapon } from './WeaponFormat';
import type { WeaponJson, BulletConfig, BeamConfig } from './WeaponFormat';
import type { MapObjectRuntime } from '../map/MapLoader';
import { raycast, getWorldBodies } from './Raycast';
import { TrajectoryPreview } from './TrajectoryPreview';

/** 玩家这一帧的攻击意图 */
export interface AttackInput {
  /** 本帧刚按下（单发/近战用） */
  attack: boolean;
  /** 持续按住（全自动武器用） */
  attackHeld: boolean;
}

/** 光束沿途的可伤害目标 */
interface BeamTarget {
  player?: Player;
  runtime?: MapObjectRuntime;
  point: { x: number; y: number };
  normal: { x: number; y: number };
}

/** 空手出拳（无武器时的基础攻击） */
const PUNCH = {
  reach: 46,
  damage: 7,
  knockback: 4,
  cooldownSec: 0.36,
} as const;

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
  /** playerId → 连续光束的 tick 计时（存在即表示正在输出） */
  private readonly beams = new Map<number, { timer: number }>();
  /** 攻击批次自增 id（一次扣扳机 = 一个批次，霰弹的多弹丸共用） */
  private attackSeq = 0;
  /** 正在"瞄准投掷"的玩家（按住副攻击键时显示抛物线预览） */
  private readonly throwAiming = new Set<number>();
  private preview!: TrajectoryPreview;

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
    this.preview = new TrajectoryPreview(scene, 829);
  }

  destroy(): void {
    this.preview.destroy();
  }

  /** 该玩家手持的武器是否可投掷（匕首/长矛） */
  private throwableWeaponOf(player: Player): WeaponJson | undefined {
    const held = player.heldWeapon;
    const weapon = held ? getWeapon(held.id) : undefined;
    return weapon?.attackMode === 'melee' && weapon.throw ? weapon : undefined;
  }

  /** 是否正在瞄准投掷 */
  isAimingThrow(player: Player): boolean {
    return this.throwAiming.has(player.id);
  }

  /** 开始瞄准投掷（按住右键）：仅对可投掷的近战武器生效 */
  beginThrowAim(player: Player): boolean {
    if (player.health.isDead) return false;
    if (!this.throwableWeaponOf(player)) return false;
    this.throwAiming.add(player.id);
    return true;
  }

  /**
   * 每帧推进投掷瞄准：
   * - 按住 → 画抛物线预览（与真实投掷同一套模拟）
   * - 松开 → 投出
   */
  updateThrowAim(player: Player, holding: boolean): void {
    if (!this.throwAiming.has(player.id)) return;

    // 死亡 / 换掉武器 / 武器没了 → 取消
    const weapon = this.throwableWeaponOf(player);
    if (player.health.isDead || !weapon) {
      this.throwAiming.delete(player.id);
      return;
    }

    if (!holding) {
      // 松开 → 投出
      this.throwAiming.delete(player.id);
      if (this.cooldowns.has(player.id)) return;
      if (this.throwWeapon(player, weapon)) {
        this.consume(player, weapon, false);
      }
      return;
    }

    // 按住 → 画预览
    const preview = this.preview;
    const cfg = weapon.throw;
    if (!cfg) return;
    const path = preview.compute(
      player.muzzle,
      player.aim,
      cfg.speed,
      cfg.range,
      [player.body],
    );
    preview.drawPath(path, weapon.visual.color, 0.9);
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
    // 投掷预览：每帧清空并推进一次蚂蚁线相位（多人同时瞄准时共用一张画布）
    this.preview.clear();
    this.preview.tick(deltaMs);
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
    if (player.health.isDead) return false;
    // 手持手榴弹时，左键交给 GrenadeSystem 处理投掷
    if (player.grenadeMode) return false;

    // 空手 → 出拳（单发，不能长按连打）
    const held = player.heldWeapon;
    if (!held) {
      if (!input.attack) return false;
      if (this.cooldowns.has(player.id)) return false;
      this.cooldowns.set(player.id, PUNCH.cooldownSec);
      return this.punch(player);
    }

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
        // 连续光束（激光）由 updateContinuous 每帧驱动，这里不处理
        if (weapon.beam?.continuous) return false;
        fired = this.fireBeam(player, weapon);
        break;
      case 'melee':
        fired = this.meleeAttack(player, weapon);
        break;
      case 'throw':
        fired = this.throwWeapon(player, weapon);
        break;
      default:
        return false;
    }
    if (!fired) return false;

    this.consume(player, weapon, held.ammo > 0);
    this.applyRecoil(player, weapon);
    this.scene.events.emit('sfx', weapon.visual.style === 'lightsaber' ? 'melee' : (player.heldWeapon?.id ?? ''));
    return true;
  }

  /** 应用武器后坐力：枪口上抬 + 自身后推 + 广播事件（重武器触发镜头震动） */
  private applyRecoil(player: Player, weapon: WeaponJson): void {
    const recoil = weapon.recoil;
    if (!recoil) return;
    if (recoil.push <= 0 && recoil.climbDeg <= 0) return;
    player.applyRecoil(recoil.push, recoil.climbDeg, recoil.climbMaxDeg, recoil.recoverMs);
    this.scene.events.emit('weapon-recoil', player, recoil.push);
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

  /** 空手出拳：手部向前的短射线，伤害低但能用 */
  private punch(player: Player): boolean {
    player.setAttack('stab', 150);
    this.scene.events.emit('sfx', 'melee');
    const from = player.handWorld;
    const aim = player.aim;
    const dir = { x: Math.cos(aim), y: Math.sin(aim) };

    const hits = raycast(getWorldBodies(this.scene), from, dir, PUNCH.reach, {
      ignore: [player.body],
      maxHits: 1,
    });
    const hit = hits[0];
    if (!hit) return true;

    const knockback = { x: dir.x * PUNCH.knockback, y: dir.y * PUNCH.knockback * 0.4 - 1.5 };
    const target = this.bodyToPlayer.get(hit.body.id);
    if (target) {
      this.damageSystem.damagePlayer(target, {
        amount: PUNCH.damage,
        kind: 'melee',
        sourceId: player.id,
        point: hit.point,
        normal: hit.normal,
        knockback,
      });
      this.fx.hitSpark(hit.point, hit.normal, 0xffffff);
      return true;
    }

    const runtime = this.registry.resolve(hit.body);
    if (runtime) {
      this.damageSystem.damageObject(runtime, {
        amount: PUNCH.damage,
        kind: 'melee',
        sourceId: player.id,
        point: hit.point,
        normal: hit.normal,
      });
      this.fx.hitSpark(hit.point, hit.normal, 0xffffff);
    }
    return true;
  }

  /** 踢：把敌人弹飞（伤害较小，击退很大），同时推开面前的可推物体 */
  tryKick(player: Player): boolean {
    return this.kick(player);
  }

  private kick(player: Player): boolean {
    if (this.kickCooldowns.has(player.id)) return false;
    this.kickCooldowns.set(player.id, KICK.cooldownSec);
    player.setAttack('kick', 260);
    this.scene.events.emit('sfx', 'kick');

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

  /**
   * 发射逻辑弹道子弹。
   * 支持多弹丸（霰弹枪）：在 ±spreadDeg 内均匀分布 + 少量随机抖动。
   * 同一次开火的所有弹丸共用 attackId，因此都能命中同一目标。
   */
  private fireProjectile(player: Player, weapon: WeaponJson): boolean {
    const bullet = weapon.bullet;
    if (!bullet) return false;
    const from = player.muzzle;
    const angle = player.aim;
    const pellets = Math.max(1, bullet.pellets ?? 1);
    const spread = ((bullet.spreadDeg ?? 0) * Math.PI) / 180;
    const attackId = ++this.attackSeq;

    for (let i = 0; i < pellets; i++) {
      // 均匀分布（多弹丸时避免全打同一个点），再加一点随机抖动
      const t = pellets === 1 ? 0 : i / (pellets - 1) - 0.5;
      const jitter = pellets === 1 ? 0 : (Math.random() - 0.5) * (spread / pellets);
      // t ∈ [-0.5, 0.5] → 角度偏移 ∈ [-spread, +spread]
      const pelletAngle = angle + t * spread * 2 + jitter;
      this.projectiles.spawn({
        weaponId: player.heldWeapon?.id ?? '',
        x: from.x,
        y: from.y,
        angle: pelletAngle,
        damage: weapon.damage,
        knockback: weapon.knockback,
        ownerId: player.id,
        ownerBody: player.body,
        bullet,
        explosion: weapon.explosion,
        attackId,
      });
    }

    this.fx.hitSpark(from, { x: Math.cos(angle), y: Math.sin(angle) }, parseColor(bullet.color));
    player.setAttack('stab', 90); // 轻微后坐
    return true;
  }

  // ==========================================================
  //  光束（单发 / 连续）
  // ==========================================================

  /** 光束沿途的一个可伤害目标 */
  private traceBeam(
    player: Player,
    beam: BeamConfig,
    from: { x: number; y: number },
    dir: { x: number; y: number },
  ): { endPoint: { x: number; y: number }; targets: BeamTarget[] } {
    const bodies = getWorldBodies(this.scene);
    const hits = raycast(bodies, from, dir, beam.range, {
      ignore: [player.body],
      maxHits: 48,
    });

    const targets: BeamTarget[] = [];
    const damaged = new Set<number>();
    let endPoint = { x: from.x + dir.x * beam.range, y: from.y + dir.y * beam.range };

    for (const hit of hits) {
      if (damaged.has(hit.body.id)) continue;
      damaged.add(hit.body.id);

      const target = this.bodyToPlayer.get(hit.body.id);
      if (target) {
        targets.push({ player: target, point: hit.point, normal: hit.normal });
        // 默认不可穿透：命中第一个玩家就终止
        if (!beam.pierce) {
          endPoint = hit.point;
          break;
        }
        continue;
      }

      const runtime = this.registry.resolve(hit.body);
      if (!runtime) {
        endPoint = hit.point;
        break;
      }
      targets.push({ runtime, point: hit.point, normal: hit.normal });
      // 默认不可穿透：首个目标即终止；pierce=true 时才看材质是否可穿透
      if (!beam.pierce || !MATERIALS[runtime.material]?.bulletPierce) {
        endPoint = hit.point;
        break;
      }
    }

    return { endPoint, targets };
  }

  /** 对光束沿途目标结算一次伤害 */
  private applyBeamDamage(
    player: Player,
    weapon: WeaponJson,
    trace: { targets: BeamTarget[] },
    dir: { x: number; y: number },
    ignoreInvuln: boolean,
    attackId: number,
  ): void {
    for (const t of trace.targets) {
      if (t.player) {
        this.damageSystem.damagePlayer(t.player, {
          amount: weapon.damage,
          kind: 'bullet',
          sourceId: player.id,
          point: t.point,
          normal: t.normal,
          knockback: {
            x: dir.x * weapon.knockback,
            y: dir.y * weapon.knockback * 0.5 - 0.8,
          },
          ignoreInvuln,
          attackId,
        });
      } else if (t.runtime) {
        this.damageSystem.damageObject(t.runtime, {
          amount: weapon.damage,
          kind: 'bullet',
          sourceId: player.id,
          point: t.point,
          normal: t.normal,
        });
      }
    }
  }

  /** 画光束（连续模式里外层加一圈更宽的辉光，看起来像粒子束） */
  private drawBeam(
    from: { x: number; y: number },
    endPoint: { x: number; y: number },
    beam: BeamConfig,
    lifeMs: number,
  ): void {
    const color = parseColor(beam.color, 0x7ef9ff);
    this.fx.beam(from, endPoint, color, lifeMs, beam.width + 4);
    this.fx.beam(from, endPoint, 0xffffff, lifeMs * 0.8, Math.max(1.5, beam.width * 0.45));
  }

  /**
   * 连续光束（激光枪）：每帧由场景调用。
   *
   * 按住攻击键 → 持续输出光束 + 按 tickMs 间隔持续造成伤害（低伤高频，像机枪）；
   * 松开 / 换武器 / 死亡 → 立即停止。每 tick 扣 1 点弹药与耐久。
   */
  updateContinuous(player: Player, wantFire: boolean, deltaMs: number): void {
    const held = player.heldWeapon;
    const weapon = held ? getWeapon(held.id) : undefined;
    const beam = weapon?.beam;

    if (!beam?.continuous || !wantFire || player.health.isDead || !held || !weapon) {
      this.beams.delete(player.id);
      return;
    }

    const from = player.muzzle;
    const dir = { x: Math.cos(player.aim), y: Math.sin(player.aim) };
    const trace = this.traceBeam(player, beam, from, dir);

    // 视觉每帧重画（寿命略大于一帧，避免闪烁断裂）
    this.drawBeam(from, trace.endPoint, beam, 70);

    // tick 计时：到点才结算伤害
    const tickMs = beam.tickMs ?? 60;
    const state = this.beams.get(player.id) ?? { timer: 0 };
    this.beams.set(player.id, state);
    state.timer -= deltaMs;
    if (state.timer > 0) return;
    state.timer = tickMs;

    this.applyBeamDamage(player, weapon, trace, dir, true, player.id);
    this.applyRecoil(player, weapon);

    // 消耗：每 tick 1 发弹药 + 耐久
    if (held.ammo > 0) held.ammo -= 1;
    held.durability -= weapon.durabilityPerShot;

    if (held.durability <= 0) {
      this.releaseWeapon(player, 'broken');
    } else if (held.ammo === 0) {
      this.releaseWeapon(player, 'empty');
    }
  }

  /** 瞬时光束（非连续模式：点一次打一发，贯穿玩家与可穿透材质，遇阻终止） */
  private fireBeam(player: Player, weapon: WeaponJson): boolean {
    const beam = weapon.beam;
    if (!beam) return false;

    const from = player.muzzle;
    const dir = { x: Math.cos(player.aim), y: Math.sin(player.aim) };
    const trace = this.traceBeam(player, beam, from, dir);

    this.applyBeamDamage(player, weapon, trace, dir, false, ++this.attackSeq);
    this.drawBeam(from, trace.endPoint, beam, beam.duration);
    player.setAttack('stab', 90);
    return true;
  }

  /**
   * 近战攻击。
   * - stab（匕首/长矛）：手部向前一条短射线，命中单体
   * - slash（光刀）：沿 arc 扫过一整段弧，每个目标只结算一次（可一刀扫多人）
   */
  private meleeAttack(player: Player, weapon: WeaponJson): boolean {
    const melee = weapon.melee;
    if (!melee) return false;
    if ((melee.anim ?? 'stab') === 'slash') {
      return this.slash(player, weapon);
    }
    return this.stab(player, weapon);
  }

  /**
   * 挥砍：以手部为圆心的**扇区判定**（角度 + 距离 + 视线），
   * 而不是"N 条采样射线"。采样法在采样间隔处会漏掉小目标；
   * 扇区判定没有空隙，一刀可以稳定扫中弧内所有目标。
   */
  private slash(player: Player, weapon: WeaponJson): boolean {
    const melee = weapon.melee;
    if (!melee) return false;

    player.setAttack('slash', 280);
    const from = player.handWorld;
    const aim = player.aim;
    const halfArc = ((melee.arc ?? 40) * Math.PI) / 180;
    const reach = melee.reach;
    const bodies = getWorldBodies(this.scene);
    const hitPlayers = new Set<number>();
    const hitBodies = new Set<number>();

    /**
     * 判断目标是否在扇形内。
     * @param radius 目标近似半径（用于放宽角度与距离判定，避免"擦边必漏"）
     * @returns 手部到目标的距离；不在扇形内返回 null
     */
    const sectorDistance = (tx: number, ty: number, radius: number): number | null => {
      const dx = tx - from.x;
      const dy = ty - from.y;
      const dist = Math.hypot(dx, dy);
      if (dist > reach + radius) return null;
      let diff = Math.atan2(dy, dx) - aim;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const tolerance = halfArc + Math.atan2(radius, Math.max(1, dist));
      if (Math.abs(diff) > tolerance) return null;
      return dist;
    };

    /** 视线检查：手部到目标之间是否被别的物体挡住 */
    const hasLineOfSight = (tx: number, ty: number, dist: number, ignore: MatterJS.BodyType[]): boolean => {
      const dx = tx - from.x;
      const dy = ty - from.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) return true;
      const hits = raycast(
        bodies,
        from,
        { x: dx / len, y: dy / len },
        Math.max(0, Math.min(reach, dist - 4)),
        { ignore: [player.body, ...ignore], maxHits: 1 },
      );
      return hits.length === 0;
    };

    // ---- 玩家 ----
    for (const other of this.bodyToPlayer.values()) {
      if (other === player || other.health.isDead) continue;
      if (hitPlayers.has(other.id)) continue;
      const radius = 34; // 火柴人近似半径
      const dist = sectorDistance(other.container.x, other.container.y, radius);
      if (dist === null) continue;
      if (!hasLineOfSight(other.container.x, other.container.y, dist, [other.body])) continue;

      hitPlayers.add(other.id);
      const nx = dist > 1 ? (other.container.x - from.x) / dist : Math.cos(aim);
      const ny = dist > 1 ? (other.container.y - from.y) / dist : Math.sin(aim);
      this.damageSystem.damagePlayer(other, {
        amount: weapon.damage,
        kind: 'melee',
        sourceId: player.id,
        point: { x: other.container.x, y: other.container.y },
        normal: { x: -nx, y: -ny },
        knockback: { x: nx * weapon.knockback, y: ny * weapon.knockback * 0.4 - 2 },
      });
    }

    // ---- 地图物体 ----
    for (const runtime of this.registry.objects) {
      const body = runtime.body;
      if (!body) continue;
      if (hitBodies.has(body.id)) continue;
      const b = body.bounds as unknown as { min: { x: number; y: number }; max: { x: number; y: number } };
      const radius = Math.max(b.max.x - b.min.x, b.max.y - b.min.y) / 2;
      const dist = sectorDistance(body.position.x, body.position.y, radius);
      if (dist === null) continue;
      if (!hasLineOfSight(body.position.x, body.position.y, dist, [body])) continue;

      hitBodies.add(body.id);
      this.damageSystem.damageObject(runtime, {
        amount: weapon.damage,
        kind: 'melee',
        sourceId: player.id,
        point: { x: body.position.x, y: body.position.y },
        normal: { x: from.x - body.position.x, y: from.y - body.position.y },
      });
    }

    // 刀光：沿弧线画一段亮线
    this.fx.beam(
      {
        x: from.x + Math.cos(aim - halfArc) * reach,
        y: from.y + Math.sin(aim - halfArc) * reach,
      },
      {
        x: from.x + Math.cos(aim + halfArc) * reach,
        y: from.y + Math.sin(aim + halfArc) * reach,
      },
      0x9fe8ff,
      150,
      3,
    );
    return true;
  }

  /** 近战刺击：手/武器尖端向前一条短射线 */
  private stab(player: Player, weapon: WeaponJson): boolean {
    const melee = weapon.melee;
    if (!melee) return false;

    const from = player.handWorld;
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
      range: cfg.range,
      // 投掷物按武器本体渲染：trail = 武器长度，size = 粗细
      size: Math.max(2, weapon.visual.thickness * 0.85),
      color: weapon.visual.color,
      trail: weapon.attackMode === 'melee' ? weapon.visual.length : 0,
      maxBounces: 0,
      bounceDamageMul: 1,
      pierceDamageMul: 1,
      piercePlayers: false,
      bounceAny: cfg.bounceAny,
      bounceRestitution: cfg.bounceRestitution,
    };

    this.projectiles.spawn({
      // 用真实武器 id（匕首/长矛），插不进去时场景据此在落点生成掉落物
      weaponId: player.heldWeapon?.id ?? weapon.visual.style,
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

    this.scene.events.emit('sfx', 'throw');

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
