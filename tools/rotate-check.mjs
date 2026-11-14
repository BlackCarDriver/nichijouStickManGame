#!/usr/bin/env node
/**
 * 移动端竖屏旋转回归：验证 ?rotate=1 / 自动判定 下游戏层是否铺满屏幕。
 *
 * 用法：node tools/rotate-check.mjs [baseURL] [宽] [高] [rotate]
 *   - rotate=1 强制旋转；0 强制不旋转；留空 = 按"触屏 + 竖屏"自动判断
 *
 * 前置：服务端已启动并托管 dist（npm run build 之后）。
 * 检查点：
 *   1. 竖屏 + 触屏 → 游戏层旋转 90° 后刚好铺满视口，画布横向吃满宽度；
 *   2. 转成横屏 → 自动取消旋转并重新铺满（不会残留旋转/黑边）；
 *   3. 全程无未捕获异常。
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8096/';
const W = Number(process.argv[3] ?? 390);
const H = Number(process.argv[4] ?? 844);
const FORCE = process.argv[5] ?? '';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); this.exceptions = []; }
  async connect() {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
          this.ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(String(ev.data));
            if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); return; }
            if (msg.method === 'Runtime.exceptionThrown') this.exceptions.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
          });
          await this.send('Runtime.enable');
          await this.send('Page.enable');
          return this;
        }
      } catch {}
      await sleep(250);
    }
    throw new Error('cdp fail');
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 25000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result?.value;
  }
  async waitFor(expr, timeout = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.eval(expr)) return; } catch {}
      await sleep(150);
    }
    throw new Error('waitFor timeout: ' + expr);
  }
}

const profile = mkdtempSync(join(tmpdir(), 'rot-'));
const port = 9521;
const proc = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--mute-audio',`--window-size=${W},${H}`,'--disable-background-timer-throttling','--disable-renderer-backgrounding',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'about:blank'], { stdio: 'ignore' });
const cdp = await new Cdp(port).connect();
const errors = [];
try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const params = FORCE === '' ? '' : `&rotate=${FORCE}`;
  await cdp.send('Page.navigate', { url: `${BASE}?dev=1&nick=rotprobe${params}` });
  await cdp.waitFor(`!!window.__game && !!window.__room && !!window.__stage`);
  await cdp.waitFor(`window.__game.scene.isActive('GameScene')`, 40000);
  await cdp.waitFor(`window.__startGate.phase === 'ready'`, 40000);
  await sleep(400);
  const info = await cdp.eval(`(() => {
    const stage = window.__stage;
    const st = stage.getBoundingClientRect();
    const canvas = document.querySelector('#game-container canvas');
    const c = canvas.getBoundingClientRect();
    const overlay = document.querySelector('.mp-overlay');
    const btn = document.querySelector('.mp-spectate-btn') || document.querySelector('.mp-start-hint');
    const btnRect = btn ? btn.getBoundingClientRect() : null;
    return {
      viewport: [innerWidth, innerHeight],
      rotated: !!(window.__stage && stage.style.transform.includes('rotate')),
      stageStyle: [stage.style.width, stage.style.height, stage.style.transform],
      stageRect: [Math.round(st.width), Math.round(st.height)],
      canvasRect: [Math.round(c.width), Math.round(c.height)],
      canvasBox: [Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)],
      overlayInStage: !!overlay && !!overlay.closest('#game-stage'),
      startBtn: btn ? [btn.offsetWidth, btn.offsetHeight] : null,
      gate: window.__startGate.phase,
      fps: Math.round(window.__game.loop.actualFps),
    };
  })()`);
  const [vw, vh] = info.viewport;
  const [cw, ch] = info.canvasRect;
  const [sw, sh] = info.stageRect;
  const rotated = info.rotated;
  // 画布必须完整落在视口内且居中（margin 用旋转后的外接矩形算错过 → 只露出一角）
  const [bx, by, bw, bh] = info.canvasBox;
  if (bx < -1 || by < -1 || bx + bw > vw + 1 || by + bh > vh + 1) {
    errors.push(`canvas 超出可视区: box=${info.canvasBox} viewport=${info.viewport}`);
  }
  if (Math.abs(bx + bw / 2 - vw / 2) > 2 || Math.abs(by + bh / 2 - vh / 2) > 2) {
    errors.push(`canvas 未居中: box=${info.canvasBox} viewport=${info.viewport}`);
  }
  if (rotated) {
    if (sh !== vh || sw !== vw) errors.push(`stage 未铺满视口: stage=${sw}x${sh} viewport=${vw}x${vh}`);
    // 16:9 在竖屏里旋转后：宽度应≈视口宽，高度≈宽/9*16（受高度上限约束）
    const expectW = Math.min(vw, (vh * 9) / 16);
    if (Math.abs(cw - expectW) > 4) errors.push(`canvas 宽度不对: ${cw} 期望≈${Math.round(expectW)}`);
    if (!info.overlayInStage) errors.push('DOM 覆盖层不在旋转层里');
    if (!info.startBtn || info.startBtn[0] < 40 || info.startBtn[1] < 20) errors.push(`开始/观战按钮未正常布局: ${JSON.stringify(info.startBtn)}`);
  } else {
    if (sw !== vw || sh !== vh) errors.push(`非旋转态 stage 未铺满: ${sw}x${sh} vs ${vw}x${vh}`);
    if (!cw || !ch) errors.push('canvas 尺寸为 0');
  }
  // 运行中改成横屏：应当自动取消旋转并重新铺满（?rotate=1 强制旋转时不适用）
  if (FORCE === '1') {
    if (cdp.exceptions.length > 0) errors.push(`未捕获异常: ${cdp.exceptions.slice(0, 2).join(' | ')}`);
    console.log(JSON.stringify(info, null, 1));
    console.log(errors.length ? `\n❌ 旋转适配失败：\n   - ${errors.join('\n   - ')}` : '\n✅ 旋转适配检查通过（强制旋转：竖屏铺满）');
    process.exitCode = errors.length ? 1 : 0;
    throw { needCleanup: true };
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: H, height: W, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  const after = await cdp.eval(`(() => {
    const stage = window.__stage;
    const st = stage.getBoundingClientRect();
    const c = document.querySelector('#game-container canvas').getBoundingClientRect();
    return { viewport: [innerWidth, innerHeight], rotated: stage.style.transform.includes('rotate'), stageRect: [Math.round(st.width), Math.round(st.height)], canvasRect: [Math.round(c.width), Math.round(c.height)], canvasBox: [Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)] };
  })()`);
  if (after.rotated) errors.push(`改横屏后仍在旋转: ${JSON.stringify(after)}`);
  if (Math.abs(after.stageRect[0] - after.viewport[0]) > 2 || Math.abs(after.stageRect[1] - after.viewport[1]) > 2) {
    errors.push(`改横屏后 stage 未铺满: ${JSON.stringify(after)}`);
  }
  if (after.canvasRect[0] < 100 || after.canvasRect[1] < 60) errors.push(`改横屏后 canvas 尺寸异常: ${JSON.stringify(after)}`);
  {
    const [ax, ay, aw, ah] = after.canvasBox;
    if (ax < -1 || ay < -1 || ax + aw > after.viewport[0] + 1 || ay + ah > after.viewport[1] + 1) {
      errors.push(`改横屏后 canvas 超出可视区: ${JSON.stringify(after.canvasBox)} viewport=${after.viewport}`);
    }
  }

  if (cdp.exceptions.length > 0) errors.push(`未捕获异常: ${cdp.exceptions.slice(0, 2).join(' | ')}`);
  console.log(JSON.stringify({ ...info, after }, null, 1));
  if (errors.length > 0) {
    console.log(`\n❌ 旋转适配失败：`);
    for (const e of errors) console.log(`   - ${e}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 旋转适配检查通过（竖屏铺满 + 横屏自动恢复）');
  }
} catch (e) {
  if (!(e && e.needCleanup)) throw e;
} finally {
  try { proc.kill('SIGKILL'); } catch {}
  try { execSync(`pkill -9 -f "user-data-dir=${profile}"`, { stdio: 'ignore' }); } catch {}
  rmSync(profile, { recursive: true, force: true });
}
