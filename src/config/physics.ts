/**
 * 物理世界参数（**唯一来源**）。
 *
 * 踩过的坑：编辑器（`src/editor/main.ts`）自己抄了一份 Matter 配置，重力写成 `1`，
 * 而正式对局（`src/main.ts`）是 `1.6`。结果「地图管理 → ▶ 测试」里跳跃能跳 ~363px，
 * 联机局里只有 ~251px —— 拿编辑器测试去核对平台间距会直接误判（"能跳上去"的平台
 * 到线上就跳不上去）。所以重力、跳跃换算相关的常量一律从这里取。
 */

/** Matter 世界重力 y（正式对局与编辑器测试必须完全一致） */
export const WORLD_GRAVITY_Y = 1.6;

/**
 * 重力设置 → "每步² 的有效加速度"（标定值）。
 *
 * Matter 的 velocity 单位是 px / 物理步，不是 px/s；顶点高度与滞空时间要用
 * `h = v² / (2a)`、`t = 2v / a` 来算，其中 a 是**有效**加速度：
 * 实测 `WORLD_GRAVITY_Y = 1.6`、初速 `-17` 时顶点 ≈ 251px、同高度横移 ≈ 295px，
 * 反解得 a ≈ 0.576 px/步²。
 *
 * 注意它不是 `gravity × 0.001 × deltaTime²`（≈0.278）——Matter 内部按固定 delta
 * 做 Verlet 积分，还受 frictionAir 影响。**改重力或换引擎版本后要重新标定**，
 * 否则编辑器里的"跳跃能力尺子"会算错。
 */
export const JUMP_EFFECTIVE_GRAVITY = 0.576;
