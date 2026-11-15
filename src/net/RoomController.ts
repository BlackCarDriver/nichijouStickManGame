import type Phaser from 'phaser';
import { NetClient } from './NetClient';
import { ShellBridge } from './ShellBridge';
import type { MatchContext, MatchEndMsg, MatchStartMsg, RoomSnapshot, ServerMsg } from './protocol';
import { modeLabel } from '../config/teams';
import { Overlay, type OverlayAction } from '../ui/Overlay';
import { inputBlock } from './inputBlock';
import { startGate } from './startGate';
import { NetDebug } from '../ui/NetDebug';

interface DevMode {
  enabled: boolean;
  nick: string;
  /** 本地联调用的头像地址（模拟聊天室头像） */
  avatar: string;
}

/**
 * 房间控制器：把"聊天室外壳 + 游戏服务 WebSocket + 对局场景"拼在一起。
 *
 * 现在没有大厅：连上就进对局（随机地图），边打边等人；
 * 一局结束由服务端换图重开，客户端只负责重启场景。
 *
 * 页面有两种运行方式：
 * - 聊天室 iframe（正式）：身份来自外壳下发的 JWT，聊天输入由外壳负责
 * - `?dev=1&nick=xxx`（本地开发）：服务端 `--dev` 时用假身份，自带聊天输入框
 */
export class RoomController {
  readonly shell = new ShellBridge();
  readonly overlay: Overlay;
  private readonly net: NetClient;
  private netDebug: NetDebug | null = null;
  private readonly dev: DevMode;

