import Phaser from 'phaser';
import { bindUI, createShell } from './EditorUI';
import { EditorScene } from './EditorScene';
import { editorStore } from './EditorStore';
import { GameScene } from '../scenes/GameScene';
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
      gravity: { x: 0, y: 1 },
      debug: false,
    },
  },
  scene: [EditorScene, GameScene],
});

(window as unknown as Record<string, unknown>).__editorGame = game;
(window as unknown as Record<string, unknown>).__editorStore = editorStore;

bindUI(game);
