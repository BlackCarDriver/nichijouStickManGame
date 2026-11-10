import Phaser from 'phaser';
import type { InputCommand } from './InputCommand';
import { emptyInput } from './InputCommand';

/**
 * 双人键位绑定 → InputCommand。
 *
 * P1（红）：WASD 移动/跳，鼠标左键攻击，鼠标右键踢/替换
 * P2（蓝）：方向键移动/跳，空格攻击，Shift 踢，E 替换
 */
export class InputManager {
  private readonly scene: Phaser.Scene;
  private readonly p1: Record<string, Phaser.Input.Keyboard.Key>;
  private readonly p2: Record<string, Phaser.Input.Keyboard.Key>;
  private prevP1Attack = false;
  private prevP1Kick = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    const kb = scene.input.keyboard!;
    this.p1 = kb.addKeys('W,A,D') as Record<string, Phaser.Input.Keyboard.Key>;
    this.p2 = kb.addKeys('UP,LEFT,RIGHT,SPACE,SHIFT,E') as Record<string, Phaser.Input.Keyboard.Key>;
  }

  readP1(): InputCommand {
    const c = emptyInput();
    c.moveX = (this.p1.D.isDown ? 1 : 0) - (this.p1.A.isDown ? 1 : 0);
    c.jump = Phaser.Input.Keyboard.JustDown(this.p1.W);

    const pointer = this.scene.input.activePointer;
    const attack = pointer.leftButtonDown();
    c.attack = attack && !this.prevP1Attack;
    this.prevP1Attack = attack;

    const kick = pointer.rightButtonDown();
    c.kick = kick && !this.prevP1Kick;
    this.prevP1Kick = kick;
    return c;
  }

  readP2(): InputCommand {
    const c = emptyInput();
    c.moveX = (this.p2.RIGHT.isDown ? 1 : 0) - (this.p2.LEFT.isDown ? 1 : 0);
    c.jump = Phaser.Input.Keyboard.JustDown(this.p2.UP);
    c.attack = Phaser.Input.Keyboard.JustDown(this.p2.SPACE);
    c.kick = Phaser.Input.Keyboard.JustDown(this.p2.SHIFT);
    c.swap = Phaser.Input.Keyboard.JustDown(this.p2.E);
    return c;
  }
}
