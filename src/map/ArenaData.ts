import type { MapData } from './MapFormat';

/**
 * 测试竞技场地图（M0 内嵌数据，M1 迁移为 maps/*.json 文件加载）。
 * 坐标系：左上角为原点，y 向下。
 */
export const ARENA: MapData = {
  name: 'arena1',
  width: 2400,
  height: 1200,
  spawnPoints: [
    { x: 300, y: 1072 },
    { x: 2100, y: 1072 },
  ],
  objects: [
    // 地面
    { type: 'rect', x: 0, y: 1120, w: 2400, h: 80, material: 'ground' },
    // 左右边界墙
    { type: 'rect', x: 0, y: 0, w: 40, h: 1200, material: 'wall' },
    { type: 'rect', x: 2360, y: 0, w: 40, h: 1200, material: 'wall' },
    // 木头平台
    { type: 'rect', x: 240, y: 940, w: 260, h: 24, material: 'wood' },
    { type: 'rect', x: 900, y: 800, w: 320, h: 24, material: 'wood' },
    { type: 'rect', x: 1250, y: 620, w: 320, h: 24, material: 'wood' },
    { type: 'rect', x: 1900, y: 940, w: 260, h: 24, material: 'wood' },
    // 可破坏箱子（纸箱轻、易碎）
    { type: 'rect', x: 600, y: 1040, w: 80, h: 80, material: 'cardboard' },
    { type: 'rect', x: 1720, y: 1040, w: 80, h: 80, material: 'cardboard' },
    // 木箱（更耐打）
    { type: 'rect', x: 1160, y: 1040, w: 64, h: 64, material: 'wood' },
  ],
};
