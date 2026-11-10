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
    color: 0x9aa5b1,
  },
};
