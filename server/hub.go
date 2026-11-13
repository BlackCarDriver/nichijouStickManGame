package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"stickmangame/server/internal/nichijou"
)

const (
	maxHP     = 100
	maxShield = 500

	// 输入快照广播频率（客户端以 60Hz 上报，服务端合并到 30Hz 广播）
	inputTick = 33 * time.Millisecond
	// 补帧/掉落/重生等逻辑的节拍
	simTick = 33 * time.Millisecond
	// 重生等待（与 Player.PLAYER_CONFIG.respawnDelayMs 一致）
	respawnDelay = 2800 * time.Millisecond
	// 单次伤害上限与每秒伤害预算（宽松的防刷保护，不做严格反作弊）
	maxDamagePerHit = 400.0
	maxDamagePerSec = 900.0
	// 聊天限频
	chatWindow = 2 * time.Second
	chatBurst  = 4
	chatMaxLen = 160

	// 武器掉落点从多高处落下（与客户端 WeaponSpawnerSystem 一致）
	dropHeight = 240
	// 补给维持检查间隔（与 ItemDropSystem 一致）
	itemTopUpInterval = 2600 * time.Millisecond
)

// client 是一条浏览器连接。
type client struct {
	conn *websocket.Conn
	send chan []byte

	nick       string
	avatar     string
	frame      string
	roleID     int
	frameID    int
	registered bool

	// 房间座位序号；-1 = 旁观
	seat int
	// 主动选择观战（移动端）：后续开局不再分配座位
	spectate bool
	// 是否已按过"开始"（enter）：未开始前只旁观/加载，不占座位
	joined bool

	// 最近一次输入
	input        inputMsg
	pendingEdges uint8
	lastX        float64
	lastY        float64
	hasPos       bool

	chatTimes []time.Time
	joinedAt  time.Time
}

func (c *client) push(payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
		// 客户端消费不过来：丢弃这一帧，避免阻塞整个房间
	}
}

// playerState 是服务端权威的玩家数值（血量/护盾/击杀/重生）。
type playerState struct {
	Seat      int
	Nick      string
	Avatar    string
	Color     int
	Spawn     int
	HP        int
	Shield    int
	Dead      bool
	Kills     int
	Deaths    int
	RespawnAt time.Time

	lastDamagedAt time.Time
	lastAttackID  int64
	budget        float64
	budgetAt      time.Time
}

type dropState struct {
	dropItem
	point int // 武器掉落点下标；-1 = 空投/替换/固定补给
}

type weaponPoint struct {
	cfg          mapWeaponSpawn
	index        int
	tag          string
	waiting      bool
	respawnCount int
	timer        time.Duration
}

// match 是一局对战的完整状态。
type match struct {
	ID        int64
	MapName   string
	Map       *mapFile
	StartedAt time.Time
	Over      bool

	// 本局死亡次数（至少一次死亡才会触发"最后一人胜出"结束条件）
	Deaths int
	// 结束后到下一局开始的时间点
	NextRoundAt time.Time
	// 下一局地图（结束后提前选好并展示）
	NextMap string

	Seats    []string // 下标 = netID（座位号）
	Players  map[int]*playerState
	Drops    map[int64]*dropState
	nextDrop int64
	points   []*weaponPoint

	destroyed map[string]bool

	itemTimer     time.Duration
	autoDropTimer time.Duration
	spawnCursor   int
}

// Hub 管理房间、座位、对局与所有实时同步。
type Hub struct {
	mu   sync.Mutex
	cfg  RuntimeConfig
	data *gameData

	bridge *nichijou.Bridge

	clients map[string]*client
	order   []string // 入场顺序（决定座位分配优先级）

	roomID int

	// 桥接上报用的状态快照。
	// 关键：SDK 的 ScheduleFullReport 可能同步回调 States()，而调用点大多持有 h.mu，
	// 直接在里面加锁会自锁死。所以这里用原子快照：写侧持锁刷新，读侧无锁。
	statesSnap atomic.Value // map[string]nichijou.State
	m          *match
	matchSeq   int64
	// 上一局（或最后一位玩家离开前）用过的地图：重置后开新局时避开它
	lastMap string
	closed  bool
}

func NewHub(cfg RuntimeConfig, data *gameData) *Hub {
	h := &Hub{
		cfg:     cfg,
		data:    data,
		clients: map[string]*client{},
	}
	h.statesSnap.Store(map[string]nichijou.State{})
	return h
}

func (h *Hub) SetBridge(b *nichijou.Bridge, roomID int) {
	h.bridge = b
	h.roomID = roomID
}

// ---------- 座位 / 轮次 ----------

func seatOfMatch(m *match, nick string) int {
	if m == nil {
		return -1
	}
	for i, n := range m.Seats {
		if n == nick {
			return i
		}
	}
	return -1
}

// pickMapLocked 随机挑一张地图，尽量和当前这局不同。
func (h *Hub) pickMapLocked() string {
	pool := make([]string, 0, len(h.data.mapIDs))
	cur := h.lastMap
	if h.m != nil {
		cur = h.m.MapName
	}
	for _, id := range h.data.mapIDs {
		if id == cur && len(h.data.mapIDs) > 1 {
			continue
		}
		pool = append(pool, id)
	}
	if len(pool) == 0 {
		pool = h.data.mapIDs
	}
	if len(pool) == 0 {
		return ""
	}
	return pool[rand.Intn(len(pool))]
}

