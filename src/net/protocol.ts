/**
 * 联机协议（游戏页面 ↔ 游戏服务）的 TypeScript 视图。
 *
 * 与 `server/protocol.go` 一一对应；改字段时两边必须同时改，
 * 并在 `docs/联机协议.md` 里记录。聊天室桥接协议（服务端 ↔ 聊天室）不在这里。
 */

/** 输入边沿掩码（与 server/protocol.go 一致） */
export const EDGE = {
  jump: 1 << 0,
  attack: 1 << 1,
  kick: 1 << 2,
  swap: 1 << 3,
  grenade: 1 << 4,
} as const;

export interface RoomPlayer {
  nick: string;
  avatar: string;
  /** 大厅座位号；对局中为 netId；-1 = 旁观 */
  netId: number;
  ready: boolean;
  host: boolean;
}

export interface RoomSnapshot {
  t: 'room';
  /** round = 对局进行中；ending = 结算展示中 */
  state: 'round' | 'ending';
  players: RoomPlayer[];
  spectators: string[];
  map: string;
  you: number;
  maxPlayers: number;
}

export interface WelcomeMsg {
  t: 'welcome';
  nick: string;
  avatar: string;
  frame: string;
  roleId: number;
  frameId: number;
  registered: boolean;
  netId: number;
  host: boolean;
  roomId: number;
  title: string;
  maxPlayers: number;
  maps: string[];
  map: string;
  killTarget: number;
}

export interface MatchPlayer {
  nick: string;
  avatar: string;
  netId: number;
  color: number;
  spawn: number;
  kills: number;
}

export interface DropWire {
  id: number;
  kind: 'weapon' | 'item';
  weaponId?: string;
  itemId?: string;
  ammo?: number;
  x: number;
  y: number;
  falling: boolean;
  tag?: string;
}

export interface PlayerStat {
  id: number;
  hp: number;
  shield: number;
  dead: boolean;
  kills: number;
}

export interface MatchStartMsg {
  t: 'match_start';
  matchId: number;
  map: string;
  players: MatchPlayer[];
  stats: PlayerStat[];
  you: number;
  /** 世界权威（房主）座位号；-1 = 暂无权威 */
  host: number;
  drops: DropWire[];
  destroyed: string[];
  /** 最近一帧全量世界快照（中途加入者用它还原动态物体/掉落物/玩家位置） */
  world?: SnapMsg;
}

/** 对局中途加入的新玩家 */
export interface PlayerJoinMsg {
  t: 'player_join';
  player: MatchPlayer;
  stat: PlayerStat;
}

/** 上一局刚结束、下一局未开始（此时连接进来先等待） */
export interface WaitingMsg {
  t: 'waiting';
  text: string;
}

export interface InputSnapshot {
  id: number;
  seq: number;
  mx: number;
  jh: boolean;
  cr: boolean;
  ah: boolean;
  kh: boolean;
  sw: boolean;
  aim: number;
  e: number;
}

export interface InputBatchMsg {
  t: 'in';
  tick: number;
  p: InputSnapshot[];
}

