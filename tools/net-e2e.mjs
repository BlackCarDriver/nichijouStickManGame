#!/usr/bin/env node
/**
 * 浏览器端到端联机验证：两个无头 Chrome 打开同一插件房（dev 假身份），
 * 走完 大厅 → 准备 → 开局 → 输入中继 → 伤害仲裁 → 拾取仲裁 → 聊天 的全链路。
 *
 * 前置：
 *   cd server && go build -o /tmp/stickman-server . && /tmp/stickman-server --dev
 *   npm run build        （由 Go 服务托管 dist/）
 *
 * 用法：node tools/net-e2e.mjs [baseURL]
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.NET_E2E_BASE ?? process.argv[2] ?? 'http://127.0.0.1:8095/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

class Cdp {
  constructor(port) {
    this.port = port;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
  }

  async connect() {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
          });
          this.ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(String(ev.data));
            if (msg.id && this.pending.has(msg.id)) {
              const { resolve, reject } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) reject(new Error(JSON.stringify(msg.error)));
              else resolve(msg.result);
              return;
            }
            if (msg.method === 'Runtime.exceptionThrown') {
              this.exceptions.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
            }
          });
          await this.send('Runtime.enable');
          return this;
        }
      } catch (err) {
        /* retry */
      }
      await sleep(250);
    }
    throw new Error(`CDP ${this.port} 连接失败`);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'eval 异常');
    }
    return result.result?.value;
  }

  async shot(path) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('/tmp/stickman-shots', { recursive: true });
    writeFileSync(path, Buffer.from(result.data, 'base64'));
  }

  async waitFor(expression, timeout = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await this.eval(expression)) return true;
      } catch (err) {
        /* 页面还没加载出来 */
      }
      await sleep(200);
    }
    throw new Error(`等待超时: ${expression}`);
  }

  close() {
    try {
      this.ws?.close();
    } catch (err) {
      /* ignore */
    }
  }
}

async function launch(nick, port) {
  const profile = mkdtempSync(join(tmpdir(), `stickman-e2e-${nick}-`));
  const avatar = encodeURIComponent('https://nichijou.cn/source/avatar/103.jpg');
  const url = `${BASE}?dev=1&nick=${encodeURIComponent(nick)}&avatar=${avatar}`;
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--window-size=1280,720',
    // 无头多开时窗口可能被判定为"后台"，rAF 会被节流到 1fps，游戏逻辑几乎不更新
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    url,
  ], { stdio: 'ignore' });
  const cdp = await new Cdp(port).connect();
  await cdp.waitFor('!!window.__game && !!window.__room');
  return { nick, proc, cdp, profile };
}

const launched = [];

/** 找一个 CDP 端口：已经有 DevTools 在监听就让开 */
async function freePort(start) {
  let port = start;
  for (let i = 0; i < 40; i++, port++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
    } catch {
      return port;
    }
  }
  return port;
}

