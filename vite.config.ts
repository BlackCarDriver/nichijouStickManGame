import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * 多入口：
 * - index.html  : 游戏
 * - editor.html : 地图编辑器（开发工具，不会出现在游戏入口里）
 */
export default defineConfig({
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        editor: fileURLToPath(new URL('./editor.html', import.meta.url)),
      },
    },
    chunkSizeWarningLimit: 1600,
  },
});
