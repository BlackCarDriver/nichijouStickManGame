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
/**
 * 物理形态：
 * - loose    每个部件是独立刚体（可逐块破坏，但整体受力时可能散架/错位）
 * - compound 所有部件焊接成一个复合刚体（整体被推/被炸飞，整体掉耐久；
 *            物理属性统一取自「面积最大的部件」的材质）
 */
export type PrefabBodyMode = 'loose' | 'compound';

export interface PrefabData {
  version: number;
  /** 唯一 id（= 文件名），地图用 ref 引用 */
  id: string;
  name: string;
  anchor?: PrefabAnchor;
  bodyMode?: PrefabBodyMode;
  parts: MapObject[];
}
