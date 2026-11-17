import Phaser from 'phaser';
import type { PickupSystem } from './PickupSystem';
import type { MapData } from '../map/MapFormat';
import { listWeaponIds } from '../combat/WeaponFormat';

/**
 * 天降武器系统（全局自动空投）。
 *
 * **默认关闭**：地图只通过 `weapons[]`（武器掉落点）产出武器。
 * 需要"从天上随机掉、维持数量"的老玩法时，在地图里写：
 *   "autoDrop": { "enabled": true, "count": 4, "intervalMs": 2800, "initial": 3 }
 *
 * 投放位置优先使用地图的 `weaponDropZones`（编辑器里画的区域），
 * 没有配置时退化为地图宽度的中间安全区。
 */
export class DropSystem {
  private readonly scene: Phaser.Scene;
  private readonly pickups: PickupSystem;
  private readonly map: MapData;
  private timer = 0;

  /** 是否开启全局自动空投（默认关闭） */
  private readonly enabled: boolean;
  /** 地图上维持的武器数量 */
  private readonly targetCount: number;
  /** 补给检查间隔（ms） */
  private readonly checkInterval: number;

  private static readonly DEFAULT_COUNT = 4;
  private static readonly DEFAULT_INTERVAL = 2800;
  private static readonly DEFAULT_INITIAL = 3;

  private static readonly DROP_POOL = [
    'pistol',
    'ak47',
    'machinegun',
    'dagger',
    'spear',
    'grenade',
    'rocket',
    'laser',
    'lightsaber',
    'sniper',
    'shotgun',
  ];

  constructor(scene: Phaser.Scene, pickups: PickupSystem, map: MapData) {
    this.scene = scene;
    this.pickups = pickups;
    this.map = map;

    const cfg = map.autoDrop ?? {};
    this.enabled = cfg.enabled === true;
    this.targetCount = Math.max(0, cfg.count ?? DropSystem.DEFAULT_COUNT);
    this.checkInterval = Math.max(200, cfg.intervalMs ?? DropSystem.DEFAULT_INTERVAL);

    // 关闭时一个都不投：地图的武器完全由 weapons[]（武器掉落点）决定
    if (!this.enabled) return;
    const initial = Math.max(0, cfg.initial ?? DropSystem.DEFAULT_INITIAL);
    for (let i = 0; i < initial; i++) {
      this.dropOne();
    }
  }

  /** 是否开启了全局自动空投（状态栏/调试用） */
  get isEnabled(): boolean {
    return this.enabled;
  }

  update(deltaMs: number): void {
    if (!this.enabled) return;
    this.timer += deltaMs;
    if (this.timer < this.checkInterval) return;
    this.timer = 0;

    if (this.pickups.count < this.targetCount) {
      this.dropOne();
    }
  }

  private dropOne(): void {
    // 手榴弹是「腰上只能带 1 发」的道具：地上已经有一发没人捡时不再投掷，
    // 否则它会永久占住 TARGET_COUNT 的名额，把枪械挤掉。
    const grenadeOnGround = this.pickups.list.some(
      (item) => item.kind === 'weapon' && item.weaponId === 'grenade',
    );
    const pool = DropSystem.DROP_POOL.filter(
      (id) => listWeaponIds().includes(id) && !(id === 'grenade' && grenadeOnGround),
    );
    if (pool.length === 0) return;
    const weaponId = pool[Math.floor(Math.random() * pool.length)];

    const x = this.randomDropX();
    // 从地图上方掉下来
    this.pickups.spawn(weaponId, x, -40, { falling: true });
    this.scene.events.emit('weapon-dropped', weaponId, x);
  }

  private randomDropX(): number {
    const zones = this.map.weaponDropZones;
    if (zones && zones.length > 0) {
      const zone = zones[Math.floor(Math.random() * zones.length)];
      return zone.x + Math.random() * zone.w;
    }
    // 退化：宽度中间 60% 区域（避开两侧边界墙）
    const margin = this.map.width * 0.2;
    return margin + Math.random() * (this.map.width - margin * 2);
  }
}
