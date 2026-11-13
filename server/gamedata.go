package main

import (
	"encoding/json"
	"fmt"
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
	Pool        []string `json:"pool"`
	RespawnMs   int      `json:"respawnMs"`
	MaxRespawns *int     `json:"maxRespawns"`
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

type mapFile struct {
	Name            string           `json:"name"`
	Width           float64          `json:"width"`
	Height          float64          `json:"height"`
	SpawnPoints     []spawnPoint     `json:"spawnPoints"`
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
}

func loadGameData(dataDir string) (*gameData, error) {
	gd := &gameData{
		weapons: map[string]weaponDef{},
		items:   map[string]itemDef{},
		maps:    map[string]*mapFile{},
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
		gd.maps[mf.Name] = &mf
		gd.mapIDs = append(gd.mapIDs, mf.Name)
	}
	sort.Strings(gd.mapIDs)
	if len(gd.mapIDs) == 0 {
		return nil, fmt.Errorf("data/maps 下没有可用地图")
	}
	return gd, nil
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
