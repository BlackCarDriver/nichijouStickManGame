import type { ClientMsg, MatchLink, ServerMsg } from './protocol';

export type NetStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'fatal';

export interface NetClientOptions {
  /** 建立连接用的地址（token 为空表示本地 dev 模式） */
  buildUrl: (token: string) => string;
  /** 取得可用令牌；null = 暂时拿不到（外壳还没续签） */
  acquireToken: () => Promise<string | null>;
  onStatus?: (status: NetStatus, detail?: string) => void;
}

/** 不可重试的关闭码（与聊天室桥接/示例约定一致） */
const FATAL_CODES = new Set([4001, 4002, 4003, 4005, 4006, 4009]);

/**
 * 游戏 WebSocket 客户端：连接、重连、令牌续签、消息分发。
 *
 * 说明：
 * - 聊天室令牌只在"建连"时使用；连接保持期间不需要重发 JWT
 * - 掉线后先检查令牌剩余时间，不足时向外壳请求续签，再重连
 * - 断线重连采用 1s → 2s → 4s（上限 5s）退避，避免把服务端打满
 */
export class NetClient implements MatchLink {
  private ws: WebSocket | null = null;
  private handlers = new Set<(msg: ServerMsg) => void>();
  private status: NetStatus = 'idle';
  private retryTimer: number | null = null;
  private retryDelay = 1000;
  private disposed = false;
  private connecting = false;

  constructor(private readonly opts: NetClientOptions) {}

  get statusNow(): NetStatus {
    return this.status;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  subscribe(handler: (msg: ServerMsg) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(msg: ClientMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  async connect(): Promise<void> {
    if (this.disposed || this.connecting) return;
    this.clearRetry();
    this.connecting = true;
    try {
      const token = await this.opts.acquireToken();
      if (this.disposed) return;
      if (!token && !this.allowTokenless()) {
        this.setStatus('reconnecting', '等待聊天室凭证…');
        this.scheduleRetry(2000);
        return;
      }
      this.open(token ?? '');
    } finally {
      this.connecting = false;
    }
  }

  close(): void {
    this.disposed = true;
    this.clearRetry();
    this.detach();
    this.setStatus('closed');
  }

  /** 本地 dev 模式（页面独立打开、服务端 --dev）允许无令牌连接 */
  private allowTokenless(): boolean {
    return this.opts.buildUrl('').includes('dev=1');
  }

  private open(token: string): void {
    this.detach();
    const url = this.opts.buildUrl(token);
    this.setStatus('connecting');
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      this.setStatus('reconnecting', String(err));
      this.scheduleRetry(2000);
      return;
    }
    this.ws = sock;

    sock.onopen = () => {
      if (this.ws !== sock) return;
      this.retryDelay = 1000;
      this.setStatus('open');
    };
    sock.onmessage = (event) => {
      if (this.ws !== sock) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(event.data)) as ServerMsg;
      } catch {
        return;
      }
      for (const h of this.handlers) h(msg);
    };
    sock.onclose = (event) => {
      if (this.ws !== sock) return;
      this.ws = null;
      const fatal = FATAL_CODES.has(event.code);
      this.setStatus(fatal ? 'fatal' : 'reconnecting', `code=${event.code}`);
      if (fatal) {
        this.disposed = true;
        return;
      }
      this.scheduleRetry(this.retryDelay);
      this.retryDelay = Math.min(5000, this.retryDelay * 2);
    };
    sock.onerror = () => {
      if (this.ws !== sock) return;
      // 交给 onclose 统一处理
    };
  }

  private detach(): void {
    const sock = this.ws;
    if (!sock) return;
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
    try {
      sock.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private scheduleRetry(delayMs: number): void {
    if (this.disposed || this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delayMs);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setStatus(status: NetStatus, detail?: string): void {
    if (this.status === status && !detail) return;
    this.status = status;
    this.opts.onStatus?.(status, detail);
  }
}