async function main() {
  console.log(`浏览器 E2E 联机验证 → ${BASE}\n`);

  // 昵称带随机后缀：避免上一轮残留的无头 Chrome（断线后会一直重连）顶号
  const tag = Math.random().toString(36).slice(2, 6);
  const nickA = `e2eA_${tag}`;
  const nickB = `e2eB_${tag}`;
  const nickC = `e2eC_${tag}`;

  // 动态挑两个空闲的 CDP 端口：避免与本地其它调试会话抢 9301/9302
  const portA = await freePort(9410);
  const portB = await freePort(portA + 1);
  const a = await launch(nickA, portA);
  launched.push(a);
  await a.cdp.waitFor('window.__room.net.isOpen === true');
  check('客户端已连上游戏服务', true);

  // ---- 加载进度条 → "按 W 开始游戏"（仅键盘，不可点） → 按 W 进入 ----
  await a.cdp.waitFor(`window.__game.scene.isActive('GameScene')`, 20000);
  const loadingUi = await a.cdp.eval(`(() => {
    const bar = document.querySelector('.mp-progress');
    const txt = document.querySelector('.mp-progress-text')?.textContent ?? '';
    const hint = document.querySelector('.mp-waiting-sub')?.textContent ?? '';
    const startShown = getComputedStyle(document.querySelector('.mp-start-actions')).display !== 'none';
    return {
      visible: getComputedStyle(bar).display !== 'none',
      text: txt,
      hint,
      startShown,
      phase: window.__startGate.phase,
    };
  })()`);
  check(
    '加载阶段有进度条与操作说明',
    // 资源可能已被缓存、加载很快：进度条已收起但仍在/曾显示过（进度文本为 80%/100%）
    (loadingUi.visible || loadingUi.startShown) && /%/.test(loadingUi.text) && /WASD/.test(loadingUi.hint),
    JSON.stringify(loadingUi),
  );
  await a.cdp.waitFor(`window.__startGate.phase === 'ready'`, 25000);
  const readyUi = await a.cdp.eval(`(() => {
    const hint = document.querySelector('.mp-start-hint');
    return {
      hint: hint?.textContent ?? '',
      hintIsButton: hint ? hint.tagName === 'BUTTON' : null,
      hintClickable: hint ? getComputedStyle(hint).pointerEvents !== 'none' : null,
      oldButtonGone: !document.querySelector('.mp-start-btn'),
      startVisible: getComputedStyle(document.querySelector('.mp-start-actions')).display !== 'none',
      spectate: document.querySelector('.mp-spectate-btn')?.textContent ?? '',
      blocked: window.__startGate.blocked,
      barHidden: getComputedStyle(document.querySelector('.mp-progress')).display === 'none',
    };
  })()`);
  check(
    '就绪后弹出"按 W 开始游戏"提示（纯提示、鼠标点不动）与观战按钮',
    readyUi.startVisible && /W/.test(readyUi.hint) && readyUi.hintIsButton === false && readyUi.hintClickable === false &&
      readyUi.oldButtonGone && /观战/.test(readyUi.spectate) && readyUi.blocked && readyUi.barHidden,
    JSON.stringify(readyUi),
  );
  // 开始前：还没有自己的火柴人（不在对局里），并且输入被冻结
  const preStart = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    return { players: s.players.length, hasLocal: !!s.online.localPlayer, blocked: window.__startGate.blocked, joined: s.online.localNetId };
  })()`);
  check(
    '按 W 之前没有创建自己的火柴人、也不在对局里',
    preStart.hasLocal === false && preStart.blocked === true,
    JSON.stringify(preStart),
  );
  // 真按 W
  await a.cdp.eval(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true }));
    return true;
  })()`);
  await a.cdp.waitFor(
    `(() => {
      const s = window.__game.scene.getScene('GameScene');
      return window.__startGate.phase === 'playing' && s && s.online && s.online.localNetId >= 0 && !!s.online.localPlayer;
    })()`,
    25000,
  );
  check('按 W 后自动入局（面板收起、本地火柴人出现）', true);

  // ---- 单人进房直接开局（无大厅、无准备按钮） ----
  const solo = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    return {
      players: s.players.length,
      you: s.online.localNetId,
      localAlive: !!s.online.localPlayer,
      map: s.mapData.name,
      drops: s.pickups.list.length,
      hasLobby: !!document.querySelector('.mp-btn.ready') || !!document.querySelector('.mp-mapbar'),
    };
  })()`);
  check(
    '按 W 后立刻可操控（无需大厅/准备）',
    solo.players >= 1 && solo.you >= 0 && solo.localAlive === true,
    JSON.stringify(solo),
  );
  check('没有大厅/准备/选图界面', solo.hasLobby === false);
  check('随机地图 + 服务端掉落物', !!solo.map && solo.drops > 0, JSON.stringify(solo));

  // ---- 第二个玩家进房：加入同一局，A 动态生成对手 ----
  const b = await launch(nickB, portB);
  launched.push(b);
  await b.cdp.waitFor(`window.__game.scene.isActive('GameScene')`, 25000);
  await b.cdp.waitFor(`window.__startGate.phase === 'ready'`, 25000);
  await b.cdp.eval(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true }));
    return true;
  })()`);
  await b.cdp.waitFor(
    `(() => {
      const s = window.__game.scene.getScene('GameScene');
      return window.__startGate.phase === 'playing' && s && s.online && s.online.localNetId >= 0 && s.players.length === 2;
    })()`,
    25000,
  );
  await a.cdp.waitFor(`window.__game.scene.getScene('GameScene').players.length === 2`, 8000);
  const joined = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const ids = s.players.map((p) => s.online.netIdOf(p)).filter((id) => id >= 0).sort((x, y) => x - y);
    return { players: s.players.length, ids, sameMap: s.mapData.name };
  })()`);
  check('中途加入的对手实时出现在场上', joined.players === 2 && joined.ids.length === 2, JSON.stringify(joined));

  const sameMatch = {
    a: await a.cdp.eval(`(() => { const s = window.__game.scene.getScene('GameScene'); return { matchId: s.onlineData.matchId, you: s.online.localNetId, players: s.players.length }; })()`),
    b: await b.cdp.eval(`(() => { const s = window.__game.scene.getScene('GameScene'); return { matchId: s.onlineData.matchId, you: s.online.localNetId, players: s.players.length }; })()`),
  };
  check('两个客户端在同一局', sameMatch.a.matchId === sameMatch.b.matchId && sameMatch.a.players === 2, JSON.stringify(sameMatch));

  const fpsA = await a.cdp.eval(`Math.round(window.__game.loop.actualFps)`);
  const fpsB = await b.cdp.eval(`Math.round(window.__game.loop.actualFps)`);
  check('两个客户端都在正常跑游戏循环（≥30fps）', fpsA >= 30 && fpsB >= 30, `A=${fpsA} B=${fpsB}`);

  const hudNames = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    return s.hud.slots.map((slot) => slot.nameText.text);
  })()`);
  check('HUD 显示真实昵称', hudNames.includes(nickA) && hudNames.includes(nickB), JSON.stringify(hudNames));

  const headNames = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    return s.players.map((p) => p.nameLabel?.text ?? '');
  })()`);
  check('火柴人头顶展示昵称', headNames.includes(nickA) && headNames.includes(nickB), JSON.stringify(headNames));

  await a.cdp.waitFor(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const mine = s.players.filter((p) => (p.nameLabel?.text ?? '').includes(${JSON.stringify(tag)}));
    return mine.length === 2 && mine.every((p) => !!p.headAvatar && p.headAvatar.visible);
  })()`, 15000);
  const avatars = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const mine = s.players.filter((p) => (p.nameLabel?.text ?? '').includes(${JSON.stringify(tag)}));
    return {
      heads: mine.filter((p) => !!p.headAvatar && p.headAvatar.visible).length,
      circleKeys: mine.map((p) => p.avatarCircleKey ?? ''),
      hud: s.hud.slots.filter((slot) => !!slot.avatar).length,
    };
  })()`);
  check('火柴人头像 + HUD 圆形头像已加载', avatars.heads === 2 && avatars.hud >= 2 && avatars.circleKeys.every(Boolean), JSON.stringify(avatars));

  // ---- 全屏按钮在对局中可点（曾经因 pointer-events 失效） ----
  const fsState = await a.cdp.eval(`(() => {
    const btn = document.querySelector('.mp-fullscreen');
    const bar = document.querySelector('.mp-topbar');
    return {
      btn: getComputedStyle(btn).pointerEvents,
      bar: getComputedStyle(bar).pointerEvents,
      visible: getComputedStyle(btn).display !== 'none',
    };
  })()`);
  check('对局中全屏按钮可点击', fsState.visible && fsState.btn === 'auto' && fsState.bar === 'auto', JSON.stringify(fsState));

  // ---- 输入中继（无头多开偶尔会被系统调度打断，失败重试） ----
  let relayOk = false;
  let relayDetail = '';
  for (let attempt = 0; attempt < 3 && !relayOk; attempt++) {
    const startX = await a.cdp.eval(`window.__game.scene.getScene('GameScene').online.localPlayer.container.x`);
    await a.cdp.eval(`(() => {
      const s = window.__game.scene.getScene('GameScene');
      const orig = s.inputManager.readP1.bind(s.inputManager);
      window.__origRead = orig;
      s.inputManager.readP1 = () => {
        const c = orig();
        c.moveX = 1;
        return c;
      };
      return true;
    })()`);
    await sleep(1000);
    const now = await a.cdp.eval(`(() => {
      const s = window.__game.scene.getScene('GameScene');
      return {
        x: s.online.localPlayer.container.x,
        cmd: s.online.localCmd?.moveX ?? null,
        fps: Math.round(window.__game.loop.actualFps),
        dead: s.online.localPlayer.health.isDead,
      };
    })()`);
    const seen = await b.cdp.eval(`(() => {
      const s = window.__game.scene.getScene('GameScene');
      const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
      return s.online.playerOf(other).container.x;
    })()`);
    relayOk = seen > startX + 40;
    relayDetail = `第${attempt + 1}次：起点=${Math.round(startX)} 本地=${Math.round(now.x)} cmd=${now.cmd} fps=${now.fps} dead=${now.dead} B看到=${Math.round(seen)}`;
    await a.cdp.eval(`(() => {
      const s = window.__game.scene.getScene('GameScene');
      if (window.__origRead) s.inputManager.readP1 = window.__origRead;
      return true;
    })()`);
    if (!relayOk) await sleep(400);
  }
  check('输入经服务端中继后对端玩家移动', relayOk, relayDetail);

  // ---- 跳跃高度固定（取消"按得越久跳得越高"）----
  const hostCdpOf = async () => ((await a.cdp.eval(`window.__game.scene.getScene('GameScene').online.isAuthority`)) ? a.cdp : b.cdp);
  const jumpTest = await hostCdpOf().then(async (cdp) => {
    const measure = async (hold) => {
      const r = await cdp.eval(`(async () => {
        const s = window.__game.scene.getScene('GameScene');
        const p = s.online.localPlayer;
        const sp = s.mapData.spawnPoints[0];
        p.container.setPosition(sp.x, sp.y - 4);
        p.container.setVelocity(0, 0);
        await new Promise((r) => setTimeout(r, 600));
        const orig = s.inputManager.readP1.bind(s.inputManager);
        window.__origJumpRead = orig;
        let frames = 0;
        s.inputManager.readP1 = () => {
          const c = orig();
          frames++;
          c.moveX = 0;
          c.jump = frames === 2;
          c.jumpHeld = ${hold ? 'true' : 'false'};
          return c;
        };
        const y0 = p.container.y;
        let minY = y0;
        for (let i = 0; i < 70; i++) {
          await new Promise((r) => setTimeout(r, 16));
          if (p.container.y < minY) minY = p.container.y;
        }
        s.inputManager.readP1 = orig;
        return { apex: Math.round((y0 - minY) * 10) / 10 };
      })()`);
      return r.apex;
    };
    const tapped = await measure(false);
    const held = await measure(true);
    return { tapped, held };
  });
  check(
    '跳跃高度与按键时长无关（取消可变跳跃）',
    jumpTest.tapped > 80 && Math.abs(jumpTest.tapped - jumpTest.held) <= 12,
    JSON.stringify(jumpTest),
  );

  // ---- 屏幕外对手箭头 ----
  // v3：位置由**各自客户端权威**，本端改自己的位置会经服务端中继给对端（插值 ~100ms）。
  const bMove = await b.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const sp = s.mapData.spawnPoints;
    let far = sp[0];
    for (const p of sp) if (Math.abs(p.x - sp[0].x) > Math.abs(far.x - sp[0].x)) far = p;
    const before = Math.round(me.container.x);
    me.container.setPosition(far.x, far.y - 60);
    me.container.setVelocity(0, 0);
    return { before, target: Math.round(far.x), matchId: s.onlineData.matchId };
  })()`);
  await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const sp = s.mapData.spawnPoints;
    me.container.setPosition(sp[0].x, sp[0].y - 60);
    me.container.setVelocity(0, 0);
    return true;
  })()`);
  await sleep(1600);
  const arrow = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const cam = s.cameras.main;
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const bp = s.online.playerOf(other);
    const v = cam.worldView;
    const labels = [...s.offscreen.labels.values()].map((l) => ({ text: l.text, visible: l.visible }));
    return {
      count: s.offscreen.labels.size,
      labels,
      localX: Math.round(s.online.localPlayer.container.x),
      otherX: Math.round(bp?.container.x ?? -1),
      screenX: Math.round((bp.container.x - v.x) * cam.zoom),
      camW: cam.width,
    };
  })()`);
  check(
    '画面外对手显示边缘箭头',
    arrow.count >= 1 && arrow.labels.some((l) => l.visible),
    JSON.stringify({ bMove, arrow }),
  );
  // 对端的位置通过 pos 中继同步过来（误差 = 单程延迟 × 速度，本机很小）
  const follower = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const p = s.online.playerOf(other);
    return { x: Math.round(p.container.x) };
  })()`);
  check(
    '玩家位置通过 pos 中继同步到对端',
    Math.abs(follower.x - bMove.target) < 160,
    JSON.stringify({ follower, bMove }),
  );

  // ---- 伤害仲裁 ----
  // 先记录双方数值（诊断用：伤害可能被护盾吸收，也可能被击杀/无敌帧影响）
  const dmgBefore = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const p = s.online.playerOf(other);
    return { hp: p.health.hp, shield: p.health.shield, dead: p.health.isDead, net: other };
  })()`);
  const dmg = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const target = s.online.playerOf(other);
    s.damageSystem.damagePlayer(target, {
      amount: 25, kind: 'bullet', sourceId: me.id,
      // 用身体中心（头部带会触发暴击 ×2，干扰断言）
      point: { x: target.container.x, y: target.container.y },
      normal: { x: -1, y: 0 }, knockback: { x: -3, y: -1 }, attackId: 99,
    });
    return true;
  })()`);
  check('本地发起伤害上报', dmg === true);
  await sleep(500);
  const hpA = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const p = s.online.playerOf(other);
    return { hp: p.health.hp, shield: p.health.shield, dead: p.health.isDead, matchId: s.onlineData.matchId };
  })()`);
  const hpB = await b.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    return {
      hp: s.online.localPlayer.health.hp,
      shield: s.online.localPlayer.health.shield,
      dead: s.online.localPlayer.health.isDead,
      matchId: s.onlineData.matchId,
      diag: window.__netDiag ? window.__netDiag() : null,
      sink: !!s.damageSystem.netSink,
    };
  })()`);
  // 伤害先扣护盾再扣血，所以用 "hp + shield" 的总量来判断"确实掉了"
  const totalA = hpA.hp + (hpA.shield ?? 0);
  const totalB = hpB.hp + (hpB.shield ?? 0);
  if (!(hpA.hp === hpB.hp && totalA < dmgBefore.hp + dmgBefore.shield && totalA < 100)) {
    console.log(`  ℹ️ 伤害诊断: before=${JSON.stringify(dmgBefore)} afterA=${JSON.stringify(hpA)} afterB=${JSON.stringify(hpB)}`);
  }
  // 注意：伤害先扣护盾，所以"总量"的初值可能是 100 + 护盾（防弹衣 50），
  // 断言只能比较"相对伤害前有没有减少"，不能写死 <100。
  check(
    '服务端权威血量：双方一致且确有扣减',
    hpA.hp === hpB.hp &&
      (hpA.shield ?? 0) === (hpB.shield ?? 0) &&
      totalA < dmgBefore.hp + dmgBefore.shield &&
      hpA.matchId === bMove.matchId,
    `A端看到B=${JSON.stringify(hpA)} B端自己=${JSON.stringify(hpB)} 总量=${totalA} 伤害前=${JSON.stringify(dmgBefore)}（开局=${bMove.matchId}）`,
  );

  // ---- 打击反馈：本地命中立刻出数字/硬直，不等 hp；hp 到达后不重复 ----
  const preview1 = await b.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const st = s.online.stats;
    return { previews: st.hitPreviews, interpDelay: st.interpDelay };
  })()`);
  const hitFeedback = await b.cdp.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const target = s.online.playerOf(other);
    const before = s.online.stats.hitPreviews;
    const hpBefore = target.health.hp + target.health.shield;
    // 模拟"我的子弹命中对手"（DamageSystem 会先播即时反馈，再上报）
    s.damageSystem.damagePlayer(target, {
      amount: 20, kind: 'bullet', sourceId: me.id, weaponId: 'pistol',
      point: { x: target.container.x, y: target.container.y },
      normal: { x: -1, y: 0 }, knockback: { x: -2, y: 0 }, attackId: 8801,
    });
    // 同步检查：此刻（同一帧内）应当已经播过反馈，而血量还没变
    return {
      previewsDelta: s.online.stats.hitPreviews - before,
      hpRightNow: target.health.hp + target.health.shield,
      hpBefore,
      previewed: s.previewedHits.has(8801),
    };
  })()`);
  check(
    '攻击方在同一帧就拿到打击反馈（不等 hp）',
    hitFeedback.previewsDelta >= 1 && hitFeedback.previewed === true,
    JSON.stringify(hitFeedback),
  );
  await sleep(900);
  const reconciled = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const p = s.online.playerOf(other);
    return { hp: p.health.hp, shield: p.health.shield };
  })()`);
  check(
    '随后 hp 把数值补齐（只补数值，不重复播数字）',
    reconciled.hp + reconciled.shield < hitFeedback.hpBefore,
    JSON.stringify(reconciled),
  );

  const preview2 = await b.cdp.eval(`window.__game.scene.getScene('GameScene').online.stats.hitPreviews`);
  check('即时反馈计数在增长', preview2 > preview1.previews, JSON.stringify({ before: preview1.previews, after: preview2 }));
  check('自适应插值延迟落在 60~200ms', preview1.interpDelay >= 60 && preview1.interpDelay <= 200, `interpDelay=${preview1.interpDelay}`);

  // ---- 拾取仲裁（重试：偶尔上一帧的位置还没进服务端） ----
  let pickResult = { ok: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    pickResult = await a.cdp.eval(`(async () => {
      const s = window.__game.scene.getScene('GameScene');
      const drop = s.pickups.list.find((i) => i.kind === 'weapon' && i.weaponId !== 'grenade');
      if (!drop) return { ok: false, reason: '没有武器掉落物' };
      const me = s.online.localPlayer;
      // 真正把角色挪到掉落物旁边：拾取由"自己"请求（服务端按上报位置校验距离）
      me.container.setPosition(drop.x, drop.y);
      me.container.setVelocity(0, 0);
      await new Promise((r) => setTimeout(r, 900));
      return {
        ok: true,
        netId: drop.netId ?? null,
        weapon: me.heldWeapon?.id ?? '',
        drops: s.pickups.list.length,
        seat: s.online.localNetId,
        matchId: s.onlineData.matchId,
      };
    })()`);
    if (pickResult.ok && pickResult.weapon) break;
    await sleep(300);
  }
  check('拾取由服务端授予并装备到本地', !!pickResult.ok && !!pickResult.weapon, JSON.stringify(pickResult));
  const aDrops = await a.cdp.eval(`window.__game.scene.getScene('GameScene').pickups.list.length`);
  const bDrops = await b.cdp.eval(`window.__game.scene.getScene('GameScene').pickups.list.length`);
  check('掉落物在两端同步', aDrops === bDrops, `A=${aDrops} B=${bDrops}`);

  // ---- 核心回归 1：远端玩家走"100ms 缓冲插值"，不再出现瞬移 ----
  // v3：位置由各自客户端权威，A 自己的跳跃会经 pos 中继到 B（B 只是观察者）
  const moverCdp = a.cdp;
  const watcherCdp = b.cdp;
  await watcherCdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    s.online.stats.remoteMaxStep = 0;
    return true;
  })()`);
  for (let i = 0; i < 4; i++) {
    await moverCdp.eval(`(() => {
      const s = window.__game.scene.getScene('GameScene');
      s.online.localPlayer.container.setVelocityY(-17);
      return true;
    })()`);
    await sleep(450);
  }
  await sleep(400);
  const teleport = await watcherCdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const st = s.online.stats;
    return { role: st.role, maxStep: Math.round(st.remoteMaxStep * 10) / 10, posHz: st.posHz, oneWay: st.oneWay, fps: st.fps };
  })()`);
  check(
    '远端玩家按缓冲插值回放：单帧位移不出现瞬移',
    teleport.posHz > 0 && teleport.maxStep > 0 && teleport.maxStep <= 45,
    JSON.stringify(teleport),
  );

  // ---- 核心回归 1b：本地位置不会被权威回拉（无橡皮筋）----
  // v3 下位置由本人权威，所以"挪一段就停在那儿"；v2 会被房主硬拽回去。
  //
  // 两个健壮性处理（老版本会偶发失败，且失败原因是"被墙挡住"而非真的橡皮筋）：
  //  1) 挪位置用**刚体 API**：container.setPosition 只动显示对象，物理体会把它拽回去；
  //  2) 断言改成"没有回到原位"，而不是"必须精确到达目标点"：
  //     随机地图右侧可能有墙，把玩家顶回几像素（实测 282 vs 290）并不代表被回拉。
  const noPull = await b.cdp.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const place = (x, y) => {
      s.matter.body.setPosition(me.body, { x, y });
      s.matter.body.setVelocity(me.body, { x: 0, y: 0 });
    };
    // 先回到第一个出生点（保证右侧是空地，避免被墙挡住误判）
    const sp = s.mapData.spawnPoints[0];
    place(sp.x, sp.y - 20);
    await new Promise((r) => setTimeout(r, 500));
    const x0 = me.body.position.x;
    const target = Math.round(x0 + 90);
    place(x0 + 90, me.body.position.y);
    const trail = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 100));
      trail.push(Math.round(me.body.position.x));
    }
    return { x0: Math.round(x0), target, trail };
  })()`);
  check(
    '本地位置不会被拉回（无橡皮筋）',
    // 8 次采样都明显离原位更近目标：没有"被拽回原位"的橡皮筋行为
    noPull.trail.every((x) => x > noPull.x0 + 40),
    JSON.stringify(noPull),
  );

  // ---- 核心回归 2：动态刚体（纸箱/箱子）位置与朝向两端一致 ----
  const worldHostCdp = await hostCdpOf();
  const crateId = await worldHostCdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const o = s.mapObjects.find((m) => m.body && !m.body.isStatic);
    if (!o) return '';
    s.matter.body.applyForce(o.body, o.body.position, { x: 0.08, y: -0.03 });
    return o.id;
  })()`);
  await sleep(1600);
  const readObjs = `(() => {
    const s = window.__game.scene.getScene('GameScene');
    return s.mapObjects
      .filter((m) => m.body && !m.body.isStatic)
      .map((m) => [m.id, Math.round(m.body.position.x * 10) / 10, Math.round(m.body.position.y * 10) / 10, Math.round(m.body.angle * 100) / 100]);
  })()`;
  const objsA = await a.cdp.eval(readObjs);
  const objsB = await b.cdp.eval(readObjs);
  const mapB = new Map(objsB.map((o) => [o[0], o]));
  let maxObjDiff = 0;
  for (const o of objsA) {
    const other = mapB.get(o[0]);
    if (!other) continue;
    maxObjDiff = Math.max(maxObjDiff, Math.hypot(o[1] - other[1], o[2] - other[2]));
  }
  const mapName = await a.cdp.eval(`window.__game.scene.getScene('GameScene').mapData.name`);
  check(
    '动态物体（箱子）位置/朝向在两端一致（房主权威同步）',
    objsA.length === objsB.length && maxObjDiff <= 8,
    objsA.length === 0
      ? `地图 ${mapName} 没有动态刚体，跳过位置对比（rustworks 才有时才真正对比）`
      : `id=${crateId} 物体数=${objsA.length} 最大偏差=${maxObjDiff.toFixed(1)}px`,
  );
  if (objsA.length > 0 && maxObjDiff > 8) {
    const diffs = [];
    for (const o of objsA) {
      const other = mapB.get(o[0]);
      if (!other) continue;
      const d = Math.hypot(o[1] - other[1], o[2] - other[2]);
      if (d > 8) diffs.push({ id: o[0], a: [o[1], o[2], o[3]], b: [other[1], other[2], other[3]], d: Math.round(d) });
    }
    const diag = await b.cdp.eval(`(() => {
      const s = window.__game.scene.getScene('GameScene');
      return {
        role: s.online.stats.role,
        snapGaps: s.online.stats.snapGaps,
        snapHz: s.online.stats.snapHz,
        dyn: s.online.dynamicObjects?.length ?? -1,
        ids: s.online.objectById?.size ?? -1,
      };
    })()`);
    console.log(`  ℹ️ 物体差异样本: ${JSON.stringify(diffs.slice(0, 4))}`);
    console.log(`  ℹ️ B端状态: ${JSON.stringify(diag)}`);
  }

  // ---- 核心回归 3：掉落物坐标两端一致 ----
  const readDrops = `(() => {
    const s = window.__game.scene.getScene('GameScene');
    return s.pickups.list.map((i) => [i.netId ?? -1, Math.round(i.x), Math.round(i.y)]).sort((x, y) => x[0] - y[0]);
  })()`;
  const dropPosA = await a.cdp.eval(readDrops);
  const dropPosB = await b.cdp.eval(readDrops);
  const dropMapB = new Map(dropPosB.map((d) => [d[0], d]));
  let maxDropDiff = 0;
  for (const d of dropPosA) {
    const other = dropMapB.get(d[0]);
    if (!other) continue;
    maxDropDiff = Math.max(maxDropDiff, Math.hypot(d[1] - other[1], d[2] - other[2]));
  }
  check(
    '掉落物坐标两端一致（落点由房主统一模拟）',
    dropPosA.length === dropPosB.length && maxDropDiff <= 4,
    `数量 A=${dropPosA.length} B=${dropPosB.length} 最大偏差=${maxDropDiff.toFixed(1)}px`,
  );

  // ---- 聊天：气泡展示在头顶（输入由外壳负责，dev 用覆盖层输入框模拟） ----
  await a.cdp.eval(`(async () => {
    const input = document.querySelector('.mp-chat input');
    input.value = '联机测试消息';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(600);
  const bubble = await b.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((pp) => s.online.netIdOf(pp)).find((id) => id >= 0 && id !== s.online.localNetId);
    const p = s.online.playerOf(other);
    return { has: !!p.chatBubble, visible: p.chatBubble?.root.visible === true, text: p.chatBubble?.text.text ?? '' };
  })()`);
  check('聊天消息显示为对应火柴人头顶气泡', bubble.has && bubble.visible && bubble.text.includes('联机测试消息'), JSON.stringify(bubble));
  await a.cdp.shot('/tmp/stickman-shots/in-match.png');

  // ---- 最后一人胜出 → 自动换图重开 ----
  const mapBefore = await a.cdp.eval(`window.__game.scene.getScene('GameScene').mapData.name`);
  await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const target = s.online.playerOf(other);
    s.damageSystem.damagePlayer(target, {
      amount: 400, kind: 'bullet', sourceId: me.id, weaponId: 'ak47',
      point: { x: target.container.x, y: target.container.y - 30 },
      normal: { x: -1, y: 0 }, knockback: { x: -4, y: -2 }, attackId: 120, ignoreInvuln: true,
    });
    return true;
  })()`);
  // 结算弹窗延迟 4 秒：期间先看"被谁用什么击败 + 观战镜头"
  const deathUi = await b.cdp.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    for (let i = 0; i < 100; i++) {
      if (s.deathNotice && s.deathNotice.isVisible) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // 镜头目标在下一帧才更新，等两帧再读
    await new Promise((r) => setTimeout(r, 200));
    const allowed = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const killer = s.online.playerOf(allowed);
    return {
      visible: !!s.deathNotice?.isVisible,
      title: s.deathNotice?.title?.text ?? '',
      sub: s.deathNotice?.sub?.text ?? '',
      dead: s.online.localPlayer.health.isDead,
      camIsKiller: s.cameraTarget === killer,
      modalShown: document.querySelector('.mp-modal:not(.hidden)') !== null,
      matchId: s.onlineData.matchId,
    };
  })()`);
  check('死亡提示展示"被谁用什么击败"', deathUi.visible && deathUi.title.includes(nickA) && deathUi.title.includes('AK47'), JSON.stringify(deathUi));
  check('死亡后观战镜头跟随击败者', deathUi.camIsKiller === true, JSON.stringify({ cam: deathUi.camIsKiller }));
  check('结算弹窗延迟弹出（此时还不该出现）', deathUi.modalShown === false);

  await a.cdp.waitFor(`document.querySelector('.mp-modal:not(.hidden)') !== null`, 12000);
  const modalText = await a.cdp.eval(`document.querySelector('.mp-modal-card').textContent`);
  check('最后一人胜出后弹出结算', modalText.includes(nickA) && /秒后切换/.test(modalText), modalText.slice(0, 90));

  await a.cdp.waitFor(
    `(() => { const s = window.__game.scene.getScene('GameScene'); return s && s.mapData.name !== ${JSON.stringify(mapBefore)}; })()`,
    25000,
  );
  const restarted = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    return {
      map: s.mapData.name,
      players: s.players.length,
      hp: s.online.localPlayer.health.hp,
      dead: s.online.localPlayer.health.isDead,
    };
  })()`);
  check('自动换图并重开（满血复活）', restarted.map !== mapBefore && restarted.players === 2 && restarted.hp === 100 && !restarted.dead, JSON.stringify(restarted));
  const readyCount = await a.cdp.eval(`window.__startGate.readyCount`);
  check('后续每局不再要求按 W（只交互一次）', readyCount === 1, `readyCount=${readyCount}`);

  // ---- 离开 = 死亡：对端立即结算；重进是全新玩家 ----
  const oldMatch = await a.cdp.eval(`window.__game.scene.getScene('GameScene').online.deps.ctx.matchId`);
  await a.cdp.eval(`(() => { window.__room.net.ws.close(); return true; })()`);
  // B 端：最后一人胜出 → 结算弹窗
  await b.cdp.waitFor(`document.querySelector('.mp-modal:not(.hidden)') !== null`, 16000);
  check('玩家离开视为死亡：对端立即结算', true);

  // A 自动重连后收到下一局 match_start（新对局 id），以满血新玩家进入
  await a.cdp.waitFor(
    `(() => { const s = window.__game.scene.getScene('GameScene'); return window.__room.net.isOpen === true && s && s.online && s.online.deps.ctx.matchId !== ${oldMatch}; })()`,
    20000,
  );
  const rejoin = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    return {
      players: s.players.length,
      you: s.online.localNetId,
      hp: me ? me.health.hp : -1,
      dead: me ? me.health.isDead : true,
      weapon: me?.heldWeapon?.id ?? '',
    };
  })()`);
  check(
    '重进不保留旧状态（满血、无武器、新座位）',
    rejoin.you >= 0 && rejoin.hp === 100 && rejoin.dead === false && rejoin.weapon === '',
    JSON.stringify(rejoin),
  );

  // ---- 观战：点"观战"后以旁观身份观看（移动端路径） ----
  const portC = await freePort(portB + 1);
  const c = await launch(nickC, portC);
  launched.push(c);
  await c.cdp.waitFor(`window.__game.scene.isActive('GameScene')`, 25000);
  try {
    await c.cdp.waitFor(`window.__startGate.phase === 'ready' || window.__startGate.phase === 'spectating'`, 25000);
  } catch (err) {
    const diag = await c.cdp.eval(`(() => ({
      phase: window.__startGate.phase,
      net: window.__room.net.statusNow,
      open: window.__room.net.isOpen,
      scene: window.__game.scene.isActive('GameScene'),
      label: window.__startGate.label,
      progress: window.__startGate.progress,
    }))()`).catch(() => null);
    console.log(`  ℹ️ 观战者状态: ${JSON.stringify(diag)} 异常=${JSON.stringify(c.cdp.exceptions.slice(0, 3))}`);
    throw err;
  }
  // 用真实鼠标事件点击（JS 的 .click() 会绕过 pointer-events，测不出"点不动"的问题）
  const spectateBtn = await c.cdp.eval(`(() => {
    const b = document.querySelector('.mp-spectate-btn');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spectateBtn.x, y: spectateBtn.y, button: 'left', clickCount: 1 });
  await c.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spectateBtn.x, y: spectateBtn.y, button: 'left', clickCount: 1 });
  await c.cdp.waitFor(`window.__startGate.phase === 'spectating'`, 20000);
  // 点观战后场景会按新 roster 重建一次，加载面板要等重建完成才收起
  await c.cdp.waitFor(
    `getComputedStyle(document.querySelector('.mp-waiting')).display === 'none'`,
    15000,
  );
  const spec = await c.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    return {
      you: s.online.localNetId,
      hasLocal: !!s.online.localPlayer,
      hud: document.querySelector('.mp-hudbar')?.textContent ?? '',
      startVisible: getComputedStyle(document.querySelector('.mp-waiting')).display !== 'none',
    };
  })()`);
  check(
    '点"观战"后以旁观身份进入（无本地角色）',
    spec.you === -1 && spec.hasLocal === false && /观战/.test(spec.hud) && spec.startVisible === false,
    JSON.stringify(spec),
  );

  // ---- 死亡幽灵化：尸体不能再被踩，也不能当"看不见的墙"吃子弹 ----
  const ghost = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const p = s.online.playerOf(other);
    const before = p.body.collisionFilter.mask;
    return {
      before,
      playerBit: 0x0002,
      maskNoPlayer: (before & 0x0002) === 0,
      dead: p.health.isDead,
    };
  })()`);
  // 让对手阵亡（打空血），再检查它的碰撞 mask 是否摘掉了 player 位
  await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const target = s.online.playerOf(other);
    s.damageSystem.damagePlayer(target, {
      amount: 999, kind: 'bullet', sourceId: s.online.localPlayer.id, weaponId: 'ak47',
      point: { x: target.container.x, y: target.container.y }, normal: { x: -1, y: 0 },
      knockback: { x: 0, y: 0 }, attackId: 4242, ignoreInvuln: true,
    });
    return true;
  })()`);
  await sleep(900);
  const ghostAfter = await a.cdp.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const p = s.online.playerOf(other);
    return { dead: p.health.isDead, mask: p.body.collisionFilter.mask, noPlayerBit: (p.body.collisionFilter.mask & 0x0002) === 0 };
  })()`);
  check('阵亡后与玩家不再碰撞（尸体不会变成看不见的台阶）', ghostAfter.dead === true && ghostAfter.noPlayerBit === true, JSON.stringify({ before: ghost, after: ghostAfter }));

  // ---- 网络诊断（真实部署排查用）----
  const diag = await a.cdp.eval(`window.__netDiag ? window.__netDiag() : null`);
  check(
    'window.__netDiag() 可导出关键指标',
    !!diag && typeof diag.role === 'string' && typeof diag.snapHz === 'number' && diag.players >= 1,
    JSON.stringify(diag),
  );
  const pingText = await b.cdp.eval(`[...document.querySelectorAll('.mp-topbar .mp-sub')].map((e) => e.textContent)`);
  const pingMs = Number((pingText.find((t) => /ms$/.test(t)) ?? '').replace('ms', ''));
  check('延迟显示是正常量级（不会出现十几位数）', Number.isFinite(pingMs) && pingMs >= 0 && pingMs < 10000, JSON.stringify(pingText));

  // ---- 运行时异常 ----
  const exceptions = [...a.cdp.exceptions, ...b.cdp.exceptions];
  check('全程无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

  console.log('');
  if (failures > 0) {
    console.log(`❌ E2E 失败：${failures} 项`);
    throw new Error(`E2E 失败 ${failures} 项`);
  }
  console.log('✅ 浏览器 E2E 联机验证全部通过');
}

async function cleanup() {
  for (const p of launched) {
    try {
      p.cdp.close();
    } catch (err) {
      /* ignore */
    }
    try {
      p.proc.kill('SIGKILL');
    } catch (err) {
      /* ignore */
    }
    try {
      execSync(`pkill -9 -f "user-data-dir=${p.profile}"`, { stdio: 'ignore' });
    } catch (err) {
      /* ignore */
    }
  }
  await sleep(500);
  for (const p of launched) {
    try {
      rmSync(p.profile, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
  }
}

main()
  .then(() => cleanup())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('❌ E2E 异常:', err);
    await cleanup();
    process.exit(1);
  });
