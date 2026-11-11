/**
 * Matter 碰撞分类（collisionFilter category/mask）。
 * 集中定义避免各模块散落魔法数字。
 */
export const COLLISION_CATEGORY = {
  /** Matter 默认分类（地图普通物体） */
  default: 0x0001,
  /** 玩家火柴人主体 */
  player: 0x0002,
  /** 玩家脚下传感器（不与玩家主体碰撞，但检测其他物体） */
  feetSensor: 0x0004,
  /** 单向平台（从上可站、从下可穿过） */
  oneWayPlatform: 0x0008,
  /** 关节锚点（不与任何东西碰撞） */
  jointAnchor: 0x0010,
} as const;

/** 玩家主体默认 mask：与所有物体碰撞 */
export const PLAYER_MASK_ALL = 0xffff;
/** 脚下传感器默认 mask：排除玩家主体（避免自身重叠误判） */
export const FEET_MASK_ALL = 0xffff ^ COLLISION_CATEGORY.player;
