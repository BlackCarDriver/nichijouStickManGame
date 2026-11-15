package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
)

// ---- 客户端同一份数据表的服务端视图 ----
//
// 服务端只读取"决定掉落与拾取"的字段，避免把整套地图/武器渲染数据搬进 Go：
//   data/weapons.json  → 武器 id + 弹匣容量
//   data/items.json    → 补给类型/数值/维持数量
//   data/maps/*.json   → 出生点、武器掉落点、补给生成点、空投配置

type weaponDef struct {
	Ammo int `json:"ammo"`
}

type weaponTable struct {
	Weapons map[string]weaponDef `json:"weapons"`
}

type itemDef struct {
	Kind         string `json:"kind"`
	Heal         int    `json:"heal"`
	Shield       int    `json:"shield"`
	Maintain     int    `json:"maintain"`
	PickupRadius int    `json:"pickupRadius"`
}

type itemTable struct {
	Items map[string]itemDef `json:"items"`
}

type spawnPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type dropZone struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type mapWeaponSpawn struct {
	ID          string   `json:"id"`
	X           float64  `json:"x"`
	Y           float64  `json:"y"`
	Mode        string   `json:"mode"`
	Weapon      string   `json:"weapon"`
	Type        string   `json:"type"`
	// Item：投放道具（medkit / armor）。填了就按"补给点"处理，不受武器池影响
	Item string `json:"item"`
	Pool        []string `json:"pool"`
	RespawnMs   int      `json:"respawnMs"`
	MaxRespawns *int     `json:"maxRespawns"`
	// FromSky 为 true 时才"从天而降"；默认直接出现在 x,y（避免被屋顶挡住）
	FromSky bool `json:"fromSky"`
}

type mapItemSpawn struct {
	Type string  `json:"type"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

type autoDropConfig struct {
	Enabled    bool `json:"enabled"`
	Count      int  `json:"count"`
	IntervalMs int  `json:"intervalMs"`
	Initial    int  `json:"initial"`
}

// prefabInstance 是地图里放的一个预制件实例（这里只用到与掉落点展开相关的字段）。
type prefabInstance struct {
	ID    string  `json:"id"`
	Ref   string  `json:"ref"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Angle float64 `json:"angle"`
	FlipX bool    `json:"flipX"`
}

// prefabFile 是预制件文件里服务端需要关心的部分：自带的武器掉落点（局部坐标）。
type prefabFile struct {
	ID      string           `json:"id"`
	Weapons []mapWeaponSpawn `json:"weapons"`
}

type mapFile struct {
	Name            string           `json:"name"`
	Width           float64          `json:"width"`
	Height          float64          `json:"height"`
	SpawnPoints     []spawnPoint     `json:"spawnPoints"`
	Prefabs         []prefabInstance `json:"prefabs"`
	WeaponDropZones []dropZone       `json:"weaponDropZones"`
	Items           []mapItemSpawn   `json:"items"`
	Weapons         []mapWeaponSpawn `json:"weapons"`
	AutoDrop        *autoDropConfig  `json:"autoDrop"`
}

// gameData 是服务端在启动时加载的静态数据。
type gameData struct {
	weapons map[string]weaponDef
	items   map[string]itemDef
	maps    map[string]*mapFile
	mapIDs  []string
	// prefabs：预制件自带的武器掉落点（按 ref 查，用于展开到地图的武器列表里）
	prefabs map[string]*prefabFile
}