export interface PosSnapshot {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface PosBatchMsg {
  t: 'pos';
  p: PosSnapshot[];
}

// ---------- 世界状态同步（房主 → 服务端 → 其它客户端）----------

/** 房主视角的玩家权威变换 */
export interface SnapPlayer {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 着地 */
  g: boolean;
}

/** 动态地图物体（箱子/铁球/跷跷板…）的权威变换 */
export interface SnapObj {
  id: string;
  x: number;
  y: number;
  /** 旋转角（弧度） */
  a: number;
}

/** 掉落物权威坐标 */
export interface SnapDrop {
  id: number;
  x: number;
  y: number;
  f: boolean;
}

/**
 * 权威世界快照。
 *
 * `key=true` 是全量关键帧（所有动态物体 + 所有掉落物），新加入者可直接拿它还原世界；
 * 普通帧只带玩家 + 变化过的物体/掉落物。
 */
export interface SnapMsg {
  t: 'snap';
  seq: number;
  key: boolean;
  p: SnapPlayer[];
  o?: SnapObj[];
  d?: SnapDrop[];
}

/** 掉落物被移除（越界清理等；房主 → 服务端 → 所有人） */
export interface DropRemoveMsg {
  t: 'drop_remove';
  id: number;
}

/** 世界权威变更（房主掉线时顺延） */
export interface HostMsg {
  t: 'host';
  id: number;
}

export interface HpMsg {
  t: 'hp';
  id: number;
  hp: number;
  shield: number;
  dead: boolean;
  amount: number;
  kind: string;
  crit: boolean;
  point?: { x: number; y: number };
  kb?: { x: number; y: number };
  src: number;
  /** 造成这次伤害的武器 id（死亡回放用） */
  weapon?: string;
  kills: Record<string, number>;
}

export interface DropAddMsg {
  t: 'drop_add';
  item: DropWire;
}

export interface PickGrant {
  kind: 'weapon' | 'item';
  weaponId?: string;
  itemId?: string;
  ammo?: number;
}

export interface PickMsg {
  t: 'pick';
  id: number;
  by: number;
  grant: PickGrant;
  hp: number;
  shield: number;
  dead: boolean;
}

export interface ObjMsg {
  t: 'obj';
  id: string;
}

export interface ChatMsg {
  t: 'chat';
  nick: string;
  text: string;
  ts: number;
  room?: boolean;
}

export interface PlayerLeftMsg {
  t: 'player_left';
  id: number;
  nick: string;
}

export interface MatchEndMsg {
  t: 'match_end';
  results: Array<{ nick: string; netId: number; kills: number }>;
  winner: string;
  reason: string;
  /** 多少毫秒后自动开始下一局（换图） */
  restartInMs: number;
  /** 结算弹窗延迟多少毫秒再弹出（留出击败镜头） */
  delayMs: number;
  nextMap: string;
}

export interface ErrorMsg {
  t: 'error';
  message: string;
}

export interface PongMsg {
  t: 'pong';
  ts: number;
}

export interface RoomClosedMsg {
  t: 'room_closed';
}

export type ServerMsg =
  | WelcomeMsg
  | RoomSnapshot
  | MatchStartMsg
  | PlayerJoinMsg
  | WaitingMsg
  | InputBatchMsg
  | PosBatchMsg
  | SnapMsg
  | DropRemoveMsg
  | HostMsg
  | HpMsg
  | DropAddMsg
  | PickMsg
  | ObjMsg
  | ChatMsg
  | PlayerLeftMsg
  | MatchEndMsg
  | ErrorMsg
  | PongMsg
  | RoomClosedMsg;

/** 客户端上行消息（结构较松散，服务端按 t 分派） */
export type ClientMsg =
  | { t: 'chat'; text: string }
  | { t: 'spectate' }
  | { t: 'enter' }
  | {
      t: 'in';
      seq: number;
      mx: number;
      jh: boolean;
      cr: boolean;
      ah: boolean;
      kh: boolean;
      sw: boolean;
      aim: number;
      e: number;
    }
  | { t: 'pos'; x: number; y: number; vx: number; vy: number }
  | {
      t: 'pick';
      id: number;
      /** 房主代他人发起拾取时填对方座位号 */
      by?: number;
      swap?: { weaponId: string; ammo: number; x: number; y: number };
    }
  | {
      t: 'dmg';
      target: number;
      /** 攻击者座位号（-1 = 环境/未知）；房主代报时必须填 */
      src: number;
      /** 造成伤害的武器 id（死亡回放用） */
      weapon?: string;
      amount: number;
      kind: string;
      crit: boolean;
      point?: { x: number; y: number };
      kb?: { x: number; y: number };
      attack: number;
      ignoreInvuln: boolean;
    }
  | { t: 'shield'; amount: number }
  | { t: 'drop'; weaponId: string; ammo: number; x: number; y: number }
  | { t: 'obj'; id: string }
  | { t: 'snap'; seq: number; key: boolean; p: SnapPlayer[]; o?: SnapObj[]; d?: SnapDrop[] }
  | { t: 'drop_remove'; id: number }
  | { t: 'ping'; ts: number };

/** 对局启动数据（GameScene 通过 scene.start 的数据传入） */
export interface MatchContext {
  matchId: number;
  map: string;
  you: number;
  /** 世界权威（房主）座位号 */
  host: number;
  players: MatchPlayer[];
  stats: PlayerStat[];
  drops: DropWire[];
  destroyed: string[];
  /** 初始世界快照（中途加入/重连时用于还原动态世界） */
  world?: SnapMsg;
  /** 与服务器通信的通道（GameScene 内由 OnlineMatch 使用） */
  link: MatchLink;
}

/** 极简通信接口：让 GameScene 不直接依赖 NetClient（便于编辑器/单机复用）。 */
export interface MatchLink {
  send(msg: ClientMsg): void;
  subscribe(handler: (msg: ServerMsg) => void): () => void;
}
