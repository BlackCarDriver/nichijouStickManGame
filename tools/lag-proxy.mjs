#!/usr/bin/env node
/**
 * 本地联调用的 TCP 延迟代理（模拟真实网络时延）。
 *
 * 用法：node tools/lag-proxy.mjs <listenPort> <targetPort> <delayMs>
 *   例：node tools/lag-proxy.mjs 8098 8096 150
 *   然后浏览器访问 http://127.0.0.1:8098/?dev=1&nick=x
 *
 * 为什么要它：Chrome DevTools 的 Network.emulateNetworkConditions 对 WebSocket
 * 的时延模拟并不可靠（实测 RTT 仍是 20ms 级），复现不了真实公网表现。
 */
import net from 'node:net';
const [, , listenPort = '8098', targetPort = '8096', delayArg = '150'] = process.argv;
const delay = Number(delayArg);
const queue = [];
const server = net.createServer((client) => {
  const upstream = net.connect(Number(targetPort), '127.0.0.1');
  client.setNoDelay(true); upstream.setNoDelay(true);
  const send = (sock, buf) => {
    const at = Date.now() + delay;
    queue.push({ at, sock, buf });
  };
  client.on('data', (b) => send(upstream, Buffer.from(b)));
  upstream.on('data', (b) => send(client, Buffer.from(b)));
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});
setInterval(() => {
  const now = Date.now();
  while (queue.length && queue[0].at <= now) {
    const { sock, buf } = queue.shift();
    if (!sock.destroyed) sock.write(buf);
  }
  queue.sort((a, b) => a.at - b.at);
}, 2);
server.listen(Number(listenPort), () => console.log(`lag proxy :${listenPort} -> :${targetPort} +${delay}ms`));