// addSeatLocked 把一个在线玩家加入当前对局。
// 座位号优先复用空位（离开的人留下的 ""），避免座位号越滚越大。
func (h *Hub) addSeatLocked(m *match, c *client) int {
	seat := -1
	for i, nick := range m.Seats {
		if nick == "" {
			seat = i
			break
		}
	}
	if seat < 0 {
		seat = len(m.Seats)
		m.Seats = append(m.Seats, c.nick)
	} else {
		m.Seats[seat] = c.nick
	}
	p := &playerState{
		Seat: seat, Nick: c.nick, Avatar: c.avatar, Color: seat % 8,
		Spawn: seat % len(m.Map.SpawnPoints),
		HP:    maxHP, budget: 1000, budgetAt: time.Now(),
	}
	m.Players[seat] = p
	c.seat = seat
	c.joined = true

	join := &playerJoinMsg{
		T: "player_join",
		Player: matchPlayer{
			Nick: p.Nick, Avatar: p.Avatar, NetID: seat, Color: p.Color, Spawn: p.Spawn, Kills: p.Kills,
		},
		Stat: playerStatWire{ID: seat, HP: p.HP, Shield: p.Shield, Dead: p.Dead, Kills: p.Kills},
	}
	for _, other := range h.clients {
		if other != c {
			other.push(join)
		}
	}
	h.sendToLocked(c, h.matchStartLocked(c))
	if h.bridge != nil {
		// 只对"真正的玩家入座"发公屏，避免每次重连刷屏
		h.bridge.EventLog(c.nick + " 加入了游戏")
	}
	return seat
}

// startRoundLocked 开一局新对局（按入场顺序分配座位，多余的人旁观）。
func (h *Hub) startRoundLocked() {
	mapName := ""
	if h.m != nil && h.m.NextMap != "" {
		mapName = h.m.NextMap
	}
	if _, ok := h.data.maps[mapName]; !ok {
		mapName = h.pickMapLocked()
	}
	mf := h.data.maps[mapName]
	if mf == nil {
		return
	}

	h.matchSeq++
	m := &match{
		ID:        h.matchSeq,
		MapName:   mapName,
		Map:       mf,
		StartedAt: time.Now(),
		Seats:     []string{},
		Players:   map[int]*playerState{},
		Drops:     map[int64]*dropState{},
		destroyed: map[string]bool{},
	}
	h.m = m

	for _, nick := range h.order {
		if len(m.Seats) >= h.cfg.MaxPlayers {
			break
		}
		c := h.clients[nick]
		if c == nil || c.spectate || !c.joined {
			continue
		}
		seat := len(m.Seats)
		m.Seats = append(m.Seats, nick)
		m.Players[seat] = &playerState{
			Seat: seat, Nick: nick, Avatar: c.avatar, Color: seat % 8,
			Spawn: seat % len(mf.SpawnPoints),
			HP:    maxHP, budget: 1000, budgetAt: time.Now(),
		}
		c.seat = seat
	}
	for _, c := range h.clients {
		if c.seat >= len(m.Seats) {
			c.seat = -1 // 旁观
		}
	}

	h.initDropsLocked(m)
	log.Printf("[hub] 第 %d 局开始：地图=%s 玩家=%d 掉落=%d", m.ID, m.MapName, len(m.Players), len(m.Drops))
	for _, c := range h.clients {
		h.sendToLocked(c, h.matchStartLocked(c))
	}
	h.reportStatesLocked()
	h.syncRoomLPLocked()
	if h.bridge != nil {
		h.bridge.EventLog("对局开始：" + mapName)
	}
}

// matchStartLocked 生成给某个客户端（c=nil 表示旁观视角）的对局快照。
func (h *Hub) matchStartLocked(c *client) *matchStartMsg {
	m := h.m
	players := make([]matchPlayer, 0, len(m.Players))
	for seat, p := range m.Players {
		if p == nil {
			continue
		}
		players = append(players, matchPlayer{
			Nick: p.Nick, Avatar: p.Avatar, NetID: seat, Color: p.Color, Spawn: p.Spawn, Kills: p.Kills,
		})
	}
	sort.Slice(players, func(i, j int) bool { return players[i].NetID < players[j].NetID })
	drops := make([]dropItem, 0, len(m.Drops))
	for _, d := range m.Drops {
		drops = append(drops, d.dropItem)
	}
	sort.Slice(drops, func(i, j int) bool { return drops[i].ID < drops[j].ID })
	destroyed := make([]string, 0, len(m.destroyed))
	for id := range m.destroyed {
		destroyed = append(destroyed, id)
	}
	sort.Strings(destroyed)
	stats := make([]playerStatWire, 0, len(m.Players))
	for seat, p := range m.Players {
		if p == nil {
			continue
		}
		stats = append(stats, playerStatWire{
			ID: seat, HP: p.HP, Shield: p.Shield, Dead: p.Dead, Kills: p.Kills,
		})
	}
	sort.Slice(stats, func(i, j int) bool { return stats[i].ID < stats[j].ID })
	you := -1
	if c != nil {
		you = c.seat
	}
	return &matchStartMsg{
		T: "match_start", MatchID: m.ID, Map: m.MapName, Players: players, Stats: stats,
		You: you, Drops: drops, Destroyed: destroyed,
	}
}

