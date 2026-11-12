/**
 * 玩家展示资料（昵称 / 头像）。
 *
 * ⚠️ 目前是**假数据**，只用于 HUD 布局与展示验证。
 * 接入联机 / 账号系统后，改为由房间玩家列表（服务器下发）注入，HUD 侧不用改动：
 *
 *   hud.bind(players, roomPlayers.map((p) => ({ nickname: p.name, avatarKey: p.avatar })));
 *
 * 头像策略：`avatarKey` 不填时，HUD 会用**玩家自己的颜色**画一个程序化火柴人头像
 * （零素材依赖，且颜色天然区分不同玩家）。有贴图时优先用贴图。
 */
export interface PlayerProfile {
  /** 昵称（显示在状态面板上） */
  nickname: string;
  /** 头像贴图 key（可选；不填 = 程序化火柴人头像） */
  avatarKey?: string;
}

/** 假数据池：按玩家序号取用，超出长度会循环（后续整体替换为真实数据） */
const FAKE_PROFILES: PlayerProfile[] = [
  { nickname: '红小兵' },
  { nickname: '蓝旋风' },
  { nickname: '绿箭侠' },
  { nickname: '黄飞鸿' },
  { nickname: '紫电' },
  { nickname: '橙心' },
  { nickname: '青面兽' },
  { nickname: '白空空' },
];

/** 生成 count 个假资料 */
export function getFakeProfiles(count: number): PlayerProfile[] {
  return Array.from({ length: count }, (_, i) => FAKE_PROFILES[i % FAKE_PROFILES.length]);
}
