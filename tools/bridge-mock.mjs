#!/usr/bin/env node
/**
 * 聊天室桥接联调测试：用"假聊天室"验证游戏服务与聊天室之间的完整链路，
 * 不需要真实聊天室、不需要浏览器。
 *
 * 覆盖：
 *   1. 桥接连接 + hello/hello_ack 握手
 *   2. jwt_challenge（RS256 验签）→ jwt_challenge_result
 *   3. 玩家进入 → state_report（waiting/playing）、room_lp、event_log
 *   4. 浏览器用真实 JWT 连接游戏 /ws（走生产验签路径，不用 --dev）
 *   5. chat_in_game 灌入游戏内聊天
 *   6. room_leave → 关闭该玩家连接（SDK 自动 ACK）
 *   7. room_closed → 客户端收到 room_closed
 *
 * 用法：node tools/bridge-mock.mjs
 * 前置：npm run build（脚本自己会用临时配置启动 Go 服务）
 */
import { spawn } from 'node:child_process';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const ROOM_ID = 20000;
const INTEGRATION_ID = 'intg_mock_stickman';
const BRIDGE_SECRET = 'mock-bridge-secret';
const MOCK_PORT = 8094;
const GAME_PORT = 8093;
const GAME_ADDR = `127.0.0.1:${GAME_PORT}`;

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function signJwt(privKey, claims) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'v1' }));
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(privKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

function makeClaims(nick, ttlSec = 600) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'nichijou-chatroom',
    aud: INTEGRATION_ID,
    sub: nick,
    room: ROOM_ID,
    jti: Math.random().toString(36).slice(2),
    registered: false,
    roleId: 0,
    avatar: '',
    frameId: 0,
    frame: '',
    iat: now,
    exp: now + ttlSec,
  };
}

