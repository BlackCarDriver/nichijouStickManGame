package main

// 本文件是"游戏服务 ↔ 游戏页面"的线上协议（与 src/net/protocol.ts 一一对应）。
// 桥接通道（游戏服务 ↔ 聊天室）由 nichijouSDK 负责，不在这里定义。

// ---------- 客户端 → 服务端 ----------

type clientMsg struct {
	T string `json:"t"`
}

type chatMsg struct {
	T    string `json:"t"`
	Text string `json:"text"`
}

type inputMsg struct {
	T    string  `json:"t"`
	Seq  uint32  `json:"seq"`
	MX   int     `json:"mx"`
	JH   bool    `json:"jh"`
	CR   bool    `json:"cr"`
	AH   bool    `json:"ah"`
	KH   bool    `json:"kh"`
	SW   bool    `json:"sw"`
	Aim  float64 `json:"aim"`
	Edge uint8   `json:"e"`
}

type posMsg struct {
	T  string  `json:"t"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	VX float64 `json:"vx"`
	VY float64 `json:"vy"`
}

type swapPayload struct {
	WeaponID string  `json:"weaponId"`
	Ammo     int     `json:"ammo"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
}

type pickMsg struct {
	T    string       `json:"t"`
	ID   int64        `json:"id"`
	Swap *swapPayload `json:"swap"`
}

type vec2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type damageMsg struct {
	T            string  `json:"t"`
	Target       int     `json:"target"`
	Amount       float64 `json:"amount"`
	Kind         string  `json:"kind"`
	Crit         bool    `json:"crit"`
	Point        *vec2   `json:"point"`
	KB           *vec2   `json:"kb"`
	Attack       int64   `json:"attack"`
	IgnoreInvuln bool    `json:"ignoreInvuln"`
}

type shieldMsg struct {
	T      string  `json:"t"`
	Amount float64 `json:"amount"`
}

type dropReqMsg struct {
	T        string  `json:"t"`
	WeaponID string  `json:"weaponId"`
	Ammo     int     `json:"ammo"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
}

type objMsg struct {
	T  string `json:"t"`
	ID string `json:"id"`
}

// enterMsg 客户端"点击 W 开始"后才真正加入对局（此前只是旁观/加载）。
type enterMsg struct {
	T string `json:"t"`
}

// spectateMsg 主动选择观战（移动端无法操作时使用）。
type spectateMsg struct {
	T string `json:"t"`
}

type pingMsg struct {
	T  string `json:"t"`
	TS int64  `json:"ts"`
}

// 输入边沿掩码（与客户端一致）
const (
	edgeJump    uint8 = 1 << 0
	edgeAttack  uint8 = 1 << 1
	edgeKick    uint8 = 1 << 2
	edgeSwap    uint8 = 1 << 3
	edgeGrenade uint8 = 1 << 4
)

// ---------- 服务端 → 客户端 ----------

type welcomeMsg struct {
	T          string   `json:"t"`
	Nick       string   `json:"nick"`
	Avatar     string   `json:"avatar"`
	Frame      string   `json:"frame"`
	RoleID     int      `json:"roleId"`
	FrameID    int      `json:"frameId"`
	Registered bool     `json:"registered"`
	NetID      int      `json:"netId"`
	Host       bool     `json:"host"`
	RoomID     int      `json:"roomId"`
	Title      string   `json:"title"`
	MaxPlayers int      `json:"maxPlayers"`
	Maps       []string `json:"maps"`
	Map        string   `json:"map"`
	KillTarget int      `json:"killTarget"`
}

type roomPlayer struct {
	Nick   string `json:"nick"`
	Avatar string `json:"avatar"`
	NetID  int    `json:"netId"`
	Ready  bool   `json:"ready"`
	Host   bool   `json:"host"`
}

type roomMsg struct {
	T          string       `json:"t"`
	State      string       `json:"state"` // round | ending
	Players    []roomPlayer `json:"players"`
	Spectators []string     `json:"spectators"`
	Map        string       `json:"map"`
	You        int          `json:"you"`
	MaxPlayers int          `json:"maxPlayers"`
}

type matchPlayer struct {
	Nick   string `json:"nick"`
	Avatar string `json:"avatar"`
	NetID  int    `json:"netId"`
	Color  int    `json:"color"`
	Spawn  int    `json:"spawn"`
	Kills  int    `json:"kills"`
}

type dropItem struct {
	ID       int64   `json:"id"`
	Kind     string  `json:"kind"` // weapon | item
	WeaponID string  `json:"weaponId,omitempty"`
	ItemID   string  `json:"itemId,omitempty"`
	Ammo     int     `json:"ammo,omitempty"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Falling  bool    `json:"falling"`
	Tag      string  `json:"tag,omitempty"`
}

