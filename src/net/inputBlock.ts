/**
 * 全局输入闸门：DOM 输入框获得焦点时（大厅/游戏内聊天），
 * 键盘事件不应再驱动玩家，否则打字会让人物乱跑。
 *
 * 由 Overlay 维护，InputManager 读取。独立小模块以避免循环依赖。
 */
export const inputBlock = {
  /** 是否正在输入文本 */
  typing: false,
};
