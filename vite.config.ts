import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * 多入口：
 * - index.html  : 游戏
 * - editor.html : 地图编辑器（开发工具，不会出现在游戏入口里）
 *
 * 部署基址：
 * - 开发态 base = '/'（vite dev server 以站点根提供 /src/main.ts）
 * - 打包态 base = './'（相对路径），由 Go 服务托管 dist/：
 *   既可挂在站点根（本地 8092），也可挂在 nginx 子路径（如 https://host/stickmanGame/）
 */
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  server: {
    port: 5173,
    // 本地开发：把游戏服务（Go，默认 :8092）代理到同源，避免跨域与手改地址
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8092', ws: true },
      '/exchange': { target: 'http://127.0.0.1:8092' },
      '/healthz': { target: 'http://127.0.0.1:8092' },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        editor: fileURLToPath(new URL('./editor.html', import.meta.url)),
      },
    },
    chunkSizeWarningLimit: 1600,
    assetsDir: 'assets',
  },
}));
