/**
 * 团队战（tdm）的共享常量与判定。
 *
 * 唯一权威在服务端：服务端分边后把 `team` 和 `color`（= team）随 match_start 下发，
 * 客户端这里只是"渲染/文案"需要的名字与色值，必须与服务端 `teamNames` 和
 * `GameScene.PLAYER_COLORS` 的前两位保持一致（0=红、1=蓝）。
 */
import type { MatchMode } from '../net/protocol';

/** 队伍数量（红/蓝） */
export const TEAM_COUNT = 2;

/** 队伍展示名（下标 = 队伍编号） */
export const TEAM_NAMES = ['红队', '蓝队'] as const;

/** 队伍颜色（下标 = 队伍编号；与 PLAYER_COLORS[0..1] 相同） */
export const TEAM_COLORS = [0xe74c3c, 0x3498db] as const;

/** 队伍名（非法编号给出兜底文案） */
export function teamName(team: number): string {
  return TEAM_NAMES[team] ?? '未知队';
}

/** 队伍颜色（非法编号给白色） */
export function teamColor(team: number): number {
  return TEAM_COLORS[team] ?? 0xffffff;
}

/** 本局是否为团队战 */
export function isTeamMode(mode: MatchMode | undefined | null): boolean {
  return mode === 'tdm';
}

/** 本局模式的中文说明（用于加载页/顶栏文案） */
export function modeLabel(mode: MatchMode | undefined | null): string {
  return isTeamMode(mode) ? '团队战 · 消灭对方全队' : '混战 · 最后一人胜出';
}

/** 模式短名（用于"下一局"预告这类需要精简的地方） */
export function modeShortLabel(mode: MatchMode | undefined | null): string {
  return isTeamMode(mode) ? '团队战' : '混战';
}