type playerStatWire struct {
	ID     int  `json:"id"`
	HP     int  `json:"hp"`
	Shield int  `json:"shield"`
	Dead   bool `json:"dead"`
	Kills  int  `json:"kills"`
}

type matchStartMsg struct {
	T         string           `json:"t"`
	MatchID   int64            `json:"matchId"`
	Map       string           `json:"map"`
	Players   []matchPlayer    `json:"players"`
	Stats     []playerStatWire `json:"stats"`
	You       int              `json:"you"`
	Drops     []dropItem       `json:"drops"`
	Destroyed []string         `json:"destroyed"`
}

// playerJoinMsg 对局中途加入的新玩家（其它客户端需要动态创建火柴人）。
type playerJoinMsg struct {
	T      string         `json:"t"`
	Player matchPlayer    `json:"player"`
	Stat   playerStatWire `json:"stat"`
}

// waitingMsg 上一局刚结束、下一局还没开始时连接进来。
type waitingMsg struct {
	T    string `json:"t"`
	Text string `json:"text"`
}

type inputSnapshot struct {
	ID   int     `json:"id"`
	Seq  uint32  `json:"seq"`
	MX   int     `json:"mx"`
	JH   bool    `json:"jh"`
	CR   bool    `json:"cr"`
	AH   bool    `json:"ah"`
	KH   bool    `json:"kh"`
	SW   bool    `json:"sw"`
	Aim  float64 `json:"aim"`
	Edge uint8   `json:"e"`
}

type inputBatchMsg struct {
	T    string          `json:"t"`
	Tick uint32          `json:"tick"`
	P    []inputSnapshot `json:"p"`
}

type posSnapshot struct {
	ID int     `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	VX float64 `json:"vx"`
	VY float64 `json:"vy"`
}

type posBatchMsg struct {
	T string        `json:"t"`
	P []posSnapshot `json:"p"`
}

type hpMsg struct {
	T      string         `json:"t"`
	ID     int            `json:"id"`
	HP     int            `json:"hp"`
	Shield int            `json:"shield"`
	Dead   bool           `json:"dead"`
	Amount float64        `json:"amount"`
	Kind   string         `json:"kind"`
	Crit   bool           `json:"crit"`
	Point  *vec2          `json:"point"`
	KB     *vec2          `json:"kb"`
	Src    int            `json:"src"`
	Kills  map[string]int `json:"kills"`
}

type dropAddMsg struct {
	T    string   `json:"t"`
	Item dropItem `json:"item"`
}

type pickGrant struct {
	Kind     string `json:"kind"` // weapon | item
	WeaponID string `json:"weaponId,omitempty"`
	ItemID   string `json:"itemId,omitempty"`
	Ammo     int    `json:"ammo,omitempty"`
}

type pickMsgOut struct {
	T      string    `json:"t"`
	ID     int64     `json:"id"`
	By     int       `json:"by"`
	Grant  pickGrant `json:"grant"`
	HP     int       `json:"hp"`
	Shield int       `json:"shield"`
	Dead   bool      `json:"dead"`
}

type objMsgOut struct {
	T  string `json:"t"`
	ID string `json:"id"`
}

type chatMsgOut struct {
	T    string `json:"t"`
	Nick string `json:"nick"`
	Text string `json:"text"`
	TS   int64  `json:"ts"`
	Room bool   `json:"room"`
}

type playerLeftMsg struct {
	T    string `json:"t"`
	ID   int    `json:"id"`
	Nick string `json:"nick"`
}

type matchResult struct {
	Nick  string `json:"nick"`
	NetID int    `json:"netId"`
	Kills int    `json:"kills"`
}

type matchEndMsg struct {
	T           string        `json:"t"`
	Results     []matchResult `json:"results"`
	Winner      string        `json:"winner"`
	Reason      string        `json:"reason"`
	RestartInMs int           `json:"restartInMs"`
	NextMap     string        `json:"nextMap"`
}

type errorMsg struct {
	T       string `json:"t"`
	Message string `json:"message"`
}

type pongMsg struct {
	T  string `json:"t"`
	TS int64  `json:"ts"`
}

type roomClosedMsg struct {
	T string `json:"t"`
}
