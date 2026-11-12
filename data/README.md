# data/ 数据说明（人类 + AI Agent 编辑前必读）

所有游戏内容数据都在这里，**JSON 是唯一真源**：游戏、编辑器、校验脚本共用。

```
data/
├── materials.json        # 材质表（物理/破坏属性 + 子弹交互）
├── weapons.json          # 武器表（射速/伤害/弹速/弹药/耐久）
├── prefabs/*.json        # 预制件（多个形状+材质组成的可复用物体）
└── maps/*.json           # 地图
```

改完任何文件后，**先跑校验**：

```bash
npm run validate
```

## 坐标与单位约定

- 原点在**左上角**，`y` 向下，单位 px。
- `rect`：`x,y` = **左上角**，`w,h` = 宽高。
- `circle`：`x,y` = **圆心**，`radius` = 半径。
- `polygon`：`x,y` = **中心**；`vertices` 是**相对中心**的顶点；或 `sides` + `radius` 表示正多边形。
- `angle`：角度制，**正值顺时针**，一律绕图形**中心/质心**旋转。
- 预制件实例的 `x,y` = 预制件**中心**（锚点）。

## 质量尺度（重要）

玩家火柴人的物理质量约 **6.9**（density 0.002 × 36×96）。因此：

| 材质 | density | 典型物体质量 | 手感 |
|------|---------|--------------|------|
| cardboard | 0.001 | 80×80 箱 ≈ 6.4 | 轻，玩家可推动 |
| wood | 0.002 | 300×16 板 ≈ 9.6 | 略重于玩家，可压动跷跷板 |
| metal | 0.008 | r30 球 ≈ 22.6 | 重，难推但会滚 |

**新增材质时保持这个量级**：如果 density 取 1（旧值），物体质量会是玩家的几百倍，
玩家推不动、跷跷板也不会动。

## 字段速查

### materials.json

```jsonc
{
  "version": 1,
  "materials": {
    "wood": {
      "name": "木头",                 // 显示名
      "color": "#8b5a2b",             // hex 颜色（不是数字！无贴图时的填充色）
      "texture": "textures/wood.png", // 可选：public 下相对路径，或 data: 内联图
      "textureMode": "tile",          // 可选：tile(平铺) | stretch(拉伸)，默认 tile

      // ---- 物理 ----
      "fixed": false,                 // 默认是否固定位置
      "density": 0.002,               // 密度（见下面的质量尺度）
      "friction": 0.4,                // 动摩擦 0~1
      "frictionStatic": 0.8,          // 静摩擦 0~1
      "bounce": 0.1,                  // 物理反弹系数 0~1

      // ---- 破坏 ----
      "destructible": true,           // 是否可被破坏
      "durability": 60,               // 耐受度（HP，0 = 不可破坏）
      "damageMultiplier": 1,          // 受伤倍率（>1 更脆）

      // ---- 子弹交互（M3 武器系统使用）----
      "bulletBounce": false,          // 子弹击中是否反弹（金属 = true）
      "bulletPierce": false           // 子弹是否可穿透（纸箱 = true）
    }
  }
}
```

**多边形顶点约定（顶点编辑依赖）**

- `polygon` 的 `x,y` 是**旋转枢轴**；编辑器保存自定义顶点时会做一次**质心归一化**
  （顶点质心移到局部原点，`x,y` 相应平移），保证"世界顶点 = (x,y) + R(angle)·v"
- Matter 刚体**必须是凸多边形**：凹形状会被引擎内部取凸包。
  编辑器用**红色虚线**画出物理实际形状（凸包）作为提示
- 手写时优先给**凸**多边形；凹形请拆成多个凸多边形拼接

**贴图说明**

- 路径相对 `public/`：`"textures/wood.png"` → 运行时 `/textures/wood.png`
- 也可以写 `data:image/png;base64,...`（"内嵌到 JSON"，自包含但会撑大文件；>200KB 会有警告）
- **贴图只作用于矩形物体**；圆形/多边形仍用 `color` 纯色
- 贴图缺失时自动回退纯色，不会报错；`npm run validate` 会提示文件不存在
- 占位贴图可重新生成：`node tools/gen-textures.mjs`

**占位贴图**：`public/textures/{wood,metal,cardboard,ice,ground,wall}.png`（64×64，可平铺）

### maps/*.json

```jsonc
{
  "version": 1,
  "name": "arena1",              // 地图名（文件名建议一致）
  "width": 2400, "height": 1200,
  "spawnPoints": [{ "x": 150, "y": 1072 }],
  "objects": [
    { "id": "ground",            // id 可选；关节引用/定位时需要
      "type": "rect",            // rect | circle | polygon
      "x": 0, "y": 1120, "w": 2400, "h": 80,
      "material": "ground",
      "fixed": true,             // 可选：覆盖材质默认值
      "angle": 0,                // 可选：度，顺时针，绕中心
      "oneWay": false,           // 可选：单向平台
      "layer": "solid",          // 可选：solid(物理) | decor(纯视觉)
      "color": "#3d5a3d"         // 可选：颜色覆盖
    }
  ],
  "prefabs": [{ "id": "table_1", "ref": "table_wood", "x": 420, "y": 1080, "fixed": true }],
  "joints": [
    { "id": "seesaw_pivot", "type": "revolute", "bodyA": "seesaw_plank",
      "anchor": { "x": 2170, "y": 998 } }   // bodyB 省略 = 固定在世界锚点
  ],
  "weaponDropZones": [{ "x": 200, "y": 80, "w": 2000, "h": 100 }],   // 预留(M4)
  "items": [{ "type": "medkit", "x": 1200, "y": 1100 }]              // 预留(M4)
}
```

