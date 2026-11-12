import Phaser from 'phaser';
import type { PickupSystem } from './PickupSystem';
import type { MapData } from '../map/MapFormat';
import { getItem, listItemIds } from './ItemFormat';

/**
 * 补给道具投放系统（医疗包 / 防弹衣）。
 *
 * 两个来源：
 * 1. **地图固定生成点**：`map.items`（编辑器里摆的点）→ 开局直接生成在指定位置
 * 2. **数量维持**：每种道具按 `data/items.json` 的 `maintain` 维持数量，
 *    不足时从地图上方掉落（和天降武器同一套规则，空中也能捡）
 *
 * 与 DropSystem 的分工：DropSystem 只管武器，本系统只管道具。
 */
export class ItemDropSystem {
  private readonly scene: Phaser.Scene;
  private readonly pickups: PickupSystem;
  private readonly map: MapData;
  private timer = 0;

  /** 补给检查间隔（ms） */
  private static readonly CHECK_INTERVAL = 2600;
  /** 投放高度（地图上方） */
  private static readonly DROP_Y = -40;

  constructor(scene: Phaser.Scene, pickups: PickupSystem, map: MapData) {
    this.scene = scene;
    this.pickups = pickups;
    this.map = map;

    // 1) 地图固定生成点
    for (const spawn of map.items ?? []) {
      if (!getItem(spawn.type)) {
        console.warn(`[ItemDropSystem] 未知道具类型: ${spawn.type}`);
        continue;
      }
      this.pickups.spawnItem(spawn.type, spawn.x, spawn.y, { falling: false });
    }

    // 2) 维持数量
    this.topUp();
  }

  update(deltaMs: number): void {
    this.timer += deltaMs;
    if (this.timer < ItemDropSystem.CHECK_INTERVAL) return;
    this.timer = 0;
    this.topUp();
  }

  /** 按 maintain 补齐每种道具 */
  private topUp(): void {
    for (const itemId of listItemIds()) {
      const def = getItem(itemId);
      if (!def) continue;
      const maintain = def.maintain ?? 0;
      let have = this.pickups.itemCount(itemId);
      while (have < maintain) {
        this.pickups.spawnItem(itemId, this.randomDropX(), ItemDropSystem.DROP_Y, { falling: true });
        this.scene.events.emit('item-dropped', itemId);
        have++;
      }
    }
  }

  private randomDropX(): number {
    const zones = this.map.weaponDropZones;
    if (zones && zones.length > 0) {
      const zone = zones[Math.floor(Math.random() * zones.length)];
      return zone.x + Math.random() * zone.w;
    }
    const margin = this.map.width * 0.2;
    return margin + Math.random() * (this.map.width - margin * 2);
  }
}