  private inMatch = false;
  /** 已经按过"开始"（后续重连自动重新入座） */
  private enterRequested = false;
  /** 主动选择观战（不再自动入座） */
  private spectateChosen = false;
  /** 已经为哪个 matchId 自动发过 enter（防循环） */
  private autoEnterMatchId = -1;
  private readonly coarsePointer =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (inputBlock.typing) return;
    if (startGate.phase !== 'ready') return;
    if (e.key === 'w' || e.key === 'W' || e.code === 'KeyW') this.startGame();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (!this.net.isOpen) void this.net.connect();
  };

  private readonly root: HTMLElement;

  constructor(
    private readonly game: Phaser.Game,
    root: HTMLElement,
  ) {
    this.root = root;
    const params = new URLSearchParams(window.location.search);
    const devNick = params.get('nick') ?? '';
    this.dev = {
      enabled: params.get('dev') === '1',
      nick: devNick || `dev${Math.floor(Math.random() * 900 + 100)}`,
      avatar: params.get('avatar') ?? '',
    };

    this.overlay = new Overlay(root, { chatInput: this.dev.enabled });
    this.overlay.onAction = (a) => this.handleAction(a);
    // 聊天输入时关闭 Phaser 的键盘捕获：否则 WASD/空格会被 preventDefault，打不出字
    this.overlay.onTypingChange = (typing) => {
      if (this.game.input.keyboard) this.game.input.keyboard.enabled = !typing;
    };

    this.net = new NetClient({
      buildUrl: (token) => this.buildUrl(token),
      acquireToken: () => this.acquireToken(),
      onStatus: (status, detail) => {
        this.overlay.setConnection(status, detail);
        if (status === 'open') startGate.setProgress(0.15, '已连接，等待对局…');
      },
    });
    this.net.subscribe((msg) => this.handleServerMessage(msg));

    this.shell.onToken = () => {
      if (!this.net.isOpen) void this.net.connect();
    };
    this.shell.onRoomState = (users) => this.overlay.setRoomUsers(users);
    this.shell.onFullscreen = (v) => this.overlay.setFullscreen(v);
  }

  boot(): void {
    this.overlay.show();
    this.overlay.setConnection('connecting');
    this.overlay.showLoading('正在连接游戏服务…', 0);

    // 闸门 → 界面：加载中显示进度条；就绪显示"点击 W 开始"/观战；开始后收起面板
    startGate.subscribe((gate) => {
      if (gate.phase === 'connecting' || gate.phase === 'loading') {
        this.overlay.showLoading(gate.label, gate.progress);
      } else if (gate.phase === 'ready') {
        // 就绪时抢一次焦点：iframe 内按键才能被 window 的 keydown 收到
        this.overlay.focusSelf();
        this.overlay.showStartActions(!this.coarsePointer);
      } else {
        this.overlay.beginHud();
      }
    });

    if (this.dev.enabled) {
      void this.net.connect();
    } else {
      this.shell.start();
    }

    // 网络诊断面板：?netdebug=1 打开；同时暴露 window.__netDiag() 便于一键导出
    if (new URLSearchParams(window.location.search).get('netdebug') === '1') {
      this.netDebug = new NetDebug(this.root);
      window.setInterval(() => {
        const scene = this.game.scene.getScene('GameScene') as unknown as
          | { online?: { diag?: () => Record<string, unknown> } }
          | null;
        this.netDebug?.update(scene?.online?.diag?.() ?? null);
      }, 500);
    }
    const diagHook = (): Record<string, unknown> | null => {
      const scene = this.game.scene.getScene('GameScene') as unknown as
        | { online?: { diag?: () => Record<string, unknown> } }
        | null;
      return scene?.online?.diag?.() ?? null;
    };
    (window as unknown as Record<string, unknown>).__netDiag = diagHook;

    window.addEventListener('keydown', this.onKeyDown);
    window.setInterval(() => this.ping(), 3000);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  // ---------- 连接 ----------

  private buildUrl(token: string): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 按构建 BASE_URL 解析，子路径部署（/stickmanGame/）时自动连到 /stickmanGame/ws
    const url = new URL(`${import.meta.env.BASE_URL}ws`, window.location.href);
    url.protocol = proto;
    const base = url.toString();
    if (this.dev.enabled) {
      const avatar = this.dev.avatar ? `&avatar=${encodeURIComponent(this.dev.avatar)}` : '';
      return `${base}?dev=1&nick=${encodeURIComponent(this.dev.nick)}${avatar}`;
    }
    return `${base}?token=${encodeURIComponent(token)}`;
  }

  private async acquireToken(): Promise<string | null> {
    if (this.dev.enabled) return '';
    if (this.shell.token && this.shell.tokenRemain() > 60) return this.shell.token;
    if (!this.shell.inIframe) {
      this.overlay.showFatal('凭证已失效', '请从聊天室房间重新打开游戏。');
      return null;
    }
    const token = await this.shell.requestToken(15000);
    return token || null;
  }

  /** 开始游戏：解除闸门 + 通知服务端入座（仅键盘 W 触发，不允许鼠标点） */
  private startGame(): void {
    if (startGate.phase !== 'ready') return;
    startGate.startPlaying();
    this.enterRequested = true;
    this.net.send({ t: 'enter' });
  }

  /**
   * UI 延迟测量（`tag: 'ui'`）。
   *
   * 必须带 tag：网络层（OnlineMatch）也在 ping，用的是 `performance.now()`；
   * 两边共用同一个 pong 回声会让 UI 用 Date.now() 减出 1.7e12 这种十几位数。
   */
  private ping(): void {
    if (!this.net.isOpen) return;
    this.net.send({ t: 'ping', ts: Date.now(), tag: 'ui' });
  }

  // ---------- 上行操作 ----------

  private handleAction(action: OverlayAction): void {
    switch (action.type) {
      case 'spectate':
        // 观战：通知服务端不入座（不计死亡），后续开局也不再上场
        this.spectateChosen = true;
        this.net.send({ t: 'spectate' });
        startGate.requestSpectate();
        break;
      case 'chat':
        this.net.send({ t: 'chat', text: action.text });
        break;
      case 'fullscreen':
        if (this.shell.inIframe) {
          this.shell.requestFullscreen(action.v);
        } else if (action.v) {
          void document.documentElement.requestFullscreen?.().catch(() => undefined);
        } else if (document.fullscreenElement) {
          void document.exitFullscreen();
        }
        break;
      default:
        break;
    }
  }

  // ---------- 下行消息 ----------

  private handleServerMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        // 标题不显示在游戏画面里（房间外壳已经有标题）
        break;
      case 'room':
        this.handleRoom(msg);
        break;
      case 'match_start':
        // 掉线重连后：已经按过"开始"的话自动重新入座（无需再按 W）
        if (
          msg.you < 0 &&
          this.enterRequested &&
          !this.spectateChosen &&
          this.autoEnterMatchId !== msg.matchId
        ) {
          this.autoEnterMatchId = msg.matchId;
          this.net.send({ t: 'enter' });
        }
        this.enterMatch(msg);
        break;
      case 'match_end':
        this.showResults(msg);
        break;
      case 'waiting':
        // 上一局刚结束（或刚重连进来）：停掉残留场景，等下一局 match_start 重建
        this.inMatch = false;
        if (this.game.scene.isActive('GameScene')) this.game.scene.stop('GameScene');
        startGate.reset();
        startGate.setProgress(0.1, msg.text || '等待下一局…');
        break;
      case 'chat':
        this.overlay.addChat(msg.nick, msg.text, msg.room === true);
        break;
      case 'pong':
        if (msg.tag === 'ui') this.overlay.setPing(Date.now() - msg.ts);
        break;
      case 'room_closed':
        this.overlay.showFatal('房间已关闭', '管理员关闭了该插件房，可以关闭页面了。');
        this.net.close();
        break;
      case 'error':
        this.overlay.addChat('', msg.message);
        break;
      default:
        break;
    }
  }

  private handleRoom(msg: RoomSnapshot): void {
    this.overlay.setRoom(msg);
    if (this.inMatch) return;
    // 没有场景时给个等待提示（连上但还没进对局 / 上一局刚结束）
    if (msg.state === 'ending') return; // 由 match_end 的结算弹窗负责
    if (!this.game.scene.isActive('GameScene')) {
      this.overlay.showWaiting('等待对局开始…');
    }
  }

  private enterMatch(msg: MatchStartMsg): void {
    this.inMatch = true;

    const ctx: MatchContext = {
      matchId: msg.matchId,
      map: msg.map,
      mode: msg.mode ?? 'ffa',
      you: msg.you,
      host: msg.host ?? -1,
      players: msg.players,
      stats: msg.stats ?? [],
      drops: msg.drops,
      destroyed: msg.destroyed,
      world: msg.world,
      link: this.net,
    };

    startGate.resetForMatch(msg.you);
    const role = msg.you >= 0 ? '' : ' · 观战中';
    this.overlay.prepareMatch(
      `地图 ${msg.map} · 剩 ${msg.players.length} 人 · ${modeLabel(msg.mode)}${role}`,
    );
    this.overlay.addChat('', `新的一局：${msg.map}（${modeLabel(msg.mode)}）`);

    const scene = this.game.scene.getScene('GameScene');
    if (scene && (this.game.scene.isActive('GameScene') || this.game.scene.isPaused('GameScene'))) {
      this.game.scene.stop('GameScene');
    }
    this.game.scene.start('GameScene', { online: ctx });
  }

  private showResults(msg: MatchEndMsg): void {
    this.overlay.showResults(msg, this.overlayRoomYou());
    this.overlay.addChat('', `本局结束：${msg.winner || '无胜者'}`);
  }

  /** 结算里的"（你）"标记用：取最近一次 room 快照里的座位号 */
  private overlayRoomYou(): number {
    const scene = this.game.scene.getScene('GameScene');
    const online = (scene as unknown as { online?: { localNetId: number } } | null)?.online;
    return online?.localNetId ?? -1;
  }
}