### prefabs/*.json

```jsonc
{
  "version": 1,
  "id": "table_wood",       // 必须与文件名一致（地图用 ref 引用 id）
  "name": "木桌",
  "anchor": "center",
  "bodyMode": "loose",      // loose = 每个部件独立刚体 / compound = 焊接成一个复合刚体
  "parts": [
    { "type": "rect", "x": -60, "y": -10, "w": 120, "h": 10, "material": "wood" }
  ]
}
```

## 编辑地图的方式

1. **手写 / AI 编辑**：直接改 JSON → `npm run validate` → 刷新游戏
2. **可视化编辑**：`npm run dev` 后打开 <http://localhost:5173/editor.html>

## 预制件的两种物理形态（bodyMode）

| 值 | 行为 | 适用 | 代价 |
|----|------|------|------|
| `loose` | 每个部件一个独立刚体 | 可逐块破坏；静态家具（`fixed: true`）也没问题 | 动态时整体受力可能散架/错位 |
| `compound` | 所有部件焊接成**一个复合刚体** | 桌子/箱子这类"一个整体"的物体：能被整体推动、踢飞、爆炸抛飞 | ① 物理属性只能取**面积最大部件**的材质 ② 整体掉耐久，无法逐块破坏 |

实现说明（`MapLoader.buildCompoundPrefab`）：

- 各部件先用 `Bodies.*` 建"离线刚体"，再用 `Body.create({ parts })` 合成复合体（Matter 会自动生成父体凸包）
- 视觉上是**一个 Container + 各部件为子对象**（本地坐标），每帧只把 Container 同步到刚体位置/角度
  → 不需要逐部件同步，性能与部件数量无关
- `inst.fixed` 优先级高于材质默认值；焊接体静态时同样会重新应用材质摩擦/反弹

## 画布上的直接编辑（地图 / 预制件 通用）

选中**单个**对象后，画布上出现三种手柄：

| 手柄 | 操作 | 说明 |
|------|------|------|
| 对象本体 | 拖拽 | 移动；拖动时像素级跟手，**松手才吸附**网格 |
| 右下 **绿色方块** | 拖拽 | 改大小：矩形改宽高、圆/正多边形改半径、自定义顶点多边形按包围盒等比缩放（预制件实例不支持） |
| 上方 **橙色圆点** | 拖拽 | 旋转（Shift 吸附 15°） |
| 蓝色小方块 | 拖拽 | 多边形顶点（见下节） |

按住 **Shift** 拖动 = 临时取消网格吸附，做精细调整。

## 多边形顶点编辑

选中任意多边形（地图物体或预制件部件）后，画布上会出现蓝色顶点手柄：

| 操作 | 效果 |
|------|------|
| 拖拽顶点 | 移动该顶点（网格吸附） |
| **双击边** | 在点击处插入顶点 |
| **Alt + 点击顶点** | 删除该顶点（至少保留 3 个） |
| 「转为可编辑顶点」按钮 | 把正多边形（sides+radius）固化为顶点数组 |

正多边形也可以直接拖顶点——会自动转成自定义顶点。数字精确值仍可在右侧属性面板填写。

## 在编辑器里管理材质

材质 Tab 支持：

- **新增材质**：左下「+ 新增材质」，可选择从某个现有材质复制（作为模板）
- **删除材质**：被地图物体/预制件引用时会拒绝删除，并列出引用数量
- **完整属性编辑**：外观（名称/颜色/贴图/铺图模式）、物理（固定/密度/摩擦/静摩擦/反弹）、
  破坏（可破坏/耐受度/受伤倍率）、子弹交互（反弹/穿透）
- **贴图工作流**：
  1. 点「选择贴图文件…」选本地图片 → 编辑器内立即预览（此时还没落盘）
  2. 点「下载贴图」把文件保存到 `public/textures/`（游戏里才会显示）
  3. 或者点「内嵌 base64」直接把图写进 materials.json（单文件自包含）
- **测试**：右下「▶ 用此材质测试」会在材质工作台（矩形/箱子/球/六边形）里试手感

## weapons.json（武器表）

