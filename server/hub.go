package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/BlackCarDriver/nichijouSDK"
)

const (
	maxHP     = 100
	maxShield = 500

	// 输入快照广播频率（客户端以 60Hz 上报，服务端合并到 30Hz 广播）
	inputTick = 33 * time.Millisecond
	// 补帧/掉落/重生等逻辑的节拍
	simTick = 33 * time.Millisecond
	// 位置合并广播的节拍。
	// 为什么要单独一个更快的小节拍：客户端 20Hz（50ms）上报，如果按 33ms 合并，
	// 有的玩家会"两帧合成一条、下一帧空着"，到达间隔在 0~83ms 之间跳，
	// 接收端的插值缓冲就会周期性"饿死"（外推 → 新样本一到又缩回，表现为动作不连贯）。
	// 16ms 把量化误差压到 ≤16ms，间隔稳定在 50±16ms，60ms 的插值延迟就够用了。
	posFlushTick = 16 * time.Millisecond
	// 复活等待（地图命数 > 0 时生效；与客户端死亡提示的倒计时同一数值）
	respawnDelay = 3 * time.Second
	// 默认命数（可复活次数）：地图未配 lives 时用这个
	defaultLives = 1
	// 命数上限（防止误配成天文数字把一局拖死）
	maxLives = 20
	// 单次伤害上限与每秒伤害预算（宽松的防刷保护，不做严格反作弊）
	maxDamagePerHit = 400.0
	maxDamagePerSec = 900.0
	// 聊天限频
	chatWindow = 2 * time.Second
	chatBurst  = 4
	chatMaxLen = 160

	// 武器掉落点从多高处落下（与客户端 WeaponSpawnerSystem 一致）
	dropHeight = 240
	// 掉落物视觉上浮在表面上方这么多（与客户端 PickupSystem.PICKUP_REST_OFFSET 保持一致），
	// 原地生成的武器要先减掉它，否则标签点正好压在平台上时会陷进实体里
	pickupRestOffset = 18
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
	// 下行严重拥塞、丢过必达消息：下一个节拍补一次全量状态
	needResync bool
}

func (c *client) push(payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
		// 连必达消息都塞不下：说明这个客户端已经严重掉队。
		// 丢掉它（而不是阻塞整个房间），并标记需要重同步。
		c.needResync = true
	}
}

// pushDroppable 发送"可丢"的周期性状态（世界快照 / 输入广播）。
//
// 为什么单独区分：这两类消息是**状态**而不是事件，丢一帧下帧就补上，
// 但它们占了 95% 的流量。绝不能让它们把 hp / pick / obj / host 挤掉。
func (c *client) pushDroppable(payload any) {
	if len(c.send) > cap(c.send)*3/4 {
		// 队列快满了：跳过这一帧快照/输入，客户端靠下一帧/插值兜底
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
	}
}

// playerState 是服务端权威的玩家数值（血量/护盾/击杀/重生）。
type playerState struct {
	Seat   int
	Nick   string
	Avatar string
	Color  int
	// Team = 队伍编号（团队战 0/1；混战 -1）
	Team   int
	Spawn  int
	HP     int
	Shield int
	Dead   bool
	Kills  int
	Deaths int
	// Revives = 剩余复活次数（开局等于本局命数，每复活一次减 1）
	Revives   int
	RespawnAt time.Time

	lastDamagedAt time.Time
	lastAttackID  int64
	lastWeaponID  string
	budget        float64
	budgetAt      time.Time
}

// livesLeft 剩余生命数（含当前这条；无命可续的永久死亡 = 0）。
// 注意：死亡且在等复活时，“当前这条”已经用掉了，剩下的是即将复活的那条。
func (p *playerState) livesLeft() int {
	if !p.Dead {
		return p.Revives + 1
	}
	if p.RespawnAt.IsZero() {
		return 0
	}
	return p.Revives
}

// respawnInMs 距复活还有多少毫秒（0 = 不在等待复活）。
func (p *playerState) respawnInMs(now time.Time) int {
	if p.RespawnAt.IsZero() {
		return 0
	}
	ms := p.RespawnAt.Sub(now).Milliseconds()
	if ms < 0 {
		return 0
	}
	return int(ms)
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

	// 本局模式：ffa（个人混战）/ tdm（红蓝团队战）
	Mode string
	// 本局命数（可复活次数，来自地图 / 服务端覆盖）
	Lives int
	// 本局出现过的最大上座人数（用于判断“混战只剩一人”是否该结束：
	// 单人房里自己死一次不应该立刻结算，否则有命数也来不及复活）
	Participants int
	// 本局死亡次数（至少一次死亡才会触发回合结束判定）
	Deaths int
	// 结束后到下一局开始的时间点
	NextRoundAt time.Time
	// 下一局地图（结束后提前选好并展示）
	NextMap string
	// 下一局模式（结束后提前选好并在结算弹窗里预告；下一局开局前会按实际人数再校验）
	NextMode string

	Seats   []string // 下标 = netID（座位号）
	Players map[int]*playerState
	// Host = 世界权威（房主）座位号：由该客户端模拟整张地图并广播 snap 快照。
	// 规则：本局座位里编号最小、且连接仍在的玩家；房主掉线时顺延给下一位。
	Host     int
	Drops    map[int64]*dropState
	nextDrop int64
	points   []*weaponPoint

	destroyed map[string]bool

	itemTimer     time.Duration
	autoDropTimer time.Duration
	spawnCursor   int
	// 最近一次收到房主快照的时间（看门狗用：房主卡死/失联时自动顺延）
	lastSnapAt time.Time
	// 本拍内各座位的最新位置（合并成一条报文再广播，省掉每帧一条的开销）
	posPending map[int]posSnapshot
}