func loadGameData(dataDir string) (*gameData, error) {
	gd := &gameData{
		weapons: map[string]weaponDef{},
		items:   map[string]itemDef{},
		maps:    map[string]*mapFile{},
		prefabs: map[string]*prefabFile{},
	}

	raw, err := os.ReadFile(filepath.Join(dataDir, "weapons.json"))
	if err != nil {
		return nil, fmt.Errorf("读取 weapons.json 失败: %w", err)
	}
	var wt weaponTable
	if err := json.Unmarshal(raw, &wt); err != nil {
		return nil, fmt.Errorf("解析 weapons.json 失败: %w", err)
	}
	gd.weapons = wt.Weapons

	raw, err = os.ReadFile(filepath.Join(dataDir, "items.json"))
	if err != nil {
		return nil, fmt.Errorf("读取 items.json 失败: %w", err)
	}
	var it itemTable
	if err := json.Unmarshal(raw, &it); err != nil {
		return nil, fmt.Errorf("解析 items.json 失败: %w", err)
	}
	gd.items = it.Items

	// 预制件：只需要自带的武器掉落点（客户端会把它们展开到地图的武器列表里，
	// 服务端必须用同一份展开结果，否则联机时预制件里的枪位不会刷出来）
	prefabFiles, err := filepath.Glob(filepath.Join(dataDir, "prefabs", "*.json"))
	if err != nil {
		return nil, err
	}
	for _, file := range prefabFiles {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		var pf prefabFile
		if err := json.Unmarshal(raw, &pf); err != nil {
			return nil, fmt.Errorf("解析预制件 %s 失败: %w", file, err)
		}
		if pf.ID == "" {
			continue
		}
		gd.prefabs[pf.ID] = &pf
	}

	files, err := filepath.Glob(filepath.Join(dataDir, "maps", "*.json"))
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		var mf mapFile
		if err := json.Unmarshal(raw, &mf); err != nil {
			return nil, fmt.Errorf("解析地图 %s 失败: %w", file, err)
		}
		if mf.Name == "" || len(mf.SpawnPoints) == 0 {
			continue
		}
		mf.Weapons = append(mf.Weapons, expandPrefabWeapons(gd.prefabs, mf.Prefabs)...)
		gd.maps[mf.Name] = &mf
		gd.mapIDs = append(gd.mapIDs, mf.Name)
	}
	sort.Strings(gd.mapIDs)
	if len(gd.mapIDs) == 0 {
		return nil, fmt.Errorf("data/maps 下没有可用地图")
	}
	return gd, nil
}

// expandPrefabWeapons 把地图里每个预制件实例自带的武器掉落点展开到世界坐标。
//
// 顺序必须与客户端 `collectMapWeapons()` 完全一致（先地图自带，再按 prefabs 顺序，
// 实例内按数组顺序），否则两端的 wspawn 序号/位置会对不上。
// 坐标变换与 TS 的 prefabPointToWorld 相同：局部点先按 FlipX 取反，再绕锚点旋转，最后平移。
func expandPrefabWeapons(prefabs map[string]*prefabFile, instances []prefabInstance) []mapWeaponSpawn {
	if len(instances) == 0 {
		return nil
	}
	out := make([]mapWeaponSpawn, 0, 4)
	for _, inst := range instances {
		pf := prefabs[inst.Ref]
		if pf == nil || len(pf.Weapons) == 0 {
			continue
		}
		rad := inst.Angle * math.Pi / 180
		cos := math.Cos(rad)
		sin := math.Sin(rad)
		flip := 1.0
		if inst.FlipX {
			flip = -1
		}
		instID := inst.ID
		if instID == "" {
			instID = inst.Ref
		}
		for k, w := range pf.Weapons {
			fx := w.X * flip
			world := mapWeaponSpawn{
				ID:          w.ID,
				X:           inst.X + fx*cos - w.Y*sin,
				Y:           inst.Y + fx*sin + w.Y*cos,
				Mode:        w.Mode,
				Weapon:      w.Weapon,
				Type:        w.Type,
				Pool:        w.Pool,
				RespawnMs:   w.RespawnMs,
				MaxRespawns: w.MaxRespawns,
				FromSky:     w.FromSky,
			}
			// id 一律按实例生成（与客户端一致；忽略预制件里手写的 id）
			world.ID = instID + "#w" + itoa(k)
			out = append(out, world)
		}
	}
	return out
}

// weaponIDs 返回全部武器 id（随机池过滤用，顺序稳定）。
func (g *gameData) weaponIDs() []string {
	ids := make([]string, 0, len(g.weapons))
	for id := range g.weapons {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (g *gameData) hasWeapon(id string) bool {
	_, ok := g.weapons[id]
	return ok
}
