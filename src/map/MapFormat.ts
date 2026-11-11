/**
 * 地图文件格式（MapData 的 TypeScript 形态）。
 * 地图文件为 JSON（maps/*.json），结构与此类型一一对应。
 * 目标是让人类和 AI Agent 都能方便地手写/编辑。
 *
 * 坐标系：左上角为原点，y 向下。
 * 支持三种形状：rect（矩形）/ circle（圆形）/ polygon（任意凸多边形，含三角形）。
 */

/** 所有物体共有的属性 */
export interface MapObjectBase {
  /** 对应 materials 表的 id */
  material: string;
  /** 可选：覆盖材质默认的 fixed 属性（静态不移动 / 动态可推落） */
  fixed?: boolean;
  /** 可选：旋转角度（度）。正值为顺时针 */
  angle?: number;
  /** 可选：单向平台（从上可站、从下可穿过）。仅静态物体有意义 */
  oneWay?: boolean;
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

/** 任意凸多边形（三角形即 3 顶点特例）：x,y = 中心，vertices 为相对中心的顶点偏移 */
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

export interface SpawnPoint {
  x: number;
  y: number;
}

export interface MapData {
  name: string;
  width: number;
  height: number;
  spawnPoints: SpawnPoint[];
  objects: MapObject[];
}
