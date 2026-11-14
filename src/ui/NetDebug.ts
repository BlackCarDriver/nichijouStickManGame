/**
 * 网络诊断面板（`?netdebug=1`）。
 *
 * 部署到真实服务器后，光看"卡不卡"没法定位问题，所以把关键指标直接显示出来：
 * 角色、服务端认定的房主、RTT、位置/快照收包率、快照丢帧、远端单帧位移、掉落物数量、FPS。
 *
 * `window.__netDiag()` 可以一次性导出同样的数据（排查时让人截图/粘贴即可）。
 */
export class NetDebug {
  private readonly el: HTMLDivElement;
  private readonly pre: HTMLPreElement;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'mp-netdebug';
    this.pre = document.createElement('pre');
    this.el.append(this.pre);
    root.append(this.el);
  }

  update(data: Record<string, unknown> | null): void {
    if (!data) {
      this.pre.textContent = '网络诊断：未进入对局';
      return;
    }
    const lines = [
      `role      ${String(data.role)}  (host=${String(data.hostSeat)})`,
      `seat      ${String(data.netId)}`,
      `ping      ${String(data.rtt)}ms  (单程≈${String(data.oneWay)}ms)`,
      `插值延迟  ${String(data.interpDelay)}ms  (自适应 60~140)`,
      `pos       ${String(data.posHz)}Hz   snap ${String(data.snapHz)}Hz  丢帧 ${String(data.snapGaps)}`,
      `远端位移  ${String(data.remoteMaxStep)}px/帧   即时反馈 ${String(data.hitPreviews)} 次`,
      `掉落物    ${String(data.drops)}   玩家 ${String(data.players)}   fps ${String(data.fps)}`,
    ];
    this.pre.textContent = lines.join('\n');
  }

  destroy(): void {
    this.el.remove();
  }
}
