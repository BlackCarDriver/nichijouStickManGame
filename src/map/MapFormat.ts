/**
 * 地图文件格式（v1）。
 *
 * 坐标系：左上角为原点，y 向下，单位 px。
 * **锚点约定（重要，编辑器依赖）**：
 *   - rect  : x,y = 左上角，w,h = 宽高
 *   - circle: x,y = 圆心
 *   - polygon: x,y = 中心，vertices 为相对中心的顶点
 * 旋转（angle）一律绕**质心/中心**旋转，正值为顺时针（度）。
 *
 * 设计目标：人类和 AI Agent 都能安全手写/编辑 → 扁平、显式、无继承魔法。
 * 修改格式时必须递增 version，并在 MapValidator 中加入对应迁移/校验。
 */

export const MAP_FORMAT_VERSION = 1;

/** 图层：solid = 参与物理；decor = 纯视觉（背景装饰，无碰撞） */
export type ObjectLayer = 'solid' | 'decor';

/** 所有地图物体共有的属性 */
export interface MapObjectBase {
  /** 唯一 id（关节引用、AI 定位、编辑器选中都靠它）。不填时由加载器按索引生成 */
  id?: string;
  /** 对应 materials 表的 id */
  material: string;
  /** 覆盖材质默认的 fixed 属性（静态不移动 / 动态可推落） */
  fixed?: boolean;
  /** 旋转角度（度，正值顺时针），绕中心 */
  angle?: number;
  /** 单向平台（从上可站、从下可穿过），仅静态物体有意义 */
  oneWay?: boolean;
  /** 图层，默认 solid */
  layer?: ObjectLayer;
  /** 视觉颜色覆盖（hex 字符串，如 "#8b5a2b"）。不填则用材质颜色 */
  color?: string;
  /**
   * 视觉贴图覆盖（public 下相对路径，如 "textures/wood.png"；也可 data: 内联）。
   * 不填则用材质的贴图。仅对 rect 生效（圆/多边形仍用颜色）。
   */
  texture?: string;
  /** 贴图铺法：tile 平铺 / stretch 拉伸（不填 = 跟材质一致，默认 tile） */
  textureMode?: 'tile' | 'stretch';
}

/** 矩形：x,y = 左上角 */
export interface MapObjectRect extends MapObjectBase {
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 圆形：x,y = 圆心 */
export interface MapObjectCircle extends MapObjectBase {
  type: 'circle';
  x: number;
  y: number;
  radius: number;
}

/** 任意凸多边形：x,y = 中心，vertices 为相对中心的顶点 */
export interface MapObjectPolygon extends MapObjectBase {
  type: 'polygon';
  x: number;
  y: number;
  /** 相对中心的顶点数组（顺时针或逆时针均可） */
  vertices?: Array<{ x: number; y: number }>;
  /** 正多边形简写：边数（与 vertices 二选一） */
  sides?: number;
  /** 正多边形外接圆半径（配合 sides 使用） */
  radius?: number;
}

export type MapObject = MapObjectRect | MapObjectCircle | MapObjectPolygon;

/** 预制件实例：引用 data/prefabs/<id>.json，锚点为预制件中心 */
export interface PrefabInstance {
  id?: string;
  /** 预制件 id */
  ref: string;
  /** 锚点世界坐标（预制件中心） */
  x: number;
  y: number;
  /** 旋转角度（度，正值顺时针） */
  angle?: number;
  /** 水平翻转 */
  flipX?: boolean;
  /** 覆盖所有部件的 fixed 属性（家具等应设为 true） */
  fixed?: boolean;
}

/** 关节（跷跷板等）。目前支持 revolute（铰链/销轴） */
export interface MapJoint {
  id?: string;
  type: 'revolute';
  /** 主体 id（必须是本地图中存在的物体 id） */
  bodyA: string;
  /** 另一主体 id；省略或 "world" 表示固定在世界的 anchor 点 */
  bodyB?: string;
  /** 铰链锚点（世界坐标） */
  anchor: { x: number; y: number };
}

export interface SpawnPoint {
  x: number;
  y: number;
}

/** 武器空投区域（矩形，世界坐标，左上角原点） */
export interface DropZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 全局自动空投配置（**默认关闭**）。
 *
 * 关闭时地图只会通过 `weapons[]`（武器掉落点）产出武器；
 * 开启后才会像以前那样"从天上随机掉，维持一定数量"。
 */
export interface AutoDropConfig {
  /** 是否开启，默认 false */
  enabled?: boolean;
  /** 地图上维持的武器数量（默认 4） */
  count?: number;
  /** 检查间隔（ms，默认 2800） */
  intervalMs?: number;
  /** 开局立刻投放的数量（默认 3） */
  initial?: number;
}

/** 关卡内固定生成点（医疗包等，type 对应物品表 data/items.json 的 id） */
export interface MapItemSpawn {
  type: string;
  x: number;
  y: number;
}

/**
 * 武器掉落点（地图上的"补给站"）。
 *
 * - mode = 'fixed'  ：固定武器（weapon 指定 data/weapons.json 的 id）
 * - mode = 'random' ：从候选池 pool 随机（不填 pool = 全部武器）
 * - respawnMs       ：被拾取后多久重新刷新（0/不填 = 只刷一次，不刷新）
 * - maxRespawns     ：最多刷新次数（不填 = 无限）
 *
 * 兼容旧格式：`{ type: "ak47", x, y }` 等价于 `{ mode: "fixed", weapon: "ak47", ... }`
 */
export interface MapWeaponSpawn {
  /** 唯一 id（编辑器选中/关节引用用，可选） */
  id?: string;
  x: number;
  y: number;
  /** 掉落模式，默认 fixed */
  mode?: 'fixed' | 'random';
  /** 固定武器 id（mode=fixed） */
  weapon?: string;
  /** 旧字段：等价于 weapon（mode 视为 fixed） */
  type?: string;
  /** 随机模式的候选武器池（不填 = 全部武器） */
  pool?: string[];
  /** 拾取后重新刷新的间隔（ms）；0/不填 = 不刷新 */
  respawnMs?: number;
  /** 最多刷新次数；不填 = 无限 */
  maxRespawns?: number;
}

export interface MapData {
  version: number;
  name: string;
  width: number;
  height: number;
  spawnPoints: SpawnPoint[];
  objects: MapObject[];
  /** 预制件实例 */
  prefabs?: PrefabInstance[];
  /** 关节 */
  joints?: MapJoint[];
  /** 武器空投区域（预留：M4 掉落系统使用） */
  weaponDropZones?: DropZone[];
  /** 场景内物品生成点（医疗包/防弹衣等） */
  items?: MapItemSpawn[];
  /** 武器掉落点（固定武器 / 随机武器，可配置刷新间隔与次数） */
  weapons?: MapWeaponSpawn[];
  /** 全局自动空投（默认关闭；开启后才会从天上随机掉武器维持数量） */
  autoDrop?: AutoDropConfig;
}
