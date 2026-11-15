import Phaser from 'phaser';
import type { PickupSystem } from './PickupSystem';
import type { MapData } from '../map/MapFormat';
import { getItem, listItemIds } from './ItemFormat';

/**
 * 补给道具（医疗包 / 防弹衣）来源。
 *
 * 和武器保持**同一套规则**：
 * 1. **投放点**：地图 `weapons[]` 里写 `item: "medkit"`（编辑器「投放点」工具）——
 *    可控位置/刷新间隔，这是日常用的方式（见 `WeaponSpawnerSystem`）
 * 2. **地图固定生成点**：`map.items[]` → 开局直接生成在指定位置
 * 3. **天上掉**：只有地图显式开启 `autoDrop.enabled` 时才按 `maintain` 补货
 *    （与武器一致：默认关闭，关闭时天上什么都不掉）
 */
export class ItemDropSystem {
  private readonly scene: Phaser.Scene;
  private readonly pickups: PickupSystem;
  private readonly map: MapData;
  private timer = 0;

  /** 补给检查间隔（ms，默认与武器空投一致） */
  private static readonly DEFAULT_CHECK_INTERVAL = 2800;
  /** 投放高度（地图上方） */
  private static readonly DROP_Y = -40;

  /** 是否开启"天上掉补给"：跟随地图的 `autoDrop.enabled`（默认关闭） */
  private readonly autoDropEnabled: boolean;
  /** 补货检查间隔 */
  private readonly checkInterval: number;

  constructor(scene: Phaser.Scene, pickups: PickupSystem, map: MapData) {
    this.scene = scene;
    this.pickups = pickups;
    this.map = map;

    const cfg = map.autoDrop ?? {};
    this.autoDropEnabled = cfg.enabled === true;
    this.checkInterval = Math.max(200, cfg.intervalMs ?? ItemDropSystem.DEFAULT_CHECK_INTERVAL);

    // 1) 地图固定生成点（始终生效，和 weapons[] 投放点一样是"作者摆的位置"）
    for (const spawn of map.items ?? []) {
      if (!getItem(spawn.type)) {
        console.warn(`[ItemDropSystem] 未知道具类型: ${spawn.type}`);
        continue;
      }
      this.pickups.spawnItem(spawn.type, spawn.x, spawn.y, { falling: false });
    }

    // 2) 天上掉补给：只有显式开启 autoDrop 才补（与武器规则一致）
    if (this.autoDropEnabled) this.topUp();
  }

  update(deltaMs: number): void {
    if (!this.autoDropEnabled) return;
    this.timer += deltaMs;
    if (this.timer < this.checkInterval) return;
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