async function main() {
  console.log('聊天室桥接联调测试（假聊天室）\n');

  // ---- 生成临时密钥与配置 ----
  const dir = mkdtempSync(join(tmpdir(), 'stickman-bridge-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(join(dir, 'plugin_jwt.pub.pem'), pubPem);
  writeFileSync(
    join(dir, 'integration.json'),
    JSON.stringify(
      {
        chatroom: `http://127.0.0.1:${MOCK_PORT}`,
        roomId: ROOM_ID,
        integrationId: INTEGRATION_ID,
        bridgeSecret: BRIDGE_SECRET,
        exchangeSecret: '',
        secretVersion: 1,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, 'plugin_config.json'),
    JSON.stringify(
      {
        addr: `:${GAME_PORT}`,
        instanceId: 'stickman-bridge-test',
        pubkey: join(dir, 'plugin_jwt.pub.pem'),
        staticDir: '../dist',
        dataDir: '../data',
        maxPlayers: 4,
        killTarget: 5,
        matchSeconds: 120,
        allowDevIdentity: false,
        reconnectGraceSec: 10,
        afterMatchSeconds: 2,
      },
      null,
      2,
    ),
  );

  // ---- 假聊天室 ----
  const bridgeEvents = { hello: null, states: [], roomLP: [], events: [], challengeOk: null, acks: [] };
  let bridgeSocket = null;

  const httpServer = (await import('node:http')).createServer((req, res) => {
    if (req.url === '/chat_room_server/plugin-jwt-public-key') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(pubPem);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/chat_room_server/plugin-bridge') {
      socket.destroy();
      return;
    }
    if (req.headers['x-plugin-secret'] !== BRIDGE_SECRET) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    bridgeSocket = ws;
    const url = new URL(req.url, 'http://x');
    bridgeEvents.roomIdParam = url.searchParams.get('roomId');
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello':
          bridgeEvents.hello = msg;
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              protocolVersion: 'v1',
              config: {
                roomId: ROOM_ID,
                title: '火柴人大乱斗（假聊天室）',
                userLimit: 8,
                template: 'embed',
                canvasRatio: '16:9',
                enableInGameChat: true,
                protocolVer: 'v1',
              },
            }),
          );
          // 握手成功后立刻做身份挑战
          ws.send(
            JSON.stringify({
              type: 'jwt_challenge',
              token: signJwt(privateKey, makeClaims('plugin-verify-probe', 60)),
              publicKey: pubPem,
            }),
          );
          break;
        case 'state_report':
          bridgeEvents.states.push(msg);
          break;
        case 'room_lp':
          bridgeEvents.roomLP.push(msg.text);
          break;
        case 'event_log':
          bridgeEvents.events.push(msg.text);
          break;
        case 'jwt_challenge_result':
          bridgeEvents.challengeOk = msg.ok === true;
          break;
        case 'ack':
          bridgeEvents.acks.push(msg);
          break;
        default:
          break;
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(MOCK_PORT, '127.0.0.1', resolve));

  // ---- 启动游戏服务（真实配置路径：JWT + 桥接） ----
  const server = spawn(
    '/tmp/stickman-server',
    ['--config', join(dir, 'plugin_config.json'), '--integration', join(dir, 'integration.json')],
    { cwd: process.cwd() + '/server', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout.on('data', (d) => process.stdout.write(`  [game] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`  [game!] ${d}`));

  try {
    // 等桥接连上并完成挑战
    for (let i = 0; i < 50 && !bridgeEvents.challengeOk; i++) await sleep(200);
    check('桥接握手 hello 已发送', !!bridgeEvents.hello, JSON.stringify(bridgeEvents.hello));
    check('hello 带 protocolVersion/sdk 版本', bridgeEvents.hello?.protocolVersion === 'v1' && !!bridgeEvents.hello?.sdkVersion);
    check('桥接 roomId 参数正确', bridgeEvents.roomIdParam === String(ROOM_ID));
    check('身份挑战通过（RS256 验签）', bridgeEvents.challengeOk === true);
    check('连接后已上报全量状态', bridgeEvents.states.length > 0 && bridgeEvents.states[0].full === true);
    check('已发送房间卡片副文案', bridgeEvents.roomLP.length > 0, JSON.stringify(bridgeEvents.roomLP));

    // ---- 浏览器等价：用真实 JWT 连接游戏 ----
    const nick = 'Alice';
    const token = signJwt(privateKey, makeClaims(nick));
    const gameWs = new WebSocket(`ws://${GAME_ADDR}/ws?token=${encodeURIComponent(token)}`);
    const gameMsgs = [];
    gameWs.on('message', (raw) => gameMsgs.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      gameWs.on('open', resolve);
      gameWs.on('error', reject);
    });
    const waitGame = async (type, predicate = () => true, timeout = 4000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const found = gameMsgs.find((m) => m.t === type && predicate(m));
        if (found) return found;
        await sleep(100);
      }
      throw new Error(`等待 ${type} 超时`);
    };

    const welcome = await waitGame('welcome');
    check('JWT 验签成功并建立游戏连接', welcome.nick === nick, JSON.stringify(welcome));
    await waitGame('room');

    // 按"开始"入座（新流程：未 enter 前只是旁观/加载）
    gameWs.send(JSON.stringify({ t: 'enter' }));
    const startAlice = await waitGame('match_start', (m) => m.you >= 0, 6000);
    check('按开始后以玩家身份进入对局', startAlice.you >= 0, `you=${startAlice.you}`);

    // 状态上报：playing
    let reported = null;
    for (let i = 0; i < 20; i++) {
      reported = bridgeEvents.states.at(-1)?.states?.find((s) => s.nick === nick);
      if (reported?.state === 'playing') break;
      await sleep(150);
    }
    check('入座后桥接状态为 playing', reported?.state === 'playing', JSON.stringify(reported));
    check('入座后桥接收到"加入游戏"公屏事件', bridgeEvents.events.some((t) => t.includes('加入了游戏')), JSON.stringify(bridgeEvents.events));

    // 拒绝无效 JWT
    const badToken = signJwt(privateKey, { ...makeClaims('Mallory'), aud: 'other_integration' });
    const badStatus = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${GAME_ADDR}/ws?token=${encodeURIComponent(badToken)}`);
      ws.on('open', () => {
        ws.close();
        resolve(200);
      });
      ws.on('error', () => resolve(401));
    });
    check('aud 不匹配的 JWT 被拒绝', badStatus === 401);

    // ---- 第二个玩家加入 + 被击败 → 公屏事件 ----
    const bobNick = 'Bob';
    const bobToken = signJwt(privateKey, makeClaims(bobNick));
    const bobWs = new WebSocket(`ws://${GAME_ADDR}/ws?token=${encodeURIComponent(bobToken)}`);
    const bobMsgs = [];
    bobWs.on('message', (raw) => bobMsgs.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      bobWs.on('open', resolve);
      bobWs.on('error', reject);
    });
    const waitBob = async (type, predicate = () => true, timeout = 5000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const found = bobMsgs.find((m) => m.t === type && predicate(m));
        if (found) return found;
        await sleep(100);
      }
      throw new Error(`等待 Bob 的 ${type} 超时`);
    };
    await waitBob('welcome');
    bobWs.send(JSON.stringify({ t: 'enter' }));
    const startBob = await waitBob('match_start', (m) => m.you >= 0, 6000);
    check('第二个玩家入座成功', startBob.you >= 0, `you=${startBob.you}`);
    let joinEvent = false;
    for (let i = 0; i < 20 && !joinEvent; i++) {
      joinEvent = bridgeEvents.events.some((t) => t.includes(`${bobNick} 加入了游戏`));
      await sleep(150);
    }
    check('玩家加入时向外壳发送公屏事件', joinEvent, JSON.stringify(bridgeEvents.events.slice(-5)));

    gameWs.send(
      JSON.stringify({
        t: 'dmg', target: startBob.you, amount: 400, kind: 'bullet', crit: false,
        attack: 1, ignoreInvuln: true,
      }),
    );
    const bobDead = await waitBob('hp', (m) => m.id === startBob.you && m.dead === true, 5000);
    check('目标被击败（血量归零）', bobDead.dead === true);
    let killEvent = false;
    for (let i = 0; i < 20 && !killEvent; i++) {
      killEvent = bridgeEvents.events.some((t) => t.includes(`${nick} 击败了 ${bobNick}`));
      await sleep(150);
    }
    check('击败玩家时向外壳发送公屏事件', killEvent, JSON.stringify(bridgeEvents.events.slice(-5)));
    bobWs.close();

    // ---- chat_in_game → 游戏内聊天 ----
    bridgeSocket.send(
      JSON.stringify({ type: 'chat_in_game', nick: 'Bob', text: '房间公屏消息', timestamp: Math.floor(Date.now() / 1000) }),
    );
    const chat = await waitGame('chat', (m) => m.text === '房间公屏消息');
    check('聊天室公屏灌入游戏内聊天', chat.room === true && chat.nick === 'Bob');

    // ---- room_leave → 关闭连接 + ACK ----
    bridgeSocket.send(
      JSON.stringify({ type: 'room_leave', msgId: 'm-1', nick, timestamp: Math.floor(Date.now() / 1000) }),
    );
    await sleep(600);
    check(
      '离房通知被 ACK',
      bridgeEvents.acks.some((a) => a.msgId === 'm-1' && a.ok === true),
      JSON.stringify(bridgeEvents.acks),
    );
    check('离房后游戏连接被关闭', gameWs.readyState !== WebSocket.OPEN);

    // ---- room_closed ----
    const nick2 = 'Carol';
    const token2 = signJwt(privateKey, makeClaims(nick2));
    const gameWs2 = new WebSocket(`ws://${GAME_ADDR}/ws?token=${encodeURIComponent(token2)}`);
    const msgs2 = [];
    gameWs2.on('message', (raw) => msgs2.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      gameWs2.on('open', resolve);
      gameWs2.on('error', reject);
    });
    await sleep(400);
    bridgeSocket.send(JSON.stringify({ type: 'room_closed', msgId: 'm-2', reason: 'admin' }));
    await sleep(800);
    check('关房后客户端收到 room_closed', msgs2.some((m) => m.t === 'room_closed'));
    check(
      '关房通知被 ACK',
      bridgeEvents.acks.some((a) => a.msgId === 'm-2' && a.ok === true),
    );
  } finally {
    server.kill('SIGKILL');
    bridgeSocket?.close();
    wss.close();
    httpServer.close();
    await sleep(300);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`❌ 桥接联调失败：${failures} 项`);
    process.exit(1);
  }
  console.log('✅ 聊天室桥接联调全部通过');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 桥接联调异常:', err);
  process.exit(1);
});
