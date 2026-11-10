/**
 * 玩家输入指令 —— 输入抽象层的核心数据结构。
 *
 * 单机阶段：由 InputManager 从键盘/鼠标生成。
 * 联机阶段：由服务器下发的输入流（相同结构）生成。
 * 玩家实体只消费 InputCommand，不关心输入来源，这是为联机铺路的关键。
 */
export interface InputCommand {
  /** 水平移动：-1 左 / 0 静止 / 1 右 */
  moveX: number;
  /** 跳跃请求（仅在按下瞬间为 true，由输入层做下降沿检测） */
  jump: boolean;
  /** 攻击（P1 鼠标左键 / P2 空格）—— M0 预留 */
  attack: boolean;
  /** 踢（P1 鼠标右键 / P2 Shift）—— M2 实现 */
  kick: boolean;
  /** 替换武器（P2 E；P1 右键上下文）—— M4 实现 */
  swap: boolean;
}

export function emptyInput(): InputCommand {
  return { moveX: 0, jump: false, attack: false, kick: false, swap: false };
}
