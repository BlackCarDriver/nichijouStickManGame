# data/ 数据说明（人类 + AI Agent 编辑前必读）

所有游戏内容数据都在这里，**JSON 是唯一真源**：游戏、编辑器、校验脚本共用。

```
data/
├── materials.json        # 材质表（物理/破坏属性）
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
      "name": "木头",          // 显示名
      "durability": 60,        // 耐受度（0 = 不可破坏）
      "destructible": true,    // 是否可被破坏
      "fixed": false,          // 默认是否固定位置
      "bounce": 0.1,           // 反弹系数 0~1
      "density": 0.002,        // 密度（见上面的质量尺度）
      "friction": 0.4,         // 动摩擦 0~1
      "frictionStatic": 0.8,   // 静摩擦 0~1
      "color": "#8b5a2b"       // hex 颜色（不是数字！）
    }
  }
}
```

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
  "bodyMode": "loose",      // loose = 每个部件独立刚体
  "parts": [
    { "type": "rect", "x": -60, "y": -10, "w": 120, "h": 10, "material": "wood" }
  ]
}
```

## 编辑地图的方式

1. **手写 / AI 编辑**：直接改 JSON → `npm run validate` → 刷新游戏
2. **可视化编辑**：`npm run dev` 后打开 <http://localhost:5173/editor.html>