func (h *Hub) dropMatchPlayerLocked(m *match, seat int) {
	h.dropMatchPlayerExLocked(m, seat, true)
}

// dropMatchPlayerExLocked 移出对局；countDeath=false 用于"主动观战"（不算死亡，不触发结算）。
func (h *Hub) dropMatchPlayerExLocked(m *match, seat int, countDeath bool) {
	nick := ""
	if seat >= 0 && seat < len(m.Seats) {
		nick = m.Seats[seat]
	}
	if p := m.Players[seat]; p != nil && !p.Dead && countDeath {
		// "离开游戏" 视为一次死亡：参与本局结束判定（至少一次死亡 + 只剩一人）
		m.Deaths++
	}
	delete(m.Players, seat)
	if seat >= 0 && seat < len(m.Seats) {
		m.Seats[seat] = "" // 释放座位：重新进入按新座位加入
	}
	h.broadcastLocked(&playerLeftMsg{T: "player_left", ID: seat, Nick: nick})
	h.checkRoundEndLocked()
}

// checkRoundEndLocked 结束条件：至少发生过一次死亡，且只剩一名存活玩家。
func (h *Hub) checkRoundEndLocked() {
	m := h.m
	if m == nil || m.Over {
		return
	}
	alive := 0
	for seat, p := range m.Players {
		if p == nil || p.Dead {
			continue
		}
		nick := m.Seats[seat]
		if nick == "" {
			continue
		}
		if h.clients[nick] != nil {
			alive++
		}
	}
	if alive <= 1 && m.Deaths >= 1 {
		h.endRoundLocked()
	}
}

func (h *Hub) endRoundLocked() {
	m := h.m
	if m == nil || m.Over {
		return
	}
	m.Over = true

	results := make([]matchResult, 0, len(m.Players))
	lastAlive := ""
	for seat, p := range m.Players {
		if p == nil {
			continue
		}
		results = append(results, matchResult{Nick: p.Nick, NetID: seat, Kills: p.Kills})
		if !p.Dead && m.Seats[seat] != "" {
			lastAlive = p.Nick
		}
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].Kills != results[j].Kills {
			return results[i].Kills > results[j].Kills
		}
		return results[i].NetID < results[j].NetID
	})
	winner := lastAlive
	if winner == "" && len(results) > 0 {
		winner = results[0].Nick
	}

	nextMap := h.pickMapLocked()
	m.NextMap = nextMap
	restartMs := h.cfg.RoundEndSeconds * 1000
	m.NextRoundAt = time.Now().Add(time.Duration(h.cfg.RoundEndSeconds) * time.Second)

	log.Printf("[hub] 第 %d 局结束：胜者=%s 死亡=%d 下一张=%s", m.ID, winner, m.Deaths, nextMap)
	h.broadcastLocked(&matchEndMsg{
		T: "match_end", Results: results, Winner: winner, Reason: "lastman",
		RestartInMs: restartMs, NextMap: nextMap,
	})
	if h.bridge != nil {
		if winner != "" {
			h.bridge.EventLog("对局结束，" + winner + " 获胜")
		} else {
			h.bridge.EventLog("对局结束")
		}
	}
	h.reportStatesLocked()
	h.syncRoomLPLocked()
}

// handleEnter 玩家按下"开始"后才真正入座（未开始前不会出现在对局里，也就不会被别人打）。
func (h *Hub) handleEnter(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.spectate {
		return
	}
	c.joined = true

	m := h.m
	if m == nil {
		h.startRoundLocked()
	} else if m.Over {
		h.sendToLocked(c, &waitingMsg{T: "waiting", Text: "上一局刚结束，下一局即将开始…"})
	} else if seat := seatOfMatch(m, c.nick); seat >= 0 {
		c.seat = seat
		h.sendToLocked(c, h.matchStartLocked(c))
	} else if len(m.Seats) < h.cfg.MaxPlayers {
		h.addSeatLocked(m, c)
	} else {
		// 满员：保持旁观
		h.sendToLocked(c, h.matchStartLocked(c))
	}
	h.broadcastRoomLocked()
	h.reportStatesLocked()
	h.syncRoomLPLocked()
}

// setSpectator 主动转为旁观：让出座位（不计死亡），后续开局也不再分配座位。
func (h *Hub) setSpectator(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.spectate {
		return
	}
	c.spectate = true
	c.joined = false
	if m := h.m; m != nil && !m.Over {
		if seat := seatOfMatch(m, c.nick); seat >= 0 {
			h.dropMatchPlayerExLocked(m, seat, false)
		}
	}
	c.seat = -1
	if h.m != nil {
		h.sendToLocked(c, h.matchStartLocked(c))
	}
	h.broadcastRoomLocked()
	h.reportStatesLocked()
	h.syncRoomLPLocked()
}

// ---------- 连接生命周期 ----------

