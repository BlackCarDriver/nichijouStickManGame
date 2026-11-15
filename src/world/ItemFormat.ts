/**
 * 道具表（数据源：data/items.json）。
 *
 * 与 materials.json / weapons.json 同一套风格：JSON 是唯一真源，颜色用 hex 字符串。
 * 道具 = 地上的可拾取物（触碰即用，不占用武器槽）：
 *   - heal   : 恢复生命值（非满血时自动拾取）
 *   - shield : 增加护盾值（护盾未满时自动拾取）
 */
import rawItems from '../../data/items.json';

export type ItemKind = 'heal' | 'shield';

export interface ItemJson {
  name: string;
  kind: ItemKind;
  /** heal：恢复的生命值 */
  heal?: number;
  /** shield：增加的护盾值 */
  shield?: number;
  /**
   * 天上掉补给的维持数量（与武器 `autoDrop` 同一套规则）：
   * **只有地图开启 `autoDrop.enabled` 时才生效**；默认关闭 → 只能靠投放点/固定点
   */
  maintain?: number;
  /** 拾取半径（px） */
  pickupRadius?: number;
  /** 主体颜色（hex） */
  color: string;
  /** 光晕颜色（hex，不填 = 用 color） */
  glow?: string;
}

interface ItemsFile {
  version: number;
  items: Record<string, ItemJson>;
}

/** 道具表（只读） */
export const ITEMS: Readonly<Record<string, ItemJson>> = (rawItems as ItemsFile).items;

/** 默认拾取半径 */
export const DEFAULT_ITEM_PICKUP_RADIUS = 52;

export function getItem(id: string): ItemJson | undefined {
  return ITEMS[id];
}

/** 道具 id 列表（按 json 顺序） */
export function listItemIds(): string[] {
  return Object.keys(ITEMS);
}

export function itemPickupRadius(def: ItemJson): number {
  return def.pickupRadius ?? DEFAULT_ITEM_PICKUP_RADIUS;
}