```json
{
  "version": 1,
  "weapons": {
    "pistol": {
      "name": "手枪",
      "attackMode": "shoot",          // shoot=逻辑弹道子弹 | beam=瞬时光束 | melee=刺击 | throw=投掷
      "automatic": false,               // true = 长按连射（AK47）；false = 点一次打一发
      "fireRate": 4,                   // 发/秒
      "damage": 14,                    // 单次命中伤害
      "knockback": 4.5,                // 命中玩家的击退强度
      "ammo": 12,                      // 弹药数；-1 = 无限（近战靠耐久）
      "durability": 120,               // 耐久上限
      "durabilityPerShot": 1,          // 每次攻击消耗耐久
      "bullet": {
        "kind": "dot",                 // 外观：dot | streak | rocket | grenade | thrown
        "speed": 1600,                 // **弹速 px/秒 —— 决定"子弹飞行时间"**
        "gravity": 520,                // **重力 px/秒² —— 决定抛物线下坠**（越小越平直）
        "range": 1500,                 // 最大飞行距离
        "size": 3,
        "color": "#ffe08a",
        "trail": 16,                   // 拖尾长度 px
        "maxBounces": 3,               // 最多反弹次数（材质需 bulletBounce=true 才反弹）
        "bounceDamageMul": 0.7,        // 每次反弹后伤害倍率
        "pierceDamageMul": 0.6,        // 每次穿透后伤害倍率
        "piercePlayers": false,        // 是否穿透玩家（激光类）
        "bounceAny": false,            // true = 对任意材质都弹跳（手榴弹落地）
        "bounceRestitution": 1         // 反弹速度保留系数（0.45 = 快速衰减）
      },
      "visual": { "style": "pistol", "length": 22, "thickness": 5, "color": "#2b2b36" }
    }
  }
}
```

### 关键约定

- **`bullet.speed` 是"子弹飞行时间"的唯一来源**：子弹不是瞬时的，
  按 `speed × dt` 每帧步进，所以同一段距离下速度不同 → 到达时间不同。
  手枪 1600px/s 飞 800px ≈ 0.5s；火箭炮 700px/s ≈ 1.14s。
- **弹速再快也不会穿墙**：每帧用「上帧位置 → 本帧位置」的射线求交，
  一帧跨多远都能检测到（不是只查当前点）。
- **穿透/反弹由"材质 + 武器"两边共同决定**：
  材质回答"会不会"（`bulletBounce` / `bulletPierce`），武器回答"几次、衰减多少"。
- `visual.length` 决定枪口位置（子弹起点 = 手部 + 该长度），
  改长度不用改代码，子弹起点会自动跟着走。
- `attackMode` 当前实现状态：`shoot` / `beam` 已可用；`melee` / `throw` 待 W3/W4。
- 火箭炮的 `explosion` 字段已预留，范围伤害在 W4 接入（当前只有直击伤害）。

### 爆炸（`explosion`）

```json
"explosion": { "radius": 150, "damage": 60, "selfDamage": true, "knockback": 14 }
```

- `radius`：范围半径，边缘伤害线性衰减到 0
- `selfDamage`：**是否炸到投掷者自己**（火箭/手榴弹都是 true）
- 冲量按 `mass` 归一 → 纸箱和金属球获得相近的速度变化，不会出现"纸箱飞天/金属不动"

### 投掷（`throw`）

```json
"throw": { "speed": 640, "gravity": 1100, "range": 900, "fuseMs": 1500,
           "bounceAny": true, "bounceRestitution": 0.45 }
```

- 有 `fuseMs` → 引信弹：**撞到任何东西只弹开，不引爆**，到期才爆炸（手榴弹）
- 有 `stickMs` → 投掷物插在目标上停留 N 毫秒后消失（匕首/长矛）
- `damage` 可覆盖主伤害（投掷伤害与刺击伤害不同）
- 近战武器投掷后**脱手**（武器不再回到手上）

### 动作与输入对应

| 输入 | 行为 |
|------|------|
| 主攻击（P1 左键 / P2 空格） | 开火 / 刺击 / 投掷手榴弹；全自动武器长按连射 |
| 副攻击（P1 右键 / P2 Shift、E） | 优先"替换地上武器"；否则踢（空手/枪械）或投掷（持匕首长矛） |
| 数字键 1~5 | 切换当前操作玩家的武器（手枪/AK47/激光/火箭炮/空手） |
| 空格（P2 空格是攻击，不是跳） | P2 跳跃用 ↑ |

### 武器外形风格（`visual.style`）

`pistol` / `rifle` / `laser` / `launcher` / `dagger` / `spear` / `grenade` / `lightsaber`
—— 每种风格的轮廓画法在 `src/render/WeaponRenderer.ts`。
`lightsaber`（光刀）额外支持 `visual.glow`（辉光色），用多层"宽而淡 → 窄而亮"叠加出发光刀身。

### 近战动作（`melee.anim`）

| anim | 适用 | 判定方式 |
|------|------|----------|
| `stab`（默认） | 匕首、长矛 | 手部向前一条短射线，命中单体 |
| `slash` | 光刀 | **扇区判定**：角度差 ≤ arc + 目标半径，距离 ≤ reach，并做视线检查；一刀可扫多个目标 |

`arc` 是扇形**半角**（度）。光刀 62° = 左右各 62°。

### 弹药耗尽

弹药打空或耐久耗尽 → **武器直接消失**（不会掉在地上）。武器补给完全依赖天降武器
（`DropSystem` 维持地图上 4 件，优先使用地图的 `weaponDropZones`）。
