import WebSocket from 'ws';

const listRes = await fetch('http://127.0.0.1:9334/json');
const pages = await listRes.json();
const page = pages.find((p) => p.type === 'page' && p.url.includes('editor.html'));
if (!page) throw new Error('找不到编辑器页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const exceptions = [];

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description ?? ''));
  }
});

await new Promise((r) => ws.on('open', r));

function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((r) => pending.set(mid, r));
}

async function evaluate(expr, awaitPromise = false) {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 600));
  }
  return res.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');

// 等编辑器就绪
for (let i = 0; i < 40; i++) {
  const ok = await evaluate('!!(window.__editorGame && window.__editorStore)');
  if (ok) break;
  await new Promise((r) => setTimeout(r, 500));
}

const before = await evaluate(`(() => {
  const g = window.__editorGame;
  const cam = g.scene.getScene('EditorScene').cameras.main;
  return { scaleW: g.scale.width, scaleH: g.scale.height, camW: cam.width, camH: cam.height, zoom: cam.zoom, dpr: window.devicePixelRatio };
})()`);
console.log('编辑器画布:', JSON.stringify(before));

// 点击「▶ 测试」
const clicked = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '▶ 测试');
  if (!btn) return false;
  btn.click();
  return true;
})()`);
console.log('点击测试:', clicked);

// 等 GameScene 起来
let info = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 300));
  info = await evaluate(`(() => {
    const g = window.__editorGame;
    const s = g.scene.getScene('GameScene');
    if (!s || !s.scene.isActive()) return null;
    const cam = s.cameras.main;
    return {
      camW: cam.width, camH: cam.height, zoom: cam.zoom,
      worldViewW: cam.worldView.width, worldViewH: cam.worldView.height,
      mapW: s.mapData?.width, mapH: s.mapData?.height,
      players: s.players?.length,
    };
  })()`);
  if (info) break;
}

console.log('GameScene 测试视野:', JSON.stringify(info));
console.log('期望视野宽(线上一致) =', 1280 / 1.12);

// 玩家屏幕尺寸（像素）与屏幕高度占比
const px = await evaluate(`(() => {
  const g = window.__editorGame;
  const s = g.scene.getScene('GameScene');
  const cam = s.cameras.main;
  const p = s.players[0];
  return { zoom: cam.zoom, playerWorldRadius: p.body?.circleRadius ?? null, playerScreenH: 95 * cam.zoom };
})()`);
console.log('玩家:', JSON.stringify(px));

console.log('页面异常数:', exceptions.length);
if (exceptions.length) console.log(exceptions.slice(0, 5));

ws.close();