// Hub 管理房间、座位、对局与所有实时同步。
type Hub struct {
	mu   sync.Mutex
	cfg  RuntimeConfig
	data *gameData

	bridge *nichijouSDK.Bridge

	clients map[string]*client
	order   []string // 入场顺序（决定座位分配优先级）

	roomID int

	// 桥接上报用的状态快照。
	// 关键：SDK 的 ScheduleFullReport 可能同步回调 States()，而调用点大多持有 h.mu，
	// 直接在里面加锁会自锁死。所以这里用原子快照：写侧持锁刷新，读侧无锁。
	statesSnap atomic.Value // map[string]nichijouSDK.State
	m          *match
	matchSeq   int64
	// 最近一帧全量世界快照（房主上报），给中途加入的客户端还原动态世界
	lastSnap      *snapMsg
	lastSnapMatch int64
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
	h.statesSnap.Store(map[string]nichijouSDK.State{})
	return h
}

func (h *Hub) SetBridge(b *nichijouSDK.Bridge, roomID int) {
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

// pickHostLocked 重新选出世界权威座位（编号最小、在线且在当前对局里的玩家）。
// 为什么需要：所有物理/破坏/拾取都以"房主客户端"为准，房主掉线必须立刻顺延。
func (h *Hub) pickHostLocked(m *match) int {
	if m == nil || m.Over {
		return -1
	}
	for seat, nick := range m.Seats {
		if nick == "" || m.Players[seat] == nil {
			continue
		}
		c := h.clients[nick]
		if c == nil || c.seat != seat || c.spectate || !c.joined {
			continue
		}
		return seat
	}
	return -1
}

// syncHostLocked 重新计算房主；变化时广播 host 消息。
func (h *Hub) syncHostLocked() bool {
	m := h.m
	if m == nil {
		return false
	}
	next := h.pickHostLocked(m)
	if next == m.Host {
		return false
	}
	m.Host = next
	h.broadcastLocked(&hostMsg{T: "host", ID: next})
	log.Printf("[hub] 世界权威变更为座位 %d", next)
	return true
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

// forcedModeLocked 配置里显式固定的模式（random = 不强制，交给地图/随机）。
// --mode 命令行也会写进同一个字段，所以回归脚本靠它压住地图设置。
func (h *Hub) forcedModeLocked() string {
	if h.cfg.Mode == modeFFA || h.cfg.Mode == modeTDM {
		return h.cfg.Mode
	}
	return ""
}

// mapFixedMode 地图里显式固定的模式（random/未设置 = 不固定）。
func mapFixedMode(mf *mapFile) string {
	if mf == nil {
		return ""
	}
	if mf.Mode == modeFFA || mf.Mode == modeTDM {
		return mf.Mode
	}
	return ""
}

// baseModeLocked 不考虑人数时的模式基础值（"" = 需要随机抽）。
//
// 优先级：服务端 config/--mode 显式固定 > 地图属性 mode > 随机。
func (h *Hub) baseModeLocked(mf *mapFile) string {
	if forced := h.forcedModeLocked(); forced != "" {
		return forced
	}
	return mapFixedMode(mf)
}

// previewModeLocked 结算预告用：随机的话就现在抽一次定下来，免得预告与开局不一致。
// 团队战至少要有 2 名玩家才能分成两队，人不够时回落为混战。
func (h *Hub) previewModeLocked(mf *mapFile, participants int) string {
	mode := h.baseModeLocked(mf)
	if mode == "" {
		if rand.Intn(2) == 0 {
			mode = modeFFA
		} else {
			mode = modeTDM
		}
	}
	if mode == modeTDM && participants < 2 {
		mode = modeFFA
	}
	return mode
}

// resolveModeLocked 开局用的模式：地图/配置没固定时，沿用上一局的预告（随机结果），
// 保证“结算弹窗说的模式 = 实际打的模式”。
func (h *Hub) resolveModeLocked(prevNextMode string, mf *mapFile, participants int) string {
	mode := h.baseModeLocked(mf)
	if mode == "" {
		if prevNextMode == modeFFA || prevNextMode == modeTDM {
			mode = prevNextMode
		} else if rand.Intn(2) == 0 {
			mode = modeFFA
		} else {
			mode = modeTDM
		}
	}
	if mode == modeTDM && participants < 2 {
		mode = modeFFA
	}
	return mode
}

// teamNames 队伍展示名（与客户端颜色对应：0=红队、1=蓝队）。
var teamNames = [2]string{"红队", "蓝队"}

// modeDisplayName 模式的中文展示名（给结算预告/等待提示用）。
func modeDisplayName(mode string) string {
	if mode == modeTDM {
		return "团队战"
	}
	return "混战"
}

// waitingText 上一局刚结束时的等待提示（提前告知下一局的地图与模式）。
func waitingText(m *match) string {
	if m == nil {
		return "上一局刚结束，下一局即将开始…"
	}
	parts := make([]string, 0, 3)
	if m.NextMap != "" {
		parts = append(parts, "地图「"+m.NextMap+"」")
	}
	if m.NextMode != "" {
		parts = append(parts, modeDisplayName(m.NextMode))
	}
	if len(parts) == 0 {
		return "上一局刚结束，下一局即将开始…"
	}
	return "上一局刚结束，下一局：" + strings.Join(parts, " · ") + "（即将开始…）"
}

// roundLives 本局命数（可复活次数）：地图 lives 优先，其次默认值；服务端 lives>=0 时强制覆盖。
func (h *Hub) roundLives(mf *mapFile) int {
	lives := defaultLives
	if mf != nil && mf.Lives != nil {
		lives = *mf.Lives
	}
	if h.cfg.Lives >= 0 {
		lives = h.cfg.Lives
	}
	if lives < 0 {
		lives = 0
	}
	if lives > maxLives {
		lives = maxLives
	}
	return lives
}

// seatedCountLocked 统计当前对局上了座位的玩家人数（用于预告下一局模式）。
func (h *Hub) seatedCountLocked(m *match) int {
	n := 0
	for seat, p := range m.Players {
		if p == nil || m.Seats[seat] == "" {
			continue
		}
		n++
	}
	return n
}

// teamNameOf 取队伍展示名（非法编号返回空串）。
func teamNameOf(team int) string {
	if team < 0 || team >= len(teamNames) {
		return ""
	}
	return teamNames[team]
}

// spawnIndicesByTeam 把地图出生点按 x 排序后对半切开：左半区给 0 队、右半区给 1 队。
// 这样团队战两支队伍天然从地图两侧开局，不会挤在一起。
func spawnIndicesByTeam(mf *mapFile) (left, right []int) {
	idx := make([]int, len(mf.SpawnPoints))
	for i := range idx {
		idx[i] = i
	}
	sort.Slice(idx, func(a, b int) bool {
		pa, pb := mf.SpawnPoints[idx[a]], mf.SpawnPoints[idx[b]]
		if pa.X != pb.X {
			return pa.X < pb.X
		}
		return pa.Y < pb.Y
	})
	half := (len(idx) + 1) / 2
	return idx[:half], idx[half:]
}

// teamSpawnIndex 取某个队伍第 ordinal 个成员的出生点下标（队内循环使用）。
func teamSpawnIndex(mf *mapFile, team, ordinal int) int {
	left, right := spawnIndicesByTeam(mf)
	pool := left
	if team == 1 {
		pool = right
	}
	if len(pool) == 0 {
		pool = left
	}
	if len(pool) == 0 {
		return 0
	}
	return pool[ordinal%len(pool)]
}

// teamCountLocked 统计当前对局里某个队伍的人数（含已死亡）。
func (h *Hub) teamCountLocked(m *match, team int) int {
	n := 0
	for seat, p := range m.Players {
		if p == nil || p.Team != team || m.Seats[seat] == "" {
			continue
		}
		n++
	}
	return n
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
	// 模式与分边：团队战中途加入的人进人少的那一队
	team := -1
	color := seat % 8
	spawn := seat % len(m.Map.SpawnPoints)
	if m.Mode == modeTDM {
		team = 0
		if h.teamCountLocked(m, 1) < h.teamCountLocked(m, 0) {
			team = 1
		}
		color = team
		spawn = teamSpawnIndex(m.Map, team, h.teamCountLocked(m, team))
	}
	p := &playerState{
		Seat: seat, Nick: c.nick, Avatar: c.avatar, Color: color, Team: team,
		Spawn: spawn,
		HP:    maxHP, Revives: m.Lives, budget: 1000, budgetAt: time.Now(),
	}
	m.Players[seat] = p
	c.seat = seat
	c.joined = true
	if len(m.Seats) > m.Participants {
		m.Participants = len(m.Seats)
	}
	// 新玩家如果是当前最小座位（比如房主刚离开），立刻把权威交给他
	h.syncHostLocked()

	join := &playerJoinMsg{
		T: "player_join",
		Player: matchPlayer{
			Nick: p.Nick, Avatar: p.Avatar, NetID: seat, Color: p.Color, Team: p.Team, Spawn: p.Spawn, Kills: p.Kills,
		},
		Stat: playerStatWire{ID: seat, HP: p.HP, Shield: p.Shield, Dead: p.Dead, Kills: p.Kills, Lives: p.livesLeft(), Revives: p.Revives},
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
	// 上一局结束时就预告过的「下一局地图/模式」，新局沿用（否则预告与实际不一致）
	nextMap := ""
	nextMode := ""
	if h.m != nil {
		nextMap = h.m.NextMap
		nextMode = h.m.NextMode
	}
	mapName := nextMap
	if _, ok := h.data.maps[mapName]; !ok {
		mapName = h.pickMapLocked()
	}
	mf := h.data.maps[mapName]
	if mf == nil {
		return
	}

	h.matchSeq++
	m := &match{
		ID:         h.matchSeq,
		MapName:    mapName,
		Map:        mf,
		StartedAt:  time.Now(),
		Seats:      []string{},
		Players:    map[int]*playerState{},
		Drops:      map[int64]*dropState{},
		destroyed:  map[string]bool{},
		Host:       -1,
		lastSnapAt: time.Now(),
	}
	h.m = m
	// 新一局：上一局的世界快照作废
	h.lastSnap = nil
	h.lastSnapMatch = m.ID

	// 先数参战人数：团队战至少要 2 人才能分两队，否则本局回退混战
	participants := 0
	for _, nick := range h.order {
		if participants >= h.cfg.MaxPlayers {
			break
		}
		c := h.clients[nick]
		if c == nil || c.spectate || !c.joined {
			continue
		}
		participants++
	}
	// 模式：服务端显式固定 > 地图属性 mode > 随机（随机结果沿用上一局的预告）
	m.Mode = h.resolveModeLocked(nextMode, mf, participants)
	m.NextMode = ""
	// 命数（可复活次数）：地图 lives 优先，可用 config/--lives 强制覆盖
	m.Lives = h.roundLives(mf)

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
		// 团队战：按座位交替分边（0,2,4→红队；1,3,5→蓝队），颜色也直接用队伍色
		team := -1
		color := seat % 8
		spawn := seat % len(mf.SpawnPoints)
		if m.Mode == modeTDM {
			team = seat % 2
			color = team
			spawn = teamSpawnIndex(mf, team, seat/2)
		}
		m.Players[seat] = &playerState{
			Seat: seat, Nick: nick, Avatar: c.avatar, Color: color, Team: team,
			Spawn: spawn,
			HP:    maxHP, Revives: m.Lives, budget: 1000, budgetAt: time.Now(),
		}
		c.seat = seat
	}
	for _, c := range h.clients {
		if c.seat >= len(m.Seats) {
			c.seat = -1 // 旁观
		}
	}
	// 开局态的参战人数：混战"只剩一人"的判定要用（中途加入会继续往上加）
	m.Participants = len(m.Seats)
	m.Host = h.pickHostLocked(m)

	h.initDropsLocked(m)
	log.Printf("[hub] 第 %d 局开始：地图=%s 模式=%s 玩家=%d 掉落=%d", m.ID, m.MapName, m.Mode, len(m.Players), len(m.Drops))
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
			Nick: p.Nick, Avatar: p.Avatar, NetID: seat, Color: p.Color, Team: p.Team, Spawn: p.Spawn, Kills: p.Kills,
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
			Lives: p.livesLeft(), Revives: p.Revives, RespawnInMs: p.respawnInMs(time.Now()),
		})
	}
	sort.Slice(stats, func(i, j int) bool { return stats[i].ID < stats[j].ID })
	you := -1
	if c != nil {
		you = c.seat
	}
	return &matchStartMsg{
		T: "match_start", MatchID: m.ID, Map: m.MapName, Mode: m.Mode, Players: players, Stats: stats,
		You: you, Host: m.Host, Drops: drops, Destroyed: destroyed, World: h.worldForKeyLocked(m),
	}
}

