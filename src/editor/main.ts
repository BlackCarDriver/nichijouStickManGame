import Phaser from 'phaser';
import { bindUI, createShell } from './EditorUI';
import { EditorScene } from './EditorScene';
import { editorStore } from './EditorStore';
import { GameScene } from '../scenes/GameScene';
import { WORLD_GRAVITY_Y } from '../config/physics';
import './editor.css';

createShell();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'canvas-host',
  backgroundColor: '#15151f',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER,
    width: '100%',
    height: '100%',
  },
  physics: {
    default: 'matter',
    matter: {
      // 必须与正式对局一致（见 config/physics）：重力不同，测试里的跳跃高度就不同
      gravity: { x: 0, y: WORLD_GRAVITY_Y },
      debug: false,
    },
  },
  scene: [EditorScene, GameScene],
});

(window as unknown as Record<string, unknown>).__editorGame = game;
(window as unknown as Record<string, unknown>).__editorStore = editorStore;

bindUI(game);
