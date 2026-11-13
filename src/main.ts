import Phaser from 'phaser';
import { GameScene } from './scenes/GameScene';
import { RoomController } from './net/RoomController';
import { startGate } from './net/startGate';
import { DESIGN_WIDTH, DESIGN_HEIGHT, RENDER_SCALE } from './config/display';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  // 内部渲染分辨率按屏幕像素比放大（Retina / 全屏下不糊），相机与 UI 同步缩放
  width: DESIGN_WIDTH * RENDER_SCALE,
  height: DESIGN_HEIGHT * RENDER_SCALE,
  backgroundColor: '#1a1a2e',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    // 线条/文字边缘更平滑；图形都是矢量绘制，抗锯齿收益明显
    antialias: true,
    roundPixels: false,
  },
  physics: {
    default: 'matter',
    matter: {
      // 重力强度 1.6：下落加速更明显，跳跃更有抛物线感
      gravity: { x: 0, y: 1.6 },
      debug: false,
    },
  },
  // 不自动启动任何场景：大厅由 DOM 覆盖层显示，开局后才由 RoomController 启动 GameScene
  scene: [],
};

const game = new Phaser.Game(config);
game.scene.add('GameScene', GameScene, false);

// 房间控制器：聊天室外壳凭证 → 游戏服务连接 → 大厅/对局场景切换
const room = new RoomController(game, document.body);
room.boot();

// 调试钩子：浏览器控制台可直接访问游戏实例与房间状态（window.__game / window.__room）
const globals = window as unknown as Record<string, unknown>;
globals.__game = game;
globals.__room = room;
globals.__startGate = startGate;
