import Phaser from 'phaser';
import type { PickupSystem } from './PickupSystem';
import type { MapData, MapWeaponSpawn } from '../map/MapFormat';
import { listWeaponIds } from '../combat/WeaponFormat';

/** 每个掉落点的运行状态 */
interface PointState {
  cfg: MapWeaponSpawn;
  index: number;
  /** 该点掉落的武器统一打上的来源标记 */
  tag: string;
  /** 刚被捡走、等待刷新 */
  waiting: boolean;
  /** 已刷新次数 */
  respawnCount: number;
  /** 刷新倒计时累计（ms） */
  timer: number;
  /** 上一次刷出的武器 id（日志/调试用） */
  lastWeapon?: string;
}

/** 掉落点从多高处落下来（px） */
const DROP_HEIGHT = 240;

/**
 * 武器掉落点系统（地图的"补给站"）。
 *
 * 数据来自 `map.weapons[]`，每个点支持：
 * - **固定武器**：mode='fixed' + weapon（旧字段 type 等价）
 * - **随机武器**：mode='random' + pool（不填 pool = 全部武器）
 * - **刷新**：respawnMs（被捡走后多久再刷，0 = 不刷）+ maxRespawns（最多刷几次，不填 = 无限）
 *
 * 判断"是否已被捡走"靠 PickupSystem 的 tag：每个点有自己的 tag，
 * 地上没有这个 tag 的掉落物 → 视为已被捡走，进入刷新倒计时。
 *
 * 与 DropSystem 的分工：DropSystem 负责"全局维持 N 把随机武器"（天上随机掉）；
 * 本系统只负责"地图作者指定的这些点"。
 */
export class WeaponSpawnerSystem {
  private readonly scene: Phaser.Scene;
  private readonly pickups: PickupSystem;
  private readonly states: PointState[] = [];

  constructor(scene: Phaser.Scene, pickups: PickupSystem, map: MapData) {
    this.scene = scene;
    this.pickups = pickups;

    (map.weapons ?? []).forEach((cfg, index) => {
      const state: PointState = {
        cfg,
        index,
        tag: `wspawn:${index}`,
        waiting: false,
        respawnCount: 0,
        timer: 0,
      };
      this.states.push(state);
      // 开局先刷一次
      if (this.spawnOne(state)) state.waiting = false;
    });
  }

  /** 掉落点数量（调试/状态栏用） */
  get count(): number {
    return this.states.length;
  }

  update(deltaMs: number): void {
    for (const st of this.states) {
      const present = this.pickups.hasTag(st.tag);
      if (present) {
        st.waiting = false;
        st.timer = 0;
        continue;
      }

      // 地上的武器没了（被捡走 / 掉出地图）→ 进入等待刷新
      if (!st.waiting) {
        st.waiting = true;
        st.timer = 0;
        st.respawnCount += 1;
      }

      const interval = st.cfg.respawnMs ?? 0;
      if (interval <= 0) continue; // 不刷新（只刷一次）
      const max = st.cfg.maxRespawns;
      if (max !== undefined && st.respawnCount > max) continue; // 次数用尽

      st.timer += deltaMs;
      if (st.timer >= interval) {
        st.timer = 0;
        if (this.spawnOne(st)) st.waiting = false;
      }
    }
  }

  /** 解析这个点这次该刷什么武器 */
  private pickWeapon(cfg: MapWeaponSpawn): string | null {
    const mode = cfg.mode ?? 'fixed';
    if (mode === 'fixed') {
      const id = cfg.weapon ?? cfg.type;
      return id ?? null;
    }
    // 随机：候选池过滤掉不存在的武器；池为空则用全部
    const all = listWeaponIds();
    const pool = (cfg.pool ?? []).filter((id) => all.includes(id));
    const effective = pool.length > 0 ? pool : all;
    if (effective.length === 0) return null;
    return effective[Math.floor(Math.random() * effective.length)];
  }

  /** 在某个点上刷一件武器（从空中落到该点附近） */
  private spawnOne(st: PointState): boolean {
    const weaponId = this.pickWeapon(st.cfg);
    if (!weaponId) {
      console.warn(`[WeaponSpawner] 掉落点 #${st.index} 无法确定武器（mode=${st.cfg.mode ?? 'fixed'}）`);
      return false;
    }
    const item = this.pickups.spawn(weaponId, st.cfg.x, Math.max(24, st.cfg.y - DROP_HEIGHT), {
      falling: true,
      tag: st.tag,
    });
    if (!item) {
      console.warn(`[WeaponSpawner] 掉落点 #${st.index} 未知武器 ${weaponId}`);
      return false;
    }
    st.lastWeapon = weaponId;
    this.scene.events.emit('weapon-spawned', weaponId, st.cfg.x, st.cfg.y);
    return true;
  }

  destroy(): void {
    this.states.length = 0;
  }
}