// worldForKeyLocked 取一帧可用的全量世界快照（只给当前对局用）。
func (h *Hub) worldForKeyLocked(m *match) *snapMsg {
	if h.lastSnap == nil || h.lastSnapMatch != m.ID {
		return nil
	}
	return h.lastSnap
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
	// 走掉的如果是房主，把世界权威顺延给下一位在线玩家
	h.syncHostLocked()
	h.broadcastLocked(&playerLeftMsg{T: "player_left", ID: seat, Nick: nick})
	h.checkRoundEndLocked()
}

// inRoundLocked 该玩家是否仍在局中：活着、或阵亡但还有命（等复活）；已离场/掉线不算。
func (h *Hub) inRoundLocked(m *match, seat int, p *playerState) bool {
	if p == nil || seat < 0 || seat >= len(m.Seats) {
		return false
	}
	nick := m.Seats[seat]
	if nick == "" || h.clients[nick] == nil {
		return false
	}
	return !p.Dead || !p.RespawnAt.IsZero()
}

// tickRespawnsLocked 处理到点的复活：命数还有的人 3 秒后满血回到出生点（空手）。
func (h *Hub) tickRespawnsLocked(m *match, now time.Time) {
	for seat, p := range m.Players {
		if p == nil || !p.Dead || p.RespawnAt.IsZero() {
			continue
		}
		if now.Before(p.RespawnAt) {
			continue
		}
		// 掉线/离场：取消复活，等回归时按新玩家处理
		if seat < 0 || seat >= len(m.Seats) || m.Seats[seat] == "" || h.clients[m.Seats[seat]] == nil {
			p.RespawnAt = time.Time{}
			continue
		}
		h.respawnPlayerLocked(m, p)
	}
}

