/**
 * 预制件格式（v1）：多个「形状 + 材质」拼成一个可复用物体（桌子、箱子堆…）。
 *
 * 部件坐标是**局部坐标**，相对预制件锚点（anchor = center）。
 * 放置到地图时由 PrefabExpand.expandPrefab() 变换到世界坐标。
 */
import type { MapObject } from './MapFormat';

export const PREFAB_FORMAT_VERSION = 1;

/** 锚点位置。center = 部件包围盒中心 */
export type PrefabAnchor = 'center';
/** 物理形态：loose = 每个部件独立刚体（当前唯一实现，便于逐块破坏） */
export type PrefabBodyMode = 'loose';

export interface PrefabData {
  version: number;
  /** 唯一 id（= 文件名），地图用 ref 引用 */
  id: string;
  name: string;
  anchor?: PrefabAnchor;
  bodyMode?: PrefabBodyMode;
  parts: MapObject[];
}
