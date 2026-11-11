import Phaser from 'phaser';
import { GameScene } from './scenes/GameScene';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: 1280,
  height: 720,
  backgroundColor: '#1a1a2e',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'matter',
    matter: {
      // 重力强度 1.6：下落加速更明显，跳跃更有抛物线感
      gravity: { x: 0, y: 1.6 },
      debug: false,
    },
  },
  scene: [GameScene],
};

const game = new Phaser.Game(config);

// 调试钩子：浏览器控制台可直接访问游戏实例（window.__game）
(window as unknown as Record<string, unknown>).__game = game;