// respawnPlayerLocked 让一个人复活：满血、护盾清空、回本队出生点，并广播 respawn。
//
// 位置由服务端指定：客户端收到后各自把自己/远端玩家瞬移过去（本地位置权威仍是客户端自己）。
func (h *Hub) respawnPlayerLocked(m *match, p *playerState) {
	if p.Revives > 0 {
		p.Revives--
	}
	p.Dead = false
	p.HP = maxHP
	p.Shield = 0
	p.RespawnAt = time.Time{}
	p.budget = 1000
	p.budgetAt = time.Now()
	spawnIdx := respawnSpawnIndex(m, p)
	p.Spawn = spawnIdx
	pt := m.Map.SpawnPoints[spawnIdx]
	h.broadcastLocked(&respawnMsg{
		T: "respawn", ID: p.Seat, X: pt.X, Y: pt.Y, HP: p.HP, Shield: p.Shield,
		Lives: p.livesLeft(), Revives: p.Revives,
	})
	// 补一次 hp：没收到 respawn 的端也能靠它自愈
	h.broadcastHPFullLocked(p, 0, "respawn", false, nil, nil, -1, 0)
}

// respawnSpawnIndex 选复活出生点：团队战回本队半区（按死亡次数轮换，避免总在同一个点）；
// 混战则按先后顺序轮换所有出生点。
func respawnSpawnIndex(m *match, p *playerState) int {
	if len(m.Map.SpawnPoints) == 0 {
		return 0
	}
	if p.Team < 0 {
		return (p.Spawn + 1) % len(m.Map.SpawnPoints)
	}
	left, right := spawnIndicesByTeam(m.Map)
	pool := left
	if p.Team == 1 {
		pool = right
	}
	if len(pool) == 0 {
		pool = left
	}
	if len(pool) == 0 {
		return 0
	}
	return pool[p.Deaths%len(pool)]
}

