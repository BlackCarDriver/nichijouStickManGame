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

/** 文字标签在物体上的位置（相对包围盒的九宫格） */
export type ObjectLabelAnchor =
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'topLeft'
  | 'topRight'
  | 'bottomLeft'
  | 'bottomRight';

/**
 * 物体上的文字（招牌、告示、按键提示、路标……）。
 *
 * 文字是**纯视觉**：不参与物理、不影响碰撞，随物体移动/旋转；
 * 描边由渲染层自动加（保证压在任意贴图上都读得清）。
 */
export interface MapObjectLabel {
  /** 文案（支持换行 \n） */
  text: string;
  /** 字号（px，世界单位）。不填 = 20 */
  size?: number;
  /** 颜色（hex 字符串）。不填 = #ffffff */
  color?: string;
  /** 位置：包围盒内的九宫格锚点，默认 center */
  anchor?: ObjectLabelAnchor;
}

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
   * 不填则用材质的贴图。**所有形状都支持**：
   * 圆/多边形会用几何蒙版把贴图裁成对应形状（见 `ShapeTexture.ts`）。
   */
  texture?: string;
  /** 贴图铺法：tile 平铺 / stretch 拉伸（不填 = 跟材质一致，默认 tile） */
  textureMode?: 'tile' | 'stretch';
  /** 物体上的文字（不填 = 没有文字） */
  label?: MapObjectLabel;
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

/** 关节（跷跷板、吹链、三节棍等）。目前支持 revolute（铰链/销轴，自由旋转） */
export interface MapJoint {
  id?: string;
  type: 'revolute';
  /** 主体 id（本地图中存在的物体 id／预制件实例 id／松件部件 id `${instId}#i`） */
  bodyA: string;
  /** 另一主体 id；省略或 "world" 表示固定在世界的 anchor 点 */
  bodyB?: string;
  /** 铰链锚点（世界坐标） */
  anchor: { x: number; y: number };
  /**
   * 两端"互不碰撞"（默认 false）。
   *
   * 用 `noCollide: true` 的关节串在一起的刚体（吊链每一节、三节棍、平台）会被分到
   * **同一个负碰撞组**：它们彼此不产生碰撞，但仍与玩家/地形/其它组正常碰撞。
   *
   * 不加这个开关的后果：链节旋转时端面互相顶，求解器会把关节缝拉开。
   * 实测 30×30 粗段完全贴合时，缝隙在 30px ↔ 43px 之间抖动（看上去像“伸缩”）。
   */
  noCollide?: boolean;
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
  /** 固定武器 id（mode=fixed）。写道具 id（如 "medkit"）也可以，等价于 item 字段 */
  weapon?: string;
  /** 旧字段：等价于 weapon（mode 视为 fixed） */
  type?: string;
  /**
   * 固定道具 id（mode=fixed）：医疗包 `medkit` / 防弹衣 `armor`。
   * 填了它就按"补给点"处理（不受武器池影响）。
   */
  item?: string;
  /**
   * 随机模式的候选池：**武器 id 与道具 id 可以混着写**（不填 = 全部武器）。
   * 例：`["ak47", "medkit"]` → 每次随机刷一把 AK 或一个医疗包。
   */
  pool?: string[];
  /** 拾取后重新刷新的间隔（ms）；0/不填 = 不刷新 */
  respawnMs?: number;
  /** 最多刷新次数；不填 = 无限 */
  maxRespawns?: number;
  /**
   * 是否"从天而降"。
   * 默认 false：直接出现在 `x,y`（作者放置的位置）——
   * 因为从天上掉会被屋顶/门框挡住，落到"门上面"而不是刷新点。
   */
  fromSky?: boolean;
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
