# StickManGame · 火柴人大乱斗

H5 2D 横版火柴人对战游戏。当前阶段：**单机双人沙盒**（最终目标为联网房间制）。
引擎：Phaser 3 + Matter.js + TypeScript + Vite。

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
├── render/           火柴人骨骼渲染
├── camera/           镜头跟随
├── feel/             屏幕震动等手感反馈
├── scenes/           GameScene（游戏主场景）
└── editor/           地图编辑器（EditorStore / EditorScene / EditorUI）
tools/validate-maps.ts  CLI 校验
```

## 地图编辑两条路径

1. **手写 / AI 编辑 JSON**：改 `data/maps/*.json` → `npm run validate` → 刷新游戏
2. **可视化编辑器**：`editor.html`，三个 Tab
   - **地图**：画网格、放置形状/预制件、出生点、关节、空投区
   - **预制件**：组合部件 → 导出为 `data/prefabs/*.json`
   - **材质**：调物理参数 + 实时测试 → 导出 `materials.json`

编辑器里点 **▶ 测试** 会用**真正的 GameScene** 加载当前地图（Esc 返回），
所以"编辑器里看到的效果 = 游戏效果"。

## 关键设计

- **输入抽象**：玩家实体只消费 `InputCommand`，联机时换成网络输入流即可
- **数据驱动**：武器/材质/物品/地图全在配置里，新增内容不改系统代码
- **单一真源**：编辑器、游戏、校验器共用同一份 JSON 与同一套 `buildMap()`
- **快照式 undo/redo + 自动保存**：编辑器崩溃不丢稿（localStorage）

## 里程碑

- [x] M0 项目骨架、双人移动跳跃、骨骼渲染、自适应镜头
- [x] A 数据管线（JSON + 校验器 + 预制件 + 关节）
- [x] B/C/D 地图编辑器（地图 / 预制件 / 材质 三个 Tab）
- [ ] M2 踢飞、破坏系统
- [ ] M3 武器系统
- [ ] M4 掉落与补给
- [ ] M5 打磨（音效、UI、血条）
- [ ] M6 联机（自研 WebSocket）
