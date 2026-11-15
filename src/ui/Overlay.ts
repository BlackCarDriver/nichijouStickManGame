import './overlay.css';
import { inputBlock } from '../net/inputBlock';
import type { MatchEndMsg, RoomSnapshot } from '../net/protocol';
import { modeShortLabel, teamColor, teamName } from '../config/teams';
import type { NetStatus } from '../net/NetClient';
import type { ShellRoomUser } from '../net/ShellBridge';

export type OverlayAction =
  | { type: 'chat'; text: string }
  | { type: 'fullscreen'; v: boolean }
  | { type: 'spectate' };

const STATUS_TEXT: Record<NetStatus, string> = {
  idle: '未连接',
  connecting: '连接中…',
  open: '已连接',
  reconnecting: '重连中…',
  closed: '已断开',
  fatal: '连接已结束',
};

/**
 * 联机覆盖层。
 *
 * 现在没有大厅：进房即开打，所以覆盖层只负责
 * - 顶栏（连接状态 / 延迟 / 全屏按钮，对局中也要可点）
 * - 等待提示（等对手 / 等下一局）
 * - 结算弹窗（胜者 + 下一张地图 + 倒计时）
 * - 聊天输入（仅本地开发模式；正式环境聊天输入由聊天室外壳负责）
 */
export class Overlay {
  readonly el: HTMLDivElement;
  onAction?: (action: OverlayAction) => void;
  /** 聊天框聚焦状态变化（临时关闭 Phaser 键盘捕获） */
  onTypingChange?: (typing: boolean) => void;

  private readonly statusEl: HTMLSpanElement;
  private readonly pingEl: HTMLSpanElement;
  private readonly fullscreenBtn: HTMLButtonElement;
  private readonly hudbar: HTMLDivElement;
  private readonly waiting: HTMLDivElement;
  private readonly waitingText: HTMLDivElement;
  private readonly waitingSub: HTMLDivElement;
  private readonly progressWrap: HTMLDivElement;
  private readonly progressBar: HTMLDivElement;
  private readonly progressText: HTMLSpanElement;
  private readonly startActions: HTMLDivElement;
  private readonly startHint: HTMLDivElement;
  private readonly spectateBtn: HTMLButtonElement;
  private readonly modal: HTMLDivElement;
  private readonly modalBody: HTMLDivElement;
  private readonly fatal: HTMLDivElement;
  private readonly fatalText: HTMLDivElement;
  private readonly fatalDetail: HTMLDivElement;
  private chatBox: HTMLDivElement | null = null;
  private chatLog: HTMLDivElement | null = null;
  private chatInput: HTMLInputElement | null = null;

  private fullscreen = false;
  private countdownTimer: number | null = null;
  /** 结算弹窗延迟计时（先让玩家看完"击败镜头"） */
  private resultsTimer: number | null = null;
  private room: RoomSnapshot | null = null;
  private hudText = '';

