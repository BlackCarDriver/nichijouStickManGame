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
  /** 武器切换键（1~5）：作用于"当前操作中的玩家"，5 = 空手 */
  private readonly weaponKeys: Record<string, Phaser.Input.Keyboard.Key>;
  private prevP1Attack = false;
  private prevP1Kick = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    const kb = scene.input.keyboard!;
    this.p1 = kb.addKeys('W,A,S,D') as Record<string, Phaser.Input.Keyboard.Key>;
    this.p2 = kb.addKeys('UP,DOWN,LEFT,RIGHT,SPACE,SHIFT,E') as Record<string, Phaser.Input.Keyboard.Key>;
    this.weaponKeys = kb.addKeys('ONE,TWO,THREE,FOUR,FIVE') as Record<string, Phaser.Input.Keyboard.Key>;
  }

  readP1(): InputCommand {
    const c = emptyInput();
    c.moveX = (this.p1.D.isDown ? 1 : 0) - (this.p1.A.isDown ? 1 : 0);
    c.jump = Phaser.Input.Keyboard.JustDown(this.p1.W);
    c.jumpHeld = this.p1.W.isDown;
    c.crouch = this.p1.S.isDown;

    const pointer = this.scene.input.activePointer;
    const attack = pointer.leftButtonDown();
    c.attack = attack && !this.prevP1Attack;
    c.attackHeld = attack;
    this.prevP1Attack = attack;

    const kick = pointer.rightButtonDown();
    c.kick = kick && !this.prevP1Kick;
    this.prevP1Kick = kick;
    return c;
  }

  /**
   * 武器切换（调试/测试用）：返回武器 id，null = 空手，undefined = 本帧没按。
   * 数字键作用于"当前操作中的玩家"（与鼠标归属一致）。
   */
  readWeaponSwitch(): string | null | undefined {
    if (Phaser.Input.Keyboard.JustDown(this.weaponKeys.ONE)) return 'pistol';
    if (Phaser.Input.Keyboard.JustDown(this.weaponKeys.TWO)) return 'ak47';
    if (Phaser.Input.Keyboard.JustDown(this.weaponKeys.THREE)) return 'laser';
    if (Phaser.Input.Keyboard.JustDown(this.weaponKeys.FOUR)) return 'rocket';
    if (Phaser.Input.Keyboard.JustDown(this.weaponKeys.FIVE)) return null;
    return undefined;
  }

  readP2(): InputCommand {
    const c = emptyInput();
    c.moveX = (this.p2.RIGHT.isDown ? 1 : 0) - (this.p2.LEFT.isDown ? 1 : 0);
    c.jump = Phaser.Input.Keyboard.JustDown(this.p2.UP);
    c.jumpHeld = this.p2.UP.isDown;
    c.crouch = this.p2.DOWN.isDown;
    c.attack = Phaser.Input.Keyboard.JustDown(this.p2.SPACE);
    c.attackHeld = this.p2.SPACE.isDown;
    c.kick = Phaser.Input.Keyboard.JustDown(this.p2.SHIFT);
    c.swap = Phaser.Input.Keyboard.JustDown(this.p2.E);
    return c;
  }
}
