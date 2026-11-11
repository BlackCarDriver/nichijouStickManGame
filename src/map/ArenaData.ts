import type { MapData } from './MapFormat';

/**
 * 测试竞技场地图（内嵌数据，后续迁移为 maps/*.json 文件加载）。
 * 坐标系：左上角为原点，y 向下。
 */
export const ARENA: MapData = {
  name: 'arena1',
  width: 2400,
  height: 1200,
  spawnPoints: [
    // 避开平台正下方：玩家1 在左墙边，玩家2 在右墙边
    { x: 150, y: 1072 },
    { x: 2250, y: 1072 },
  ],
  objects: [
    // ===== 地面与边界 =====
    { type: 'rect', x: 0, y: 1120, w: 2400, h: 80, material: 'ground' },
    { type: 'rect', x: 0, y: 0, w: 40, h: 1200, material: 'wall' },
    { type: 'rect', x: 2360, y: 0, w: 40, h: 1200, material: 'wall' },

    // ===== 木平台（静态承载物，可跳上）=====
    { type: 'rect', x: 240, y: 940, w: 260, h: 24, material: 'wood', fixed: true },
    { type: 'rect', x: 900, y: 800, w: 320, h: 24, material: 'wood', fixed: true },
    { type: 'rect', x: 1250, y: 620, w: 320, h: 24, material: 'wood', fixed: true },
    { type: 'rect', x: 1900, y: 940, w: 260, h: 24, material: 'wood', fixed: true },

    // ===== 单向平台（从下可穿过、从上可站立，虚线风格）=====
    { type: 'rect', x: 620, y: 860, w: 200, h: 16, material: 'wood', fixed: true, oneWay: true },
    { type: 'rect', x: 1600, y: 860, w: 200, h: 16, material: 'wood', fixed: true, oneWay: true },

    // ===== 三角形斜坡（多边形 3 顶点；直角三角形当斜坡用）=====
    {
      type: 'polygon',
      x: 780,
      y: 1080,
      vertices: [
        { x: -60, y: 40 },
        { x: 60, y: 40 },
        { x: 60, y: -40 },
      ],
      material: 'wood',
      fixed: true,
    },
    {
      type: 'polygon',
      x: 1620,
      y: 1080,
      vertices: [
        { x: -60, y: 40 },
        { x: 60, y: 40 },
        { x: -60, y: -40 },
      ],
      material: 'wood',
      fixed: true,
    },

    // ===== 圆形物体（可滚动的金属球）=====
    { type: 'circle', x: 1050, y: 1060, radius: 30, material: 'metal' },
    { type: 'circle', x: 1380, y: 700, radius: 24, material: 'metal' },

    // ===== 正六边形（金属块，静态）=====
    { type: 'polygon', x: 1160, y: 960, sides: 6, radius: 44, material: 'metal', fixed: true },

    // ===== 可破坏箱子 =====
    { type: 'rect', x: 600, y: 1040, w: 80, h: 80, material: 'cardboard' },
    { type: 'rect', x: 1720, y: 1040, w: 80, h: 80, material: 'cardboard' },
    { type: 'rect', x: 1050, y: 1040, w: 64, h: 64, material: 'wood' },

    // ===== 倾斜平台（angle 旋转演示）=====
    { type: 'rect', x: 480, y: 700, w: 240, h: 20, material: 'wood', fixed: true, angle: -12 },
  ],
};
