/**
 * 聊天室外壳（插件房 iframe）通信层。
 *
 * 入站消息（外壳 → 页面）：INIT / TOKEN / ROOM_STATE / FULLSCREEN_CHANGE
 * 出站消息（页面 → 外壳）：READY / REQUEST_TOKEN / FULLSCREEN_REQUEST
 *
 * 安全约定（比示例更严格）：
 * - 入站必须来自 `window.parent`，且锁定首个合法消息的 origin，之后只认这个 origin
 * - 出站统一发到锁定后的精确 origin；未锁定时才退回 `'*'`（发送 READY 必须如此）
 * - 身份永远以服务端验签结果为准，这里的 roomId/nick 只用于展示
 */

export interface ShellInitConfig {
  roomId?: number;
  template?: string;
  canvasRatio?: string;
  portraitCanvasRatio?: string;
  enableInGameChat?: boolean;
  chatMode?: string;
  protocolVersion?: string;
  fileServerHost?: string;
}

export interface ShellRoomUser {
  nick: string;
  state?: string;
  text?: string;
}

type TokenWaiter = (token: string | null) => void;

export class ShellBridge {
  /** 当前 JWT 与过期时间（Unix 秒） */
  token = '';
  tokenExpireAt = 0;
  init: ShellInitConfig = {};
  roomUsers: ShellRoomUser[] = [];
  fullscreen = false;

  private trustedOrigin: string | null = null;
  private waiters: TokenWaiter[] = [];
  private started = false;

  onInit?: (init: ShellInitConfig) => void;
  onToken?: (token: string, expireAt: number) => void;
  onRoomState?: (users: ShellRoomUser[]) => void;
  onFullscreen?: (value: boolean) => void;

  /** 是否运行在聊天室 iframe 内 */
  get inIframe(): boolean {
    try {
      return window.parent !== window;
    } catch {
      return true;
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('message', this.handleMessage);
    // 未锁 origin 时只能用 '*'（此时页面还未与外壳建立信任）
    this.post({ type: 'READY' });
    // 兜底：若外壳先于 READY 发过消息会漏掉，这里再主动要一次令牌
    setTimeout(() => {
      if (!this.token) this.post({ type: 'REQUEST_TOKEN' });
    }, 1500);
  }

  dispose(): void {
    window.removeEventListener('message', this.handleMessage);
    this.started = false;
  }

  /** 请求外壳续签令牌；返回新的 token（超时返回 null） */
  requestToken(timeoutMs = 15000): Promise<string | null> {
    this.post({ type: 'REQUEST_TOKEN' });
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const waiter: TokenWaiter = (token) => {
        window.clearTimeout(timer);
        resolve(token);
      };
      this.waiters.push(waiter);
    });
  }

  requestFullscreen(value: boolean): void {
    this.post({ type: 'FULLSCREEN_REQUEST', value });
  }

  /** 令牌剩余秒数（无过期时间时返回 +Infinity） */
  tokenRemain(): number {
    if (!this.tokenExpireAt) return Number.POSITIVE_INFINITY;
    return this.tokenExpireAt - Math.floor(Date.now() / 1000);
  }

  private post(payload: Record<string, unknown>): void {
    try {
      window.parent.postMessage(payload, this.trustedOrigin ?? '*');
    } catch {
      /* 跨域被拒时忽略：外壳可能已关闭 */
    }
  }

  private handleMessage = (event: MessageEvent): void => {
    if (!this.inIframe) return;
    if (event.source !== window.parent) return;
    if (this.trustedOrigin && event.origin !== this.trustedOrigin) return;

    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return;
    const type = data.type;
    if (typeof type !== 'string') return;

    if (!this.trustedOrigin) this.trustedOrigin = event.origin;

    switch (type) {
      case 'INIT':
        this.init = (data.config as ShellInitConfig) ?? {};
        this.onInit?.(this.init);
        break;
      case 'TOKEN': {
        const token = typeof data.token === 'string' ? data.token : '';
        if (!token) return;
        this.token = token;
        this.tokenExpireAt = typeof data.expireAt === 'number' ? data.expireAt : 0;
        const list = this.waiters;
        this.waiters = [];
        for (const w of list) w(token);
        this.onToken?.(token, this.tokenExpireAt);
        break;
      }
      case 'ROOM_STATE':
        this.roomUsers = Array.isArray(data.states) ? (data.states as ShellRoomUser[]) : [];
        this.onRoomState?.(this.roomUsers);
        break;
      case 'FULLSCREEN_CHANGE':
        this.fullscreen = data.value === true;
        this.onFullscreen?.(this.fullscreen);
        break;
      default:
        break;
    }
  };
}