func (h *Hub) addClient(c *client) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		c.conn.Close()
		return
	}

	// 同名顶号
	if old, ok := h.clients[c.nick]; ok {
		log.Printf("[hub] %s 已有连接，旧连接被顶替", c.nick)
		delete(h.clients, c.nick)
		close(old.send)
		_ = old.conn.Close()
	}

	h.clients[c.nick] = c
	found := false
	for _, n := range h.order {
		if n == c.nick {
			found = true
			break
		}
	}
	if !found {
		h.order = append(h.order, c.nick)
	}
	c.seat = -1
	c.joinedAt = time.Now()

	h.sendToLocked(c, &welcomeMsg{
		T: "welcome", Nick: c.nick, Avatar: c.avatar, Frame: c.frame,
		RoleID: c.roleID, FrameID: c.frameID, Registered: c.registered,
		NetID: -1, RoomID: h.roomID, Title: "火柴人大乱斗",
		MaxPlayers: h.cfg.MaxPlayers, Maps: h.data.mapIDs,
		Map: h.currentMap(), KillTarget: 0,
	})

	m := h.m
	// 同名重连 / 刷新页面：旧身份按"离开=死亡"处理
	if m != nil && !m.Over {
		if seat := seatOfMatch(m, c.nick); seat >= 0 {
			h.dropMatchPlayerLocked(m, seat)
		}
	}
	switch {
	case m != nil && !m.Over:
		// 还没按"开始"：只给旁观视角（客户端需要地图/掉落信息来加载场景）
		h.sendToLocked(c, h.matchStartLocked(c))
	case m != nil && m.Over:
		h.sendToLocked(c, &waitingMsg{T: "waiting", Text: "上一局刚结束，下一局即将开始…"})
	default:
		// 没有对局：先建一局（0 座位）给客户端加载，按"开始"后再入座
		h.startRoundLocked()
	}

	h.broadcastRoomLocked()
	h.reportStatesLocked()
	h.syncRoomLPLocked()
	h.mu.Unlock()
}

func (h *Hub) removeClient(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	cur, ok := h.clients[c.nick]
	if !ok || cur != c {
		return // 已被新连接顶替
	}
	delete(h.clients, c.nick)

	nick := c.nick
	for i, n := range h.order {
		if n == nick {
			h.order = append(h.order[:i], h.order[i+1:]...)
			break
		}
	}

	m := h.m
	if m != nil && !m.Over {
		if seat := seatOfMatch(m, nick); seat >= 0 {
			// 玩家离开 = 本局死亡：立刻移出并计入死亡数（只剩一人时本局结束）
			h.dropMatchPlayerLocked(m, seat)
		}
	}
	c.seat = -1

	// 房间空了：立刻重置对局。否则下一个玩家会继承上一局的地图/掉落/已摧毁物体。
	if len(h.clients) == 0 {
		if m != nil {
			h.lastMap = m.MapName
		}
		h.m = nil
		h.order = nil
		h.broadcastRoomLocked()
		h.reportStatesLocked()
		h.syncRoomLPLocked()
		return
	}

	h.broadcastRoomLocked()
	h.reportStatesLocked()
	h.syncRoomLPLocked()
	h.checkRoundEndLocked()
}

// ---------- 掉落 ----------

func (h *Hub) initDropsLocked(m *match) {
	for i, cfg := range m.Map.Weapons {
		st := &weaponPoint{cfg: cfg, index: i, tag: "wspawn:" + itoa(i)}
		m.points = append(m.points, st)
		h.spawnPointWeaponLocked(m, st)
	}
	for _, it := range m.Map.Items {
		if _, ok := h.data.items[it.Type]; !ok {
			continue
		}
		h.addDropLocked(m, dropState{dropItem: dropItem{
			Kind: "item", ItemID: it.Type, X: it.X, Y: it.Y, Falling: false,
		}, point: -1})
	}
	h.topUpItemsLocked(m)
	if m.Map.AutoDrop != nil && m.Map.AutoDrop.Enabled {
		initial := m.Map.AutoDrop.Initial
		if initial <= 0 {
			initial = 3
		}
		for i := 0; i < initial; i++ {
			h.autoDropLocked(m)
		}
	}
}

func (h *Hub) addDropLocked(m *match, d dropState) *dropState {
	m.nextDrop++
	d.ID = m.nextDrop
	m.Drops[d.ID] = &d
	h.broadcastLocked(&dropAddMsg{T: "drop_add", Item: d.dropItem})
	return &d
}

func (h *Hub) spawnPointWeaponLocked(m *match, st *weaponPoint) bool {
	weaponID := h.pickWeaponLocked(st.cfg)
	if weaponID == "" {
		log.Printf("[hub] 掉落点 #%d 无法确定武器", st.index)
		return false
	}
	d := dropState{
		dropItem: dropItem{
			Kind: "weapon", WeaponID: weaponID, Ammo: h.data.weapons[weaponID].Ammo,
			X: st.cfg.X, Y: max(24, st.cfg.Y-dropHeight), Falling: true, Tag: st.tag,
		},
		point: st.index,
	}
	h.addDropLocked(m, d)
	st.waiting = false
	st.timer = 0
	return true
}

