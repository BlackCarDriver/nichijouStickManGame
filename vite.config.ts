import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * 多入口：
 * - index.html  : 游戏
 * - editor.html : 地图编辑器（开发工具，不会出现在游戏入口里）
 */
export default defineConfig({
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
    // 由 Go 服务托管 dist/：用绝对路径即可（部署在站点根目录）
    assetsDir: 'assets',
  },
});