  constructor(root: HTMLElement, opts: { chatInput: boolean } = { chatInput: false }) {
    this.el = document.createElement('div');
    this.el.className = 'mp-overlay hidden';

    // ---------- 顶栏 ----------
    const topbar = document.createElement('div');
    topbar.className = 'mp-topbar';

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'mp-sub';
    this.statusEl.innerHTML = '<span class="mp-dot"></span>未连接';

    this.pingEl = document.createElement('span');
    this.pingEl.className = 'mp-sub';

    const spacer = document.createElement('div');
    spacer.className = 'mp-spacer';

    this.fullscreenBtn = document.createElement('button');
    this.fullscreenBtn.className = 'mp-btn small mp-fullscreen';
    this.fullscreenBtn.textContent = '全屏';
    this.fullscreenBtn.addEventListener('click', () => {
      this.onAction?.({ type: 'fullscreen', v: !this.fullscreen });
    });

    // 右上角：连接状态 / 延迟 / 全屏（左上角留给玩家状态面板，避免遮挡）
    topbar.append(spacer, this.statusEl, this.pingEl, this.fullscreenBtn);

    // ---------- 对局中的信息条 ----------
    this.hudbar = document.createElement('div');
    this.hudbar.className = 'mp-hudbar';

    // ---------- 等待提示 ----------
    this.waiting = document.createElement('div');
    this.waiting.className = 'mp-waiting';
    this.waitingText = document.createElement('div');
    this.waitingText.className = 'mp-waiting-main';
    this.waitingSub = document.createElement('div');
    this.waitingSub.className = 'mp-waiting-sub';

    // 进度条
    this.progressWrap = document.createElement('div');
    this.progressWrap.className = 'mp-progress';
    const track = document.createElement('div');
    track.className = 'mp-progress-track';
    this.progressBar = document.createElement('div');
    this.progressBar.className = 'mp-progress-bar';
    track.append(this.progressBar);
    this.progressText = document.createElement('span');
    this.progressText.className = 'mp-progress-text';
    this.progressWrap.append(track, this.progressText);

    // 开始 / 观战
    this.startActions = document.createElement('div');
    this.startActions.className = 'mp-start-actions';
    // "按 W 开始"只提示、不响应鼠标：用 div 而非 button，避免被点、被 Tab 聚焦
    this.startHint = document.createElement('div');
    this.startHint.className = 'mp-start-hint';
    this.startHint.textContent = '按 W 开始游戏';
    this.spectateBtn = document.createElement('button');
    this.spectateBtn.className = 'mp-btn mp-spectate-btn';
    this.spectateBtn.textContent = '观战';
    this.spectateBtn.addEventListener('click', () => this.onAction?.({ type: 'spectate' }));
    this.startActions.append(this.startHint, this.spectateBtn);

    this.waiting.append(this.waitingText, this.progressWrap, this.waitingSub, this.startActions);

    // ---------- 结算弹窗 ----------
    this.modal = document.createElement('div');
    this.modal.className = 'mp-modal hidden';
    const card = document.createElement('div');
    card.className = 'mp-modal-card';
    this.modalBody = document.createElement('div');
    card.append(this.modalBody);
    this.modal.append(card);

    // ---------- 致命提示 ----------
    this.fatal = document.createElement('div');
    this.fatal.className = 'mp-fatal hidden';
    this.fatalText = document.createElement('div');
    this.fatalDetail = document.createElement('div');
    this.fatalDetail.className = 'detail';
    this.fatal.append(this.fatalText, this.fatalDetail);

    // ---------- 开发模式聊天 ----------
    if (opts.chatInput) {
      const chat = document.createElement('div');
      chat.className = 'mp-chat';
      const log = document.createElement('div');
      log.className = 'mp-chat-log';
      const row = document.createElement('div');
      row.className = 'mp-chat-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '开发模式聊天（Enter 发送）';
      input.maxLength = 160;
      const send = document.createElement('button');
      send.className = 'mp-btn small';
      send.textContent = '发送';
      row.append(input, send);
      chat.append(log, row);
      send.addEventListener('click', () => this.sendChat());
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          this.sendChat();
        } else if (e.key === 'Escape') {
          input.blur();
        }
      });
      input.addEventListener('focus', () => {
        inputBlock.typing = true;
        this.onTypingChange?.(true);
      });
      input.addEventListener('blur', () => {
        inputBlock.typing = false;
        this.onTypingChange?.(false);
      });
      this.chatBox = chat;
      this.chatLog = log;
      this.chatInput = input;
    }

    this.el.append(topbar, this.hudbar, this.waiting, this.modal, this.fatal);
    if (this.chatBox) this.el.append(this.chatBox);
    // 开始只认键盘 W：游戏常嵌在聊天室 iframe 里，键盘事件只会发给“已获得焦点”的文档。
    // 点一下覆盖层（不点按钮也行）就把焦点交给游戏，但不触发开始。
    this.el.addEventListener('pointerdown', () => this.focusSelf());
    root.append(this.el);
  }

  /** 把键盘焦点交给游戏所在窗口（iframe 内必须，否则按 W 无人接收） */
  focusSelf(): void {
    try {
      window.focus();
    } catch {
      /* 容器不允许时忽略：用户点一下画面也能拿到焦点 */
    }
  }

  get isTyping(): boolean {
    return !!this.chatInput && document.activeElement === this.chatInput;
  }

  show(): void {
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  setConnection(status: NetStatus, detail?: string): void {
    const dot =
      status === 'open' ? 'ok' : status === 'reconnecting' || status === 'connecting' ? 'warn' : 'bad';
    this.statusEl.innerHTML = '';
    const d = document.createElement('span');
    d.className = `mp-dot ${dot}`;
    this.statusEl.append(d, document.createTextNode(STATUS_TEXT[status] ?? status));
    if (detail) this.statusEl.title = detail;
  }

  setPing(ms: number): void {
    this.pingEl.textContent = ms >= 0 ? `${Math.round(ms)}ms` : '';
  }

  setFullscreen(value: boolean): void {
    this.fullscreen = value;
    this.fullscreenBtn.textContent = value ? '退出全屏' : '全屏';
  }

  setRoom(room: RoomSnapshot): void {
    this.room = room;
    if (this.waiting.classList.contains('show')) this.renderWaitingSub();
  }

  setRoomUsers(users: ShellRoomUser[]): void {
    if (this.waiting.classList.contains('show')) {
      this.renderWaitingSub(users.length);
    }
  }

  /** 记录对局信息（先不切换界面：还在加载 / 等玩家按 W） */
  prepareMatch(hudText: string): void {
    this.hudText = hudText;
  }

  /**
   * 真正开始：收起加载面板，只保留顶栏信息条。
   *
   * 注意：这里**不能** hideResults()。
   * 极端时序下（本局刚结束、下一局 match_start 与 match_end 几乎同时到达），
   * 新场景就绪会把刚弹出的结算面板立刻收掉 —— 玩家什么都看不到。
   * 结算面板的关闭交给下一次 showLoading()（即真正进入下一局时）。
   */
  beginHud(): void {
    this.waiting.classList.remove('show');
    this.statActionsHide();
    this.hudbar.textContent = this.hudText;
    this.el.classList.add('in-match');
  }

  /** 收起"开始/观战"面板（进入游戏后不应残留可点按钮） */
  private statActionsHide(): void {
    this.startActions.classList.remove('show');
    this.progressWrap.classList.remove('show');
  }

  /** 加载中：显示进度条与操作说明 */
  showLoading(label: string, progress: number): void {
    this.hideResults();
    this.el.classList.remove('in-match');
    this.waiting.classList.add('show');
    this.waitingText.textContent = label;
    this.progressWrap.classList.add('show');
    this.setProgress(progress);
    this.startActions.classList.remove('show');
    this.renderWaitingSub();
  }

  setProgress(progress: number): void {
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    this.progressBar.style.width = `${pct}%`;
    this.progressText.textContent = `${pct}%`;
  }

  /** 就绪：显示"按 W 开始游戏"提示与"观战"按钮 */
  showStartActions(canPlay: boolean): void {
    this.waiting.classList.add('show');
    this.el.classList.remove('in-match');
    this.waitingText.textContent = canPlay ? '一切就绪' : '本设备建议观战';
    this.progressWrap.classList.remove('show');
    this.startActions.classList.add('show');
    // 提示不可点：仅键盘 W 生效（触屏设备干脆不显示）
    this.startHint.style.display = canPlay ? '' : 'none';
    this.spectateBtn.classList.toggle('primary', !canPlay);
    this.spectateBtn.textContent = canPlay ? '观战' : '点击观战';
    this.renderWaitingSub();
  }

  setHudText(text: string): void {
    if (text === this.hudText) return;
    this.hudText = text;
    this.hudbar.textContent = text;
  }

  /** 等待提示（还没有对局 / 上一局结束等下一局） */
  showWaiting(text: string, sub = ''): void {
    this.hideResults();
    this.el.classList.remove('in-match');
    this.waiting.classList.add('show');
    this.waitingText.textContent = text;
    this.waitingSub.textContent = sub;
    this.progressWrap.classList.remove('show');
    this.startActions.classList.remove('show');
    this.renderWaitingSub();
  }

  hideWaiting(): void {
    this.waiting.classList.remove('show');
  }

  addChat(nick: string, text: string, fromRoom = false): void {
    if (!this.chatLog) return;
    const line = document.createElement('div');
    line.className = 'mp-chat-line';
    if (nick) {
      const who = document.createElement('span');
      who.className = fromRoom ? 'who room' : 'who';
      who.textContent = `${nick}${fromRoom ? '(房间)' : ''}:`;
      line.append(who, document.createTextNode(text));
    } else {
      line.classList.add('system');
      line.textContent = text;
    }
    this.chatLog.append(line);
    while (this.chatLog.childElementCount > 120) this.chatLog.firstElementChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  /**
   * 结算弹窗。
   *
   * `msg.delayMs`：先延迟弹出（留出"被谁击败"的镜头），倒计时仍按
   * `restartInMs`（服务端给的总时长）计算，所以延迟期间时间不会"白等"。
   */
  showResults(msg: MatchEndMsg, you: number): void {
    this.stopCountdown();
    this.clearResultsTimer();
    const restartAt = Date.now() + Math.max(0, msg.restartInMs || 0);
    const delay = Math.max(0, msg.delayMs || 0);
    if (delay <= 0) {
      this.renderResults(msg, you, restartAt);
      return;
    }
    this.resultsTimer = window.setTimeout(() => {
      this.resultsTimer = null;
      this.renderResults(msg, you, restartAt);
    }, delay);
  }

  private clearResultsTimer(): void {
    if (this.resultsTimer === null) return;
    window.clearTimeout(this.resultsTimer);
    this.resultsTimer = null;
  }

  private renderResults(msg: MatchEndMsg, you: number, restartAt: number): void {
    this.stopCountdown();
    this.modalBody.innerHTML = '';

    const title = document.createElement('h2');
    const teamMode = msg.mode === 'tdm';
    const winnerTeam = teamMode ? (msg.winnerTeam ?? -1) : -1;
    const youTeam = teamMode ? (msg.results.find((r) => r.netId === you)?.team ?? -1) : -1;
    const youWin = teamMode
      ? winnerTeam >= 0 && youTeam === winnerTeam
      : !!msg.results[0] && msg.results[0].netId === you;
    if (teamMode && winnerTeam < 0) {
      title.textContent = '平局';
    } else {
      title.textContent = youWin ? (teamMode ? '你们赢了！' : '你赢了！') : '本局结束';
    }

    const sub = document.createElement('div');
    sub.className = 'mp-sub';
    if (teamMode) {
      sub.textContent = winnerTeam >= 0 ? `胜方：${teamName(winnerTeam)}` : '两队同归于尽，平局';
    } else {
      sub.textContent = msg.winner ? `胜者：${msg.winner}` : '无人生还';
    }

    const list = document.createElement('div');
    list.className = 'mp-modal-list';
    msg.results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'mp-modal-row';
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = `#${i + 1}`;
      const nick = document.createElement('span');
      nick.className = 'nick';
      const team = teamMode ? (r.team ?? -1) : -1;
      nick.textContent =
        (team >= 0 ? `${teamName(team)} · ` : '') + r.nick + (r.netId === you ? '（你）' : '');
      if (team >= 0) nick.style.color = `#${teamColor(team).toString(16).padStart(6, '0')}`;
      const kills = document.createElement('span');
      kills.className = 'kills';
      kills.textContent = `${r.kills} 杀`;
      row.append(rank, nick, kills);
      list.append(row);
    });

    const tip = document.createElement('div');
    tip.className = 'mp-hint mp-countdown';
    const nextMap = msg.nextMap ? `「${msg.nextMap}」` : '下一张地图';
    // 下一局模式：预告弹窗必须说清楚是混战还是团队战
    const nextMode = modeShortLabel(msg.nextMode);
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((restartAt - Date.now()) / 1000));
      tip.textContent =
        left > 0
          ? `${left} 秒后开始下一局：${nextMap} · ${nextMode}`
          : `正在开始下一局：${nextMap} · ${nextMode}…`;
      if (left <= 0) this.stopCountdown();
    };
    tick();
    this.countdownTimer = window.setInterval(tick, 250);

    // 对局结束后不锁定画面：仍可自由活动（见 overlay.css 里 mp-modal 的 pointer-events）
    const hint = document.createElement('div');
    hint.className = 'mp-hint mp-results-hint';
    hint.textContent = '结算期间仍可自由活动';

    this.modalBody.append(title, sub, list, tip, hint);
    this.modal.classList.remove('hidden');
    // 保留 in-match：否则覆盖层会铺上深色背景，把游戏画面盖住
    this.el.classList.add('results');
  }

  hideResults(): void {
    this.stopCountdown();
    this.clearResultsTimer();
    this.modal.classList.add('hidden');
    this.el.classList.remove('results');
    const inMatch = this.hudbar.textContent !== '';
    if (inMatch) this.el.classList.add('in-match');
  }

  showFatal(text: string, detail = ''): void {
    this.fatalText.textContent = text;
    this.fatalDetail.textContent = detail;
    this.fatal.classList.remove('hidden');
  }

  private renderWaitingSub(channelUsers?: number): void {
    const room = this.room;
    const parts: string[] = [];
    if (room) {
      parts.push(`当前 ${room.players.length} 人在场`);
      if (room.map) parts.push(`地图：${room.map}`);
    }
    if (channelUsers !== undefined && channelUsers > 0) parts.push(`聊天室 ${channelUsers} 人`);
    parts.push('操作：WASD 移动 · 左键攻击 · 右键踢/替换 · G 手榴弹');
    this.waitingSub.textContent = parts.join(' · ');
  }

  private stopCountdown(): void {
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private sendChat(): void {
    if (!this.chatInput) return;
    const text = this.chatInput.value.trim();
    this.chatInput.value = '';
    if (text) this.onAction?.({ type: 'chat', text });
  }
}