func (h *Hub) pickWeaponLocked(cfg mapWeaponSpawn) string {
	mode := cfg.Mode
	if mode == "" {
		mode = "fixed"
	}
	if mode == "fixed" {
		id := cfg.Weapon
		if id == "" {
			id = cfg.Type
		}
		if h.data.hasWeapon(id) {
			return id
		}
		return ""
	}
	pool := make([]string, 0, len(cfg.Pool))
	for _, id := range cfg.Pool {
		if h.data.hasWeapon(id) {
			pool = append(pool, id)
		}
	}
	if len(pool) == 0 {
		pool = h.data.weaponIDs()
	}
	if len(pool) == 0 {
		return ""
	}
	return pool[rand.Intn(len(pool))]
}

func (h *Hub) weaponDropCountLocked(m *match) int {
	n := 0
	for _, d := range m.Drops {
		if d.Kind == "weapon" && d.WeaponID != "" {
			n++
		}
	}
	return n
}

func (h *Hub) itemDropCountLocked(m *match, itemID string) int {
	n := 0
	for _, d := range m.Drops {
		if d.Kind == "item" && d.ItemID == itemID {
			n++
		}
	}
	return n
}

func (h *Hub) topUpItemsLocked(m *match) {
	ids := make([]string, 0, len(h.data.items))
	for id := range h.data.items {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		def := h.data.items[id]
		if def.Maintain <= 0 {
			continue
		}
		for h.itemDropCountLocked(m, id) < def.Maintain {
			h.addDropLocked(m, dropState{dropItem: dropItem{
				Kind: "item", ItemID: id, X: h.randomDropXLocked(m), Y: -40, Falling: true,
			}, point: -1})
		}
	}
}

func (h *Hub) autoDropLocked(m *match) {
	ids := h.data.weaponIDs()
	if len(ids) == 0 {
		return
	}
	grenadeOnGround := false
	for _, d := range m.Drops {
		if d.Kind == "weapon" && d.WeaponID == "grenade" {
			grenadeOnGround = true
		}
	}
	pool := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "grenade" && grenadeOnGround {
			continue
		}
		pool = append(pool, id)
	}
	if len(pool) == 0 {
		return
	}
	id := pool[rand.Intn(len(pool))]
	h.addDropLocked(m, dropState{dropItem: dropItem{
		Kind: "weapon", WeaponID: id, Ammo: h.data.weapons[id].Ammo,
		X: h.randomDropXLocked(m), Y: -40, Falling: true,
	}, point: -1})
}

func (h *Hub) randomDropXLocked(m *match) float64 {
	zones := m.Map.WeaponDropZones
	if len(zones) > 0 {
		z := zones[rand.Intn(len(zones))]
		return z.X + rand.Float64()*z.W
	}
	margin := m.Map.Width * 0.2
	return margin + rand.Float64()*(m.Map.Width-margin*2)
}

func (h *Hub) tickDropsLocked(m *match, dt time.Duration) {
	// 武器掉落点：被捡走 → 等 respawnMs 再刷
	for _, st := range m.points {
		present := false
		for _, d := range m.Drops {
			if d.Tag == st.tag {
				present = true
				break
			}
		}
		if present {
			st.waiting = false
			st.timer = 0
			continue
		}
		if !st.waiting {
			st.waiting = true
			st.timer = 0
			st.respawnCount++
		}
		if st.cfg.RespawnMs <= 0 {
			continue
		}
		if st.cfg.MaxRespawns != nil && st.respawnCount > *st.cfg.MaxRespawns {
			continue
		}
		st.timer += dt
		if st.timer >= time.Duration(st.cfg.RespawnMs)*time.Millisecond {
			st.timer = 0
			h.spawnPointWeaponLocked(m, st)
		}
	}

	// 补给维持
	m.itemTimer += dt
	if m.itemTimer >= itemTopUpInterval {
		m.itemTimer = 0
		h.topUpItemsLocked(m)
	}

	// 全局空投
	if m.Map.AutoDrop != nil && m.Map.AutoDrop.Enabled {
		interval := m.Map.AutoDrop.IntervalMs
		if interval <= 0 {
			interval = 2800
		}
		count := m.Map.AutoDrop.Count
		if count <= 0 {
			count = 4
		}
		m.autoDropTimer += dt
		if m.autoDropTimer >= time.Duration(interval)*time.Millisecond {
			m.autoDropTimer = 0
			if h.weaponDropCountLocked(m) < count {
				h.autoDropLocked(m)
			}
		}
	}
}

// ---------- 拾取仲裁 ----------

func (h *Hub) handlePick(c *client, msg pickMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over || c.seat < 0 {
		return
	}
	p := m.Players[c.seat]
	if p == nil || p.Dead {
		return
	}
	d, ok := m.Drops[msg.ID]
	if !ok {
		return
	}
	// 轻量越界校验：只比较水平距离（垂直方向受落地高度影响，服务端不模拟）
	if c.hasPos && abs(d.X-c.lastX) > 260 {
		return
	}

	delete(m.Drops, d.ID)

	grant := pickGrant{Kind: d.Kind}
	switch d.Kind {
	case "item":
		def := h.data.items[d.ItemID]
		grant.ItemID = d.ItemID
		h.applyItemLocked(p, def)
	case "weapon":
		grant.WeaponID = d.WeaponID
		grant.Ammo = d.Ammo
		if msg.Swap != nil && msg.Swap.WeaponID != "" {
			h.addDropLocked(m, dropState{dropItem: dropItem{
				Kind: "weapon", WeaponID: msg.Swap.WeaponID, Ammo: msg.Swap.Ammo,
				X: msg.Swap.X, Y: msg.Swap.Y, Falling: false,
			}, point: -1})
		}
	}

	h.broadcastLocked(&pickMsgOut{
		T: "pick", ID: d.ID, By: c.seat, Grant: grant,
		HP: p.HP, Shield: p.Shield, Dead: p.Dead,
	})
}

