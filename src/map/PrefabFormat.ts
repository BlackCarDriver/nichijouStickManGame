/**
 * 预制件格式（v1）：多个「形状 + 材质」拼成一个可复用物体（桌子、箱子堆…）。
 *
 * 部件坐标是**局部坐标**，相对预制件锚点（anchor = center）。
 * 放置到地图时由 PrefabExpand.expandPrefab() 变换到世界坐标。
 */
import type { MapObject, MapWeaponSpawn } from './MapFormat';

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

/**
 * 预制件**内部关节**（局部坐标）。
 *
 * 用**部件下标**引用两端，不用部件 id：同一个预制件会放多个实例，
 * 部件的真实 id 是实例级生成的（`${instId}#${index}`），写死 id 会让两个实例撞 id
 * → 联机的“物体被摧毁”事件串到另一个实例上。
 *
 * 目前只支持 `revolute`（销轴，自由旋转），用于吹链 / 三节棍 / 可摆动吊平台。
 */
export interface PrefabJoint {
  /** 一端：`parts` 数组下标 */
  bodyA: number;
  /** 另一端：`parts` 下标；省略或 `"world"` = 固定在世界锚点 */
  bodyB?: number | 'world';
  /** 铰链点（**局部坐标**，相对预制件锚点 = 部件包围盒中心） */
  anchor: { x: number; y: number };
  /** 两端互不碰撞（链条/三节棍必开，否则旋转时端面互顶）；见 MapJoint.noCollide */
  noCollide?: boolean;
}

/**
 * 预制件里的**武器掉落点**（武器的摆放配置与地图 `weapons[]` 完全一致）。
 * 唯一区别：`x` / `y` 是**预制件局部坐标**（相对锚点 = 部件包围盒中心），
 * 实例化时按实例的位移/旋转/翻转换算到世界坐标。
 */
export type PrefabWeaponSpawn = MapWeaponSpawn;

export interface PrefabData {
  version: number;
  /** 唯一 id（= 文件名），地图用 ref 引用 */
  id: string;
  name: string;
  anchor?: PrefabAnchor;
  bodyMode?: PrefabBodyMode;
  parts: MapObject[];
  /** 预制件内部关节（仅 bodyMode = loose 有意义；焊接体整体是一个刚体） */
  joints?: PrefabJoint[];
  /** 预制件自带的武器掉落点（放实例时一起刷出来；坐标是局部坐标） */
  weapons?: PrefabWeaponSpawn[];
}
