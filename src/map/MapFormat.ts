/**
 * 地图文件格式（MapData 的 TypeScript 形态）。
 * 地图文件为 JSON（M1 起从 maps/*.json 加载），结构与此类型一一对应。
 * 目标是让人类和 AI Agent 都能方便地手写/编辑。
 */
export interface MapObjectRect {
  type: 'rect';
  /** 左上角坐标 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 对应 materials 表的 id */
  material: string;
  /** 可选：覆盖材质默认的 fixed 属性 */
  fixed?: boolean;
}

export type MapObject = MapObjectRect;

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