func (h *Hub) applyItemLocked(p *playerState, def itemDef) {
	switch def.Kind {
	case "heal":
		p.HP += def.Heal
		if p.HP > maxHP {
			p.HP = maxHP
		}
	case "shield":
		p.Shield += def.Shield
		if p.Shield > maxShield {
			p.Shield = maxShield
		}
	}
	h.broadcastHPFullLocked(p, 0, "", false, nil, nil, -1)
}

// ---------- 伤害仲裁 ----------

func (h *Hub) handleDamage(c *client, msg damageMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over {
		return
	}
	src := c.seat
	target := m.Players[msg.Target]
	if target == nil || target.Dead {
		return
	}
	// 允许自伤（摔落 / 贴脸爆炸），但不给击杀计数
	now := time.Now()
	if now.Sub(target.lastDamagedAt) < 120*time.Millisecond && !msg.IgnoreInvuln && msg.Attack != target.lastAttackID {
		return
	}

	amount := msg.Amount
	if amount <= 0 {
		return
	}
	if amount > maxDamagePerHit {
		amount = maxDamagePerHit
	}
	// 每秒伤害预算（token bucket）
	if now.Sub(target.budgetAt) >= time.Second {
		target.budgetAt = now
		target.budget = maxDamagePerSec
	}
	target.budget -= amount
	if target.budget < 0 {
		return
	}

	target.lastDamagedAt = now
	if msg.Attack != 0 {
		target.lastAttackID = msg.Attack
	}

	// 护盾先承受
	remaining := amount
	if target.Shield > 0 {
		absorbed := min(float64(target.Shield), remaining)
		target.Shield -= int(absorbed)
		remaining -= absorbed
	}
	hpApplied := 0
	if remaining > 0 {
		hpApplied = int(min(float64(target.HP), remaining))
		target.HP -= hpApplied
	}

	killed := false
	if target.HP <= 0 {
		target.HP = 0
		target.Dead = true
		target.Deaths++
		m.Deaths++
		killed = true
		if killer := m.Players[src]; killer != nil && src != msg.Target {
			killer.Kills++
		}
	}

	// 展示用的伤害值是"本次攻击的伤害"，不被剩余血量截断
	h.broadcastHPFullLocked(target, int(amount), msg.Kind, msg.Crit, msg.Point, msg.KB, src)
	if killed {
		if h.bridge != nil {
			if killer := m.Players[src]; killer != nil && src != msg.Target {
				h.bridge.EventLog(killer.Nick + " 击败了 " + target.Nick)
			} else if msg.Kind == "env" {
				h.bridge.EventLog(target.Nick + " 阵亡")
			} else {
				h.bridge.EventLog(target.Nick + " 被击败")
			}
		}
		h.checkRoundEndLocked()
	}
}

func (h *Hub) handleShield(c *client, amount float64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over || c.seat < 0 {
		return
	}
	p := m.Players[c.seat]
	if p == nil || p.Dead || amount <= 0 || amount > maxShield {
		return
	}
	p.Shield = min(maxShield, p.Shield+int(amount))
	h.broadcastHPFullLocked(p, 0, "shield", false, nil, nil, -1)
}

func (h *Hub) broadcastHPFullLocked(p *playerState, amount int, kind string, crit bool, point, kb *vec2, src int) {
	h.broadcastLocked(&hpMsg{
		T: "hp", ID: p.Seat, HP: p.HP, Shield: p.Shield, Dead: p.Dead,
		Amount: float64(amount), Kind: kind, Crit: crit, Point: point, KB: kb,
		Src: src, Kills: h.killsMapLocked(),
	})
}

func (h *Hub) killsMapLocked() map[string]int {
	out := map[string]int{}
	if h.m == nil {
		return out
	}
	for seat, p := range h.m.Players {
		if p != nil {
			out[itoa(seat)] = p.Kills
		}
	}
	return out
}

func (h *Hub) handleInput(c *client, msg inputMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.m == nil || h.m.Over {
		return
	}
	if c.seat < 0 {
		return
	}
	msg.Edge = msg.Edge & 0x1f
	c.input = msg
	c.pendingEdges |= msg.Edge
}

