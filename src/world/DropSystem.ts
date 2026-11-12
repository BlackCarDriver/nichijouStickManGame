import Phaser from 'phaser';
import type { PickupSystem } from './PickupSystem';
import type { MapData } from '../map/MapFormat';
import { listWeaponIds } from '../combat/WeaponFormat';

/**
 * 天降武器系统（需求 6）：地图上始终维持一定数量的武器，
 * 不足时从地图上方随机位置投放，空中即可被拾取。
 *
 * 投放位置优先使用地图的 `weaponDropZones`（编辑器里画的区域），
 * 没有配置时退化为地图宽度的中间安全区。
 */
export class DropSystem {
  private readonly scene: Phaser.Scene;
  private readonly pickups: PickupSystem;
  private readonly map: MapData;
  private timer = 0;

  /** 地图上维持的武器数量 */
  private static readonly TARGET_COUNT = 4;
  /** 补给检查间隔（ms） */
  private static readonly CHECK_INTERVAL = 1400;
  /** 开场立刻投放的数量（避免玩家开局没枪） */
  private static readonly INITIAL_COUNT = 3;

  private static readonly DROP_POOL = [
    'pistol',
    'ak47',
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

    for (let i = 0; i < DropSystem.INITIAL_COUNT; i++) {
      this.dropOne();
    }
  }

  update(deltaMs: number): void {
    this.timer += deltaMs;
    if (this.timer < DropSystem.CHECK_INTERVAL) return;
    this.timer = 0;

    if (this.pickups.count < DropSystem.TARGET_COUNT) {
      this.dropOne();
    }
  }

  private dropOne(): void {
    const pool = DropSystem.DROP_POOL.filter((id) => listWeaponIds().includes(id));
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
