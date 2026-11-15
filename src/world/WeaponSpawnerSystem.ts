import Phaser from 'phaser';
import type { PickupSystem } from './PickupSystem';
import { PICKUP_REST_OFFSET } from './PickupSystem';
import type { MapWeaponSpawn } from '../map/MapFormat';
import { listWeaponIds } from '../combat/WeaponFormat';
import { resolveDropContent, type DropContentDef } from './DropContent';

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
 * 数据来自 `map.weapons[]` **加**预制件实例自带的 `weapons[]`
 * （统一由 `collectMapWeapons()` 展开，含预制件的旋转/翻转），每个点支持：
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

  constructor(scene: Phaser.Scene, pickups: PickupSystem, weapons: MapWeaponSpawn[]) {
    this.scene = scene;
    this.pickups = pickups;

    weapons.forEach((cfg, index) => {
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

  /**
   * 解析这个点这次该刷什么（武器 or 补给道具）。
   *
   * 规则与服务端 `pickDropLocked` 保持一致：
   * - `mode: fixed`：`item` → 道具；否则 `weapon` / `type`（写道具 id 也认）
   * - `mode: random`：从 `pool` 里抽（武器/道具混排都支持）；池为空 = 全部武器
   */
  private pickContent(cfg: MapWeaponSpawn): DropContentDef | null {
    const mode = cfg.mode ?? 'fixed';
    if (mode === 'fixed') {
      return resolveDropContent(cfg.item ?? cfg.weapon ?? cfg.type);
    }
    const pool = (cfg.pool ?? []).map((id) => resolveDropContent(id)).filter((x): x is DropContentDef => !!x);
    if (pool.length === 0) {
      // 池为空（或全是无效 id）→ 退回"全部武器"，与旧行为一致
      const all = listWeaponIds();
      if (all.length === 0) return null;
      return resolveDropContent(all[Math.floor(Math.random() * all.length)]);
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * 在掉落点刷一件武器。
   *
   * 默认**直接落在作者放置的位置**（falling: false）：
   * 从天上掉会被画面上方的屋顶/门框挡住，最后停在"门上面"而不是刷新点里。
   * 想要从天而降的观感时，在 `weapons[]` 里给该点加 `"fromSky": true`。
   */
  private spawnOne(st: PointState): boolean {
    const content = this.pickContent(st.cfg);
    if (!content) {
      console.warn(`[WeaponSpawner] 投放点 #${st.index} 无法确定内容（mode=${st.cfg.mode ?? 'fixed'}）`);
      return false;
    }
    const fromSky = st.cfg.fromSky === true;
    // 原地生成时要抬到"落地时的视觉高度"（surface - REST_OFFSET），
    // 否则点正好落在平台表面时物品会陷进实体里（半埋 + 拾取变差）
    const y = fromSky ? Math.max(24, st.cfg.y - DROP_HEIGHT) : st.cfg.y - PICKUP_REST_OFFSET;

    const item =
      content.kind === 'weapon'
        ? this.pickups.spawn(content.id, st.cfg.x, y, { falling: fromSky, tag: st.tag })
        : this.pickups.spawnItem(content.id, st.cfg.x, y, { falling: fromSky, tag: st.tag });
    if (!item) {
      console.warn(`[WeaponSpawner] 投放点 #${st.index} 未知内容 ${content.kind}:${content.id}`);
      return false;
    }
    st.lastWeapon = content.id;
    if (content.kind === 'weapon') this.scene.events.emit('weapon-spawned', content.id, st.cfg.x, st.cfg.y);
    else this.scene.events.emit('item-dropped', content.id);
    return true;
  }

  destroy(): void {
    this.states.length = 0;
  }
}