func (h *Hub) broadcastInputsLocked() {
	m := h.m
	if m == nil || m.Over {
		return
	}
	list := make([]inputSnapshot, 0, len(m.Players))
	for seat := range m.Players {
		c := h.clientBySeatLocked(seat)
		if c == nil {
			// 掉线中的玩家：发送"无输入"，避免远端继续按旧输入移动
			list = append(list, inputSnapshot{ID: seat})
			continue
		}
		in := c.input
		snap := inputSnapshot{
			ID: seat, Seq: in.Seq, MX: in.MX, JH: in.JH, CR: in.CR,
			AH: in.AH, KH: in.KH, SW: in.SW, Aim: in.Aim, Edge: c.pendingEdges,
		}
		c.pendingEdges = 0
		list = append(list, snap)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	h.broadcastLocked(&inputBatchMsg{T: "in", Tick: uint32(time.Now().UnixMilli()), P: list})
}

func (h *Hub) clientBySeatLocked(seat int) *client {
	if h.m == nil || seat < 0 || seat >= len(h.m.Seats) {
		return nil
	}
	nick := h.m.Seats[seat]
	if nick == "" {
		return nil
	}
	return h.clients[nick]
}

func (h *Hub) handlePos(c *client, msg posMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c.lastX, c.lastY, c.hasPos = msg.X, msg.Y, true
	if h.m == nil || h.m.Over || c.seat < 0 {
		return
	}
	out := &posBatchMsg{T: "pos", P: []posSnapshot{{ID: c.seat, X: msg.X, Y: msg.Y, VX: msg.VX, VY: msg.VY}}}
	for _, other := range h.clients {
		if other != c {
			other.push(out)
		}
	}
}

// handleDropRequest 客户端把"投掷后插不进去的武器"变成地上的掉落物。
// 由服务端统一广播，保证所有客户端看到同一件物品（并能通过仲裁拾取）。
func (h *Hub) handleDropRequest(c *client, msg dropReqMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over || c.seat < 0 {
		return
	}
	if !h.data.hasWeapon(msg.WeaponID) || msg.Ammo < -1 || msg.Ammo > 999 {
		return
	}
	if !finite(msg.X) || !finite(msg.Y) || msg.X < -200 || msg.X > m.Map.Width+200 || msg.Y < -500 || msg.Y > m.Map.Height+500 {
		return
	}
	h.addDropLocked(m, dropState{dropItem: dropItem{
		Kind: "weapon", WeaponID: msg.WeaponID, Ammo: msg.Ammo,
		X: msg.X, Y: msg.Y, Falling: false,
	}, point: -1})
}

func finite(v float64) bool {
	return v == v && v < 1e9 && v > -1e9
}

// ---------- 物体销毁 ----------

func (h *Hub) handleObjectDestroyed(c *client, id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over || id == "" || len(id) > 80 {
		return
	}
	if m.destroyed[id] {
		return
	}
	m.destroyed[id] = true
	h.broadcastLocked(&objMsgOut{T: "obj", ID: id})
}

// ---------- 聊天 ----------

func (h *Hub) handleChat(c *client, text string) {
	text = trimText(text, chatMaxLen)
	if text == "" {
		return
	}
	h.mu.Lock()
	now := time.Now()
	keep := c.chatTimes[:0]
	for _, t := range c.chatTimes {
		if now.Sub(t) < chatWindow {
			keep = append(keep, t)
		}
	}
	c.chatTimes = keep
	if len(c.chatTimes) >= chatBurst {
		h.mu.Unlock()
		return
	}
	c.chatTimes = append(c.chatTimes, now)
	nick := c.nick
	h.mu.Unlock()

	h.broadcast(&chatMsgOut{T: "chat", Nick: nick, Text: text, TS: now.Unix()})
}

// onBridgeChat 把聊天室公屏消息灌进游戏内聊天。
func (h *Hub) onBridgeChat(nick, text string, ts int64) {
	h.broadcast(&chatMsgOut{T: "chat", Nick: nick, Text: trimText(text, chatMaxLen), TS: ts, Room: true})
}

// ---------- 节拍 ----------

func (h *Hub) RunTickers() {
	inputTicker := time.NewTicker(inputTick)
	simTicker := time.NewTicker(simTick)
	go func() {
		for range inputTicker.C {
			h.mu.Lock()
			h.broadcastInputsLocked()
			h.mu.Unlock()
		}
	}()
	go func() {
		for range simTicker.C {
			h.mu.Lock()
			h.tickLocked(simTick)
			h.mu.Unlock()
		}
	}()
}

func (h *Hub) tickLocked(dt time.Duration) {
	now := time.Now()
	m := h.m

	// 没有对局：只要还有人在线就开一局（例如最后一人离开后又有新玩家进来）
	if m == nil {
		if len(h.clients) > 0 {
			h.startRoundLocked()
		}
		return
	}

	if m.Over {
		// 结算展示中：到点换图重开
		if !m.NextRoundAt.IsZero() && now.After(m.NextRoundAt) {
			h.startRoundLocked()
		}
		return
	}

	h.tickDropsLocked(m, dt)
	h.checkRoundEndLocked()
}

// ---------- 房间快照 / 桥接状态 ----------

func (h *Hub) roomSnapshotLocked(c *client) *roomMsg {
	players := make([]roomPlayer, 0, len(h.order))
	spectators := make([]string, 0)
	m := h.m
	for _, nick := range h.order {
		cl := h.clients[nick]
		if cl == nil {
			continue
		}
		if cl.seat >= 0 {
			players = append(players, roomPlayer{Nick: nick, Avatar: cl.avatar, NetID: cl.seat})
		} else {
			spectators = append(spectators, nick)
		}
	}
	state := "round"
	if m != nil && m.Over {
		state = "ending"
	}
	you := -1
	if c != nil {
		you = c.seat
	}
	return &roomMsg{
		T: "room", State: state, Players: players, Spectators: spectators,
		Map: h.currentMap(), You: you, MaxPlayers: h.cfg.MaxPlayers,
	}
}

func (h *Hub) broadcastRoomLocked() {
	for _, c := range h.clients {
		c.push(h.roomSnapshotLocked(c))
	}
}

func (h *Hub) broadcastLocked(payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	for _, c := range h.clients {
		select {
		case c.send <- data:
		default:
		}
	}
}

func (h *Hub) broadcast(payload any) {
	h.mu.Lock()
	h.broadcastLocked(payload)
	h.mu.Unlock()
}

func (h *Hub) sendTo(c *client, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
	}
}

