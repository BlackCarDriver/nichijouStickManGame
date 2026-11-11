/** 物体材质属性表（数据驱动：新增材质只需加配置） */
export interface MaterialConfig {
  id: string;
  name: string;
  /** 耐受度（0 = 不可破坏） */
  durability: number;
  /** 是否可被破坏 */
  destructible: boolean;
  /** 是否固定位置（不掉落/不可推动） */
  fixed: boolean;
  /** 反弹系数（restitution），决定子弹/物体反弹行为 */
  bounce: number;
  /** 密度，影响重量（跷跷板/可推动物体） */
  density: number;
  /** 动摩擦力（0~1，越小越滑；影响物体滑动/玩家行走手感） */
  friction: number;
  /** 静摩擦力（0~1，越小越容易被推动） */
  frictionStatic: number;
  /** 渲染颜色 */
  color: number;
}

export const MATERIALS: Record<string, MaterialConfig> = {
  wall: {
    id: 'wall',
    name: '墙体',
    durability: 0,
    destructible: false,
    fixed: true,
    bounce: 0,
    density: 5,
    // 墙体无摩擦：贴墙下落不会被摩擦减速（玩家 friction 与它取 min → 0）
    friction: 0,
    frictionStatic: 0,
    color: 0x4a4a5a,
  },
  ground: {
    id: 'ground',
    name: '地面',
    durability: 0,
    destructible: false,
    fixed: true,
    bounce: 0,
    density: 5,
    friction: 0.5,
    frictionStatic: 0.9,
    color: 0x3d5a3d,
  },
  wood: {
    id: 'wood',
    name: '木头',
    durability: 60,
    destructible: true,
    fixed: false,
    bounce: 0.1,
    density: 1,
    friction: 0.4,
    frictionStatic: 0.8,
    color: 0x8b5a2b,
  },
  cardboard: {
    id: 'cardboard',
    name: '纸箱',
    durability: 20,
    destructible: true,
    fixed: false,
    bounce: 0.05,
    density: 0.3,
    // 纸箱粗糙、易被推动
    friction: 0.3,
    frictionStatic: 0.5,
    color: 0xc8a165,
  },
  metal: {
    id: 'metal',
    name: '金属',
    durability: 200,
    destructible: true,
    fixed: false,
    bounce: 0.8,
    density: 4,
    // 金属光滑：更容易滑动
    friction: 0.15,
    frictionStatic: 0.3,
    color: 0x9aa5b1,
  },
};
