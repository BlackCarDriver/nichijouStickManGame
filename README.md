# StickManGame · 火柴人大乱斗

H5 2D 横版火柴人对战游戏。当前阶段：**聊天室插件房联机（多人乱斗）已跑通**，
同时保留单机双人沙盒用于调试与手感回归。
引擎：Phaser 3 + Matter.js + TypeScript + Vite；联机服务：Go（引用插件房接入包 `github.com/BlackCarDriver/nichijouSDK`）。

## 快速开始

```bash
npm install
npm run dev        # 启动开发服务器
```

- 游戏：<http://localhost:5173/>
- 地图编辑器：<http://localhost:5173/editor.html>

```bash
npm run validate   # 校验 data/ 下的材质 / 预制件 / 地图（AI 改完后必跑）
npm run build      # 校验 + 类型检查 + 打包
```

### 联机（多人乱斗）

```bash
npm run build
cd server && go run . --dev        # 开发模式：允许 ?dev=1&nick=xxx 假身份
# 多个浏览器标签页打开（可选 &avatar=<url> 模拟聊天室头像）：
#   http://127.0.0.1:8092/?dev=1&nick=A
#   http://127.0.0.1:8092/?dev=1&nick=B
```

正式接入聊天室插件房（建房、配置、公钥、桥接、联调检查表）见
**[docs/联机协议.md](./docs/联机协议.md)**。要点：

- 身份来自聊天室外壳下发的 JWT，服务端验签（`aud` / `room`），昵称 = `sub`
- **进房即开局**：随机地图，边打边等人；新玩家随时加入（对手实时出现）
- **加载进度 + 开局闸门**：首次进入加载完成后点「W」才开始操作（之后每局不再交互）；移动端可点「观战」
- 跳弹：子弹反弹后速度/伤害衰减，并且反弹一次后可以打回自己
- **最后一人胜出**：发生过死亡且只剩一名存活玩家 → 结算 → 自动换图重开、全员满血
- **离开 = 死亡**：关页面/离房立即移出并计入死亡；重进是全新玩家（满血、0 杀、新座位）
- 护盾：普通角色上限 100（防弹衣每件 +50），光刀战士上限 500
- 同步模型：输入中继（60Hz→30Hz）+ 双端全量模拟 + 服务端仲裁血量/拾取/掉落/摧毁
- 公屏事件：玩家加入 / 被击败 / 开局 / 结算都会通过桥接推送到聊天室
- 表现：聊天室圆形头像 + 头顶昵称、聊天气泡、画面外对手同色边缘箭头、紧凑 HUD
- 一个插件房 = 一份 `server/config/integration.json` = 一个服务实例

自动化验证：

```bash
# 需先起开发服务（--dev）：
#   cd server && go run . --config config/plugin_config.dev.json --integration config/integration.dev.json --dev
node tools/net-smoke.mjs ws://127.0.0.1:8092/ws   # 协议冒烟（对局/输入/伤害/拾取/换图）
NET_E2E_BASE=http://127.0.0.1:8092/ node tools/net-e2e.mjs   # 两个无头 Chrome 跑完整对局
```

## 操作（游戏）

| 玩家 | 移动 / 跳跃 | 攻击 | 踢 / 替换 |
|------|-------------|------|-----------|
| P1（红） | `A` `D` / `W` | 鼠标左键 | 鼠标右键 |
| P2（蓝） | `←` `→` / `↑` | `空格` | `Shift` / `E` |

## 目录结构

```
data/                 内容数据（JSON 唯一真源）
├── materials.json      材质表
├── prefabs/*.json      预制件（多形状组合）
├── maps/*.json         地图
└── README.md           字段说明 / 坐标约定 / 质量尺度
src/
├── config/           材质加载与热替换
├── core/             实体基类、输入抽象、碰撞分类
├── map/              MapFormat / MapLoader / PrefabExpand / MapValidator / MapRegistry
├── entities/         Player（火柴人）
├── net/              联机层（外壳通信/WebSocket/大厅/对局同步）
├── ui/               HUD 与联机覆盖层（大厅/聊天/结算）
├── render/           火柴人骨骼渲染
├── camera/           镜头跟随
├── feel/             屏幕震动等手感反馈
├── scenes/           GameScene（游戏主场景）
└── editor/           地图编辑器（EditorStore / EditorScene / EditorUI）
tools/validate-maps.ts  CLI 校验
tools/net-smoke.mjs    联机协议冒烟测试
tools/net-e2e.mjs      浏览器端到端联机验证
server/                联机服务（Go）：静态托管 + JWT 验签 + 房间/仲裁 + 聊天室桥接
docs/联机协议.md        联机架构、报文、仲裁规则与插件房接入步骤
```

## 地图编辑两条路径

1. **手写 / AI 编辑 JSON**：改 `data/maps/*.json` → `npm run validate` → 刷新游戏
2. **可视化编辑器**：`editor.html`，三个 Tab
   - **地图**：画网格、放置形状/预制件、**拖拽移动/改大小/旋转**、顶点编辑、出生点、关节、空投区
   - **预制件**：组合部件 → 导出为 `data/prefabs/*.json`
   - **材质**：调物理参数 + 实时测试 → 导出 `materials.json`

编辑器里点 **▶ 测试** 会用**真正的 GameScene** 加载当前地图（Esc 返回），
所以"编辑器里看到的效果 = 游戏效果"。

## 关键设计

- **输入抽象**：玩家实体只消费 `InputCommand`，联机时远端玩家由网络输入流驱动（本地玩家手感不变）
- **联机仲裁**：血量/拾取/掉落/击杀由服务端权威，位置由玩家自己权威 + 100ms 纠偏
- **数据驱动**：武器/材质/物品/地图全在配置里，新增内容不改系统代码
- **单一真源**：编辑器、游戏、校验器共用同一份 JSON 与同一套 `buildMap()`
- **快照式 undo/redo + 自动保存**：编辑器崩溃不丢稿（localStorage）