func (h *Hub) sendToLocked(c *client, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
	}
}

// states 供桥接上报。
//
// 注意：SDK 会在持有自身锁的情况下**同步**调用这个回调（ScheduleFullReport 的立即路径），
// 而业务侧调用 ScheduleFullReport 时通常持有 h.mu。因此这里绝不能加 h.mu，
// 只读一份由写侧维护的原子快照。
func (h *Hub) states() map[string]nichijou.State {
	if v, ok := h.statesSnap.Load().(map[string]nichijou.State); ok && v != nil {
		out := make(map[string]nichijou.State, len(v))
		for k, s := range v {
			out[k] = s
		}
		return out
	}
	return map[string]nichijou.State{}
}

// refreshStatesLocked 在持锁状态下重算状态快照（每个会改变"谁在玩什么"的操作末尾调用）。
func (h *Hub) refreshStatesLocked() {
	out := map[string]nichijou.State{}
	m := h.m
	for nick := range h.clients {
		if m != nil && !m.Over {
			if seat := seatOfMatch(m, nick); seat >= 0 {
				if p := m.Players[seat]; p != nil && p.Dead {
					out[nick] = nichijou.State{State: "playing", Text: "阵亡"}
				} else {
					out[nick] = nichijou.State{State: "playing"}
				}
			} else {
				out[nick] = nichijou.State{State: "spectating"}
			}
			continue
		}
		// 结算展示期间：活着的人算 waiting（下一局马上开始）
		if c := h.clients[nick]; c != nil && c.seat >= 0 {
			out[nick] = nichijou.State{State: "waiting"}
		} else {
			out[nick] = nichijou.State{State: "spectating"}
		}
	}
	h.statesSnap.Store(out)
}

func (h *Hub) reportStates() {
	if h.bridge != nil {
		h.bridge.ScheduleFullReport()
	}
}

func (h *Hub) reportStatesLocked() {
	h.refreshStatesLocked()
	if h.bridge != nil {
		h.bridge.ScheduleFullReport()
	}
}

// roomLP 房间卡片副文案（≤24 字符）。
func (h *Hub) roomLP() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.roomLPLocked()
}

func (h *Hub) roomLPLocked() string {
	m := h.m
	if m == nil {
		return "对局待开始"
	}
	if m.Over {
		return "结算中-下一局准备"
	}
	n := 0
	for _, p := range m.Players {
		if p != nil && !p.Dead {
			n++
		}
	}
	return "对局中-火柴人 " + itoa(n) + "/" + itoa(h.cfg.MaxPlayers)
}

func (h *Hub) syncRoomLPLocked() {
	if h.bridge != nil {
		h.bridge.SetRoomLP(h.roomLPLocked())
	}
}

// ---------- 桥接回调 ----------

func (h *Hub) onUserLeave(nick string) {
	h.mu.Lock()
	c := h.clients[nick]
	h.mu.Unlock()
	if c != nil {
		_ = c.conn.Close() // readPump 收尾统一处理
	}
}

func (h *Hub) onRoomClosed() {
	h.mu.Lock()
	h.closed = true
	h.broadcastLocked(&roomClosedMsg{T: "room_closed"})
	clients := make([]*client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.clients = map[string]*client{}
	h.mu.Unlock()

	// 先给写协程一点时间把 room_closed 真正发出去，再断开连接
	// （立即 Close 会抢在 writePump 之前关掉 socket，客户端收不到关房提示）
	time.Sleep(300 * time.Millisecond)
	for _, c := range clients {
		close(c.send)
		_ = c.conn.Close()
	}
	log.Printf("[hub] 房间已关闭，停止接纳新连接")
}

func (h *Hub) onConfigUpdate(_ map[string]any) {
	h.reportStates()
}

func (h *Hub) IsClosed() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.closed
}

func (h *Hub) currentMap() string {
	if h.m != nil {
		return h.m.MapName
	}
	return ""
}

// ---------- 小工具 ----------

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

func trimText(s string, maxLen int) string {
	rs := []rune(s)
	out := make([]rune, 0, len(rs))
	for _, r := range rs {
		if r == '\n' || r == '\r' || r == '\t' {
			r = ' '
		}
		if r < 0x20 {
			continue
		}
		out = append(out, r)
		if len(out) >= maxLen {
			break
		}
	}
	return string(out)
}