// checkRoundEndLocked 回合结束判定。
//
// “还在局中” = 活着 或 还有命在等复活（见 inRoundLocked），所以命数耗尽才会少一个战力。
//
// ffa：至少发生过一次死亡，且只剩一名还剩命的玩家（最后一个站着的人胜出）。
// tdm：任一支队全员出局（命尽/离场）即结束。
func (h *Hub) checkRoundEndLocked() {
	m := h.m
	if m == nil || m.Over {
		return
	}
	if m.Mode == modeTDM {
		var inRound, seated [2]int
		for seat, p := range m.Players {
			if p == nil || p.Team < 0 || p.Team > 1 {
				continue
			}
			if m.Seats[seat] == "" {
				continue
			}
			seated[p.Team]++
			if h.inRoundLocked(m, seat, p) {
				inRound[p.Team]++
			}
		}
		// 两支队伍都还有人坐着时，只有全灭才结束；没人坐着（人全走光）直接结束
		if inRound[0] == 0 || inRound[1] == 0 {
			if m.Deaths >= 1 || seated[0] == 0 || seated[1] == 0 {
				h.endRoundLocked()
			}
		}
		return
	}
	remaining, seated := 0, 0
	for seat, p := range m.Players {
		if p == nil || seat < 0 || seat >= len(m.Seats) || m.Seats[seat] == "" {
			continue
		}
		seated++
		if h.inRoundLocked(m, seat, p) {
			remaining++
		}
	}
	if seated > m.Participants {
		m.Participants = seated
	}
	// 全员出局（含“都离开了”）→ 结算
	if remaining == 0 {
		if m.Deaths >= 1 {
			h.endRoundLocked()
		}
		return
	}
	// 只剩一人还有命：本局结束（单人房里不这样判，否则一死就结算、复活没机会发生）
	if remaining <= 1 && m.Participants >= 2 && m.Deaths >= 1 {
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
	var inRoundByTeam, killsByTeam, seatedByTeam [2]int
	for seat, p := range m.Players {
		if p == nil {
			continue
		}
		results = append(results, matchResult{Nick: p.Nick, NetID: seat, Kills: p.Kills, Team: p.Team})
		stillIn := h.inRoundLocked(m, seat, p)
		if stillIn {
			lastAlive = p.Nick
		}
		if p.Team >= 0 && p.Team < 2 {
			killsByTeam[p.Team] += p.Kills
			if m.Seats[seat] != "" {
				seatedByTeam[p.Team]++
			}
			if stillIn {
				inRoundByTeam[p.Team]++
			}
		}
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].Kills != results[j].Kills {
			return results[i].Kills > results[j].Kills
		}
		return results[i].NetID < results[j].NetID
	})

	winner := lastAlive
	winnerTeam := -1
	reason := "lastman"
	if m.Mode == modeTDM {
		reason = "teamwipe"
		// 交战中的人头多的一队胜；都出局了就看总击杀，再平就判平局
		switch {
		case inRoundByTeam[0] != inRoundByTeam[1]:
			if inRoundByTeam[0] > inRoundByTeam[1] {
				winnerTeam = 0
			} else {
				winnerTeam = 1
			}
		case seatedByTeam[0] != seatedByTeam[1]:
			// 一队人全走光了：还坐着的队取胜
			if seatedByTeam[0] > seatedByTeam[1] {
				winnerTeam = 0
			} else {
				winnerTeam = 1
			}
		case killsByTeam[0] != killsByTeam[1]:
			if killsByTeam[0] > killsByTeam[1] {
				winnerTeam = 0
			} else {
				winnerTeam = 1
			}
		default:
			winnerTeam = -1
		}
		if winnerTeam >= 0 {
			winner = teamNameOf(winnerTeam)
		} else {
			// 平局：不给胜者名，客户端显示“平局”
			winner = ""
		}
	} else if winner == "" && len(results) > 0 {
		winner = results[0].Nick
	}

	nextMap := h.pickMapLocked()
	m.NextMap = nextMap
	// 下一局模式也提前定好，好让结算弹窗能预告（优先看下一张地图自己配的模式；
	// 随机的话现在就抽定，人数不够 tdm 时自动回落混战）
	m.NextMode = h.previewModeLocked(h.data.maps[nextMap], h.seatedCountLocked(m))
	// 先留 resultDelay 秒给"击败镜头"，再弹结算，最后换图重开
	delaySeconds := h.cfg.ResultDelaySeconds
	if delaySeconds < 0 {
		delaySeconds = 0
	}
	restartMs := (delaySeconds + h.cfg.RoundEndSeconds) * 1000
	m.NextRoundAt = time.Now().Add(time.Duration(restartMs) * time.Millisecond)

	log.Printf("[hub] 第 %d 局结束：模式=%s 胜者=%s(team=%d) 死亡=%d 下一张=%s(%s)", m.ID, m.Mode, winner, winnerTeam, m.Deaths, nextMap, m.NextMode)
	h.broadcastLocked(&matchEndMsg{
		T: "match_end", Results: results, Winner: winner, WinnerTeam: winnerTeam, Mode: m.Mode, Reason: reason,
		RestartInMs: restartMs, DelayMs: delaySeconds * 1000, NextMap: nextMap, NextMode: m.NextMode,
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
		h.sendToLocked(c, &waitingMsg{T: "waiting", Text: waitingText(m)})
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
		h.sendToLocked(c, &waitingMsg{T: "waiting", Text: waitingText(m)})
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
		h.spawnPointDropLocked(m, st)
	}
	for _, it := range m.Map.Items {
		if _, ok := h.data.items[it.Type]; !ok {
			continue
		}
		h.addDropLocked(m, dropState{dropItem: dropItem{
			Kind: "item", ItemID: it.Type, X: it.X, Y: it.Y, Falling: false,
		}, point: -1})
	}
	// 天上掉补给也要显式开启 autoDrop（与武器一致；默认只有 map.items[] / 投放点）
	if m.Map.AutoDrop != nil && m.Map.AutoDrop.Enabled {
		h.topUpItemsLocked(m)
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

// spawnPointDropLocked 在投放点生成内容：武器或补给道具（医疗包/防弹衣）。
func (h *Hub) spawnPointDropLocked(m *match, st *weaponPoint) bool {
	kind, id := h.pickDropLocked(st.cfg)
	if id == "" {
		log.Printf("[hub] 投放点 #%d 无法确定内容", st.index)
		return false
	}
	// 默认直接出现在作者放置的位置（Falling=false）：
	// 从天上掉会被屋顶/门框挡住，最后停在"门上面"而不是刷新点里。
	// 需要从天而降观感时，在地图数据里给该点加 "fromSky": true。
	fromSky := st.cfg.FromSky
	y := st.cfg.Y - pickupRestOffset
	if fromSky {
		y = max(24, st.cfg.Y-dropHeight)
	}
	item := dropItem{Kind: kind, X: st.cfg.X, Y: y, Falling: fromSky, Tag: st.tag}
	if kind == "weapon" {
		item.WeaponID = id
		item.Ammo = h.data.weapons[id].Ammo
	} else {
		item.ItemID = id
	}
	h.addDropLocked(m, dropState{dropItem: item, point: st.index})
	st.waiting = false
	st.timer = 0
	return true
}

// pickDropLocked 决定这个投放点这次刷什么：返回 ("weapon"|"item", id)。
// 规则必须与客户端 src/world/WeaponSpawnerSystem.pickContent 一致。
func (h *Hub) pickDropLocked(cfg mapWeaponSpawn) (string, string) {
	mode := cfg.Mode
	if mode == "" {
		mode = "fixed"
	}
	if mode == "fixed" {
		// 显式道具优先；否则 weapon/type（写道具 id 也认）
		if cfg.Item != "" {
			if _, ok := h.data.items[cfg.Item]; ok {
				return "item", cfg.Item
			}
			return "", ""
		}
		id := cfg.Weapon
		if id == "" {
			id = cfg.Type
		}
		if h.data.hasWeapon(id) {
			return "weapon", id
		}
		if _, ok := h.data.items[id]; ok {
			return "item", id
		}
		return "", ""
	}
	// 随机：候选池里武器/道具都可以有
	pool := make([]string, 0, len(cfg.Pool))
	for _, id := range cfg.Pool {
		if h.data.hasWeapon(id) {
			pool = append(pool, id)
			continue
		}
		if _, ok := h.data.items[id]; ok {
			pool = append(pool, id)
		}
	}
	if len(pool) == 0 {
		pool = h.data.weaponIDs()
	}
	if len(pool) == 0 {
		return "", ""
	}
	picked := pool[rand.Intn(len(pool))]
	if h.data.hasWeapon(picked) {
		return "weapon", picked
	}
	return "item", picked
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
			h.spawnPointDropLocked(m, st)
		}
	}

	// 补给维持（只有开启 autoDrop 才天上掉补给，与武器一致）
	if m.Map.AutoDrop != nil && m.Map.AutoDrop.Enabled {
		m.itemTimer += dt
		interval := itemTopUpInterval
		if m.Map.AutoDrop.IntervalMs > 0 {
			interval = time.Duration(m.Map.AutoDrop.IntervalMs) * time.Millisecond
		}
		if m.itemTimer >= interval {
			m.itemTimer = 0
			h.topUpItemsLocked(m)
		}
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
	// 谁捡谁上报（拾取是"行动者最清楚"的操作，房主代判会因为延迟漏捡）
	by := c.seat
	if msg.By >= 0 && msg.By < len(m.Seats) && msg.By != c.seat && m.Players[msg.By] != nil {
		// 兼容旧字段：仅房主可以代报（正常流程不再使用）
		if c.seat == m.Host {
			by = msg.By
		}
	}
	p = m.Players[by]
	p = m.Players[by]
	if p == nil || p.Dead {
		return
	}
	d, ok := m.Drops[msg.ID]
	if !ok {
		return
	}
	// 轻量越界校验：只对"普通客户端给自己拾取"生效。
	// 房主代其它玩家拾取时，c.lastX 是房主自己的位置，拿来校验是错误的。
	if by == c.seat && c.seat != m.Host && c.hasPos && abs(d.X-c.lastX) > 260 {
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
		T: "pick", ID: d.ID, By: by, Grant: grant,
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
	h.broadcastHPFullLocked(p, 0, "", false, nil, nil, -1, 0)
}

// ---------- 伤害仲裁 ----------

func (h *Hub) handleDamage(c *client, msg damageMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over {
		return
	}
	p := m.Players[c.seat]
	if p == nil || p.Dead {
		return
	}
	target := m.Players[msg.Target]
	if target == nil || target.Dead {
		return
	}
	// 攻击者：房主代报时必须显式携带（-1 = 位置/环境伤害）
	src := msg.Src
	if src < 0 || m.Players[src] == nil {
		src = -1
	}
	// 环境伤害（摔落等）只允许"自己上报自己"，避免拿它给别人刷伤害
	if msg.Kind == "env" && msg.Target != c.seat {
		return
	}
	// 团队战：友军无伤害（服务端权威兜底，防住客户端漏过滤/作弊）
	// 自伤（贴脸爆炸/摔落）不受影响。
	if m.Mode == modeTDM && src >= 0 && src != msg.Target {
		if shooter := m.Players[src]; shooter != nil && shooter.Team >= 0 && shooter.Team == target.Team {
			return
		}
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
	// 记录本次伤害的武器 id：与血量一起广播，客户端据此做"被谁用什么击败"
	target.lastWeaponID = msg.Weapon

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
		// 命数：还有命就排队复活；命尽则本局永久出局（等下一局）
		if target.Revives > 0 {
			target.RespawnAt = now.Add(respawnDelay)
		} else {
			target.RespawnAt = time.Time{}
		}
	}
	// 展示用的伤害值是"本次攻击的伤害"，不被剩余血量截断
	h.broadcastHPFullLocked(target, int(amount), msg.Kind, msg.Crit, msg.Point, msg.KB, src, msg.Attack)
	if killed {
		if h.bridge != nil {
			if killer := m.Players[src]; killer != nil && src != msg.Target {
				h.bridge.EventLog(killer.Nick + " 击败了 " + target.Nick)
			} else if msg.Kind == "env" {
				h.bridge.EventLog(target.Nick + " 阵亡")
			} else {
				h.bridge.EventLog(target.Nick + " 被击败")
			}
			if !target.RespawnAt.IsZero() {
				h.bridge.EventLog(target.Nick + " 还剩 " + itoa(target.Revives) + " 次复活")
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
	h.broadcastHPFullLocked(p, 0, "shield", false, nil, nil, -1, 0)
}

func (h *Hub) broadcastHPFullLocked(p *playerState, amount int, kind string, crit bool, point, kb *vec2, src int, attack int64) {
	h.broadcastLocked(&hpMsg{
		T: "hp", ID: p.Seat, HP: p.HP, Shield: p.Shield, Dead: p.Dead,
		Amount: float64(amount), Kind: kind, Crit: crit, Point: point, KB: kb,
		Src: src, Weapon: p.lastWeaponID, Attack: attack, Kills: h.killsMapLocked(),
		Lives: p.livesLeft(), Revives: p.Revives, RespawnInMs: p.respawnInMs(time.Now()),
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
	msg := &inputBatchMsg{T: "in", Tick: uint32(time.Now().UnixMilli()), H: m.Host, P: list}
	for _, c := range h.clients {
		c.pushDroppable(msg)
	}
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
	m := h.m
	if m == nil || m.Over || c.seat < 0 {
		return
	}
	// 位置权威在**玩家自己的客户端**（延迟最低、不会有橡皮筋）。
	// 服务端只做中继，但不再"收到一条转一条"：这里只记录最新值，
	// 由 flushPosLocked 每拍合并成一条报文广播（8 人房下行报文数从 160/s 降到 30/s）。
	if m.posPending == nil {
		m.posPending = map[int]posSnapshot{}
	}
	m.posPending[c.seat] = posSnapshot{ID: c.seat, X: msg.X, Y: msg.Y, VX: msg.VX, VY: msg.VY, G: msg.G, Q: msg.Q}
}

// flushPosLocked 把本拍内所有玩家的最新位置合并成一条 pos 报文广播出去。
func (h *Hub) flushPosLocked() {
	m := h.m
	if m == nil || len(m.posPending) == 0 {
		return
	}
	list := make([]posSnapshot, 0, len(m.posPending))
	for _, s := range m.posPending {
		list = append(list, s)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	m.posPending = map[int]posSnapshot{}
	if h.m.Over {
		return
	}
	out := &posBatchMsg{T: "pos", P: list}
	for _, c := range h.clients {
		// 客户端会忽略自己 id 的那条，所以统一广播即可
		c.pushDroppable(out)
	}
}

// ---------- 世界状态同步（房主权威）----------

// handleSnap 转发房主的权威世界快照；服务端缓存全量帧供中途加入者还原。
func (h *Hub) handleSnap(c *client, msg snapMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over || c.seat < 0 || c.seat != m.Host {
		return
	}
	if len(msg.P) > 32 || len(msg.O) > 512 || len(msg.D) > 128 {
		return
	}
	m.lastSnapAt = time.Now()
	msg.T = "snap"
	msg.H = m.Host
	if msg.Key {
		clone := msg
		h.lastSnap = &clone
		h.lastSnapMatch = m.ID
	}
	// 掉落物落点由房主模拟，服务端只需记录最新值：
	// 这样中途加入的玩家拿到的 match_start.drops 才是"已经落地"的坐标，而不是出生点。
	for _, d := range msg.D {
		if st, ok := m.Drops[d.ID]; ok {
			st.X, st.Y, st.Falling = d.X, d.Y, d.F
		}
	}
	for _, other := range h.clients {
		if other != c {
			other.pushDroppable(&msg)
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
	// 投掷武器落地：只接受房主上报（各端都会本地模拟投掷动作，否则会重复生成多把）
	if c.seat != m.Host {
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

// handleShot 转发投掷物出生事件（只做校验与转发，不参与弹道计算）。
//
// 为什么由发射者广播：只有他自己知道"枪口真实在哪、朝哪打"。
// 其它端的枪口位置是插值过的（晚 100~200ms），本地猜出来的弹道必然偏。
func (h *Hub) handleShot(c *client, msg shotMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over || c.seat < 0 || len(msg.S) == 0 {
		return
	}
	if len(msg.S) > 32 {
		return
	}
	out := make([]shotWire, 0, len(msg.S))
	for _, s := range msg.S {
		if s.W == "" || len(s.W) > 40 || !h.data.hasWeapon(s.W) {
			continue
		}
		if !finite(s.X) || !finite(s.Y) || !finite(s.A) {
			continue
		}
		if s.X < -800 || s.X > m.Map.Width+800 || s.Y < -1200 || s.Y > m.Map.Height+1200 {
			continue
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		return
	}
	payload := &shotBatchOut{T: "shot", By: c.seat, S: out}
	for _, other := range h.clients {
		if other != c {
			other.pushDroppable(payload)
		}
	}
}

// ---------- 掉落物移除 ----------

// handleDropRemove 房主请求移除一件掉落物（掉出地图/被销毁），服务端删记录并广播。
func (h *Hub) handleDropRemove(c *client, id int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over || c.seat < 0 || c.seat != m.Host {
		return
	}
	if _, ok := m.Drops[id]; !ok {
		return
	}
	delete(m.Drops, id)
	h.broadcastLocked(&dropRemoveOut{T: "drop_remove", ID: id})
}

// ---------- 物体销毁 ----------

func (h *Hub) handleObjectDestroyed(c *client, id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.m
	if m == nil || m.Over || id == "" || len(id) > 80 {
		return
	}
	// 物体破坏由房主统一结算；其它客户端只是接收者
	if c.seat != m.Host {
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
	posTicker := time.NewTicker(posFlushTick)
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
	go func() {
		for range posTicker.C {
			h.mu.Lock()
			h.flushPosLocked()
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

	h.hostWatchdogLocked(m, now)
	h.resyncLaggingLocked()

	if m.Over {
		// 结算展示中：到点换图重开
		if !m.NextRoundAt.IsZero() && now.After(m.NextRoundAt) {
			h.startRoundLocked()
		}
		return
	}

	h.tickDropsLocked(m, dt)
	h.tickRespawnsLocked(m, now)
	h.checkRoundEndLocked()
}

// hostWatchdogLocked 房主看门狗：世界权威超过 2 秒没有任何快照，就顺延给下一位。
//
// 为什么必须有：客户端之间的角色一旦和"服务端认定的房主"失配，
// 服务端会静默丢弃 snap/dmg/pick/obj —— 没有伤害就没有死亡、本局永远不结束，
// 房间会永久停在"房主自己流畅、其他人全废"的状态。看门狗把这个死状态拽回来。
func (h *Hub) hostWatchdogLocked(m *match, now time.Time) {
	if m.Over || m.Host < 0 {
		return
	}
	// 只有一名玩家时不需要看门狗（他自己就是权威）
	if len(m.Players) <= 1 {
		return
	}
	if now.Sub(m.lastSnapAt) < 2*time.Second {
		return
	}
	current := m.Host
	m.Host = -1
	for seat, nick := range m.Seats {
		if seat == current || nick == "" || m.Players[seat] == nil {
			continue
		}
		c := h.clients[nick]
		if c == nil || c.seat != seat || c.spectate || !c.joined {
			continue
		}
		m.Host = seat
		m.lastSnapAt = now
		log.Printf("[hub] 房主看门狗：座位 %d 超时未发快照，权威顺延给座位 %d", current, seat)
		h.broadcastLocked(&hostMsg{T: "host", ID: seat})
		return
	}
	// 没有别的玩家可接管：还给他自己，避免 Host=-1 让所有上报被丢弃
	m.Host = current
	m.lastSnapAt = now
}

// resyncLaggingLocked 给"丢过必达消息"的客户端补一次全量状态（血量/掉落/已毁/房主）。
func (h *Hub) resyncLaggingLocked() {
	m := h.m
	if m == nil {
		return
	}
	for _, c := range h.clients {
		if !c.needResync {
			continue
		}
		c.needResync = false
		h.sendToLocked(c, h.matchStartLocked(c))
	}
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
func (h *Hub) states() map[string]nichijouSDK.State {
	if v, ok := h.statesSnap.Load().(map[string]nichijouSDK.State); ok && v != nil {
		out := make(map[string]nichijouSDK.State, len(v))
		for k, s := range v {
			out[k] = s
		}
		return out
	}
	return map[string]nichijouSDK.State{}
}

// refreshStatesLocked 在持锁状态下重算状态快照（每个会改变"谁在玩什么"的操作末尾调用）。
func (h *Hub) refreshStatesLocked() {
	out := map[string]nichijouSDK.State{}
	m := h.m
	for nick := range h.clients {
		if m != nil && !m.Over {
			if seat := seatOfMatch(m, nick); seat >= 0 {
				if p := m.Players[seat]; p != nil && p.Dead {
					out[nick] = nichijouSDK.State{State: "playing", Text: "阵亡"}
				} else {
					out[nick] = nichijouSDK.State{State: "playing"}
				}
			} else {
				out[nick] = nichijouSDK.State{State: "spectating"}
			}
			continue
		}
		// 结算展示期间：活着的人算 waiting（下一局马上开始）
		if c := h.clients[nick]; c != nil && c.seat >= 0 {
			out[nick] = nichijouSDK.State{State: "waiting"}
		} else {
			out[nick] = nichijouSDK.State{State: "spectating"}
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
