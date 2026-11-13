package main

import (
	"crypto/rsa"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/BlackCarDriver/nichijouSDK"
)

// gameProtocolVersion 游戏同步协议版本（前端 src/net/protocol.ts 与 server/protocol.go 同一版）。
// 发版检查：curl /healthz 看到 gameProtocol=3 才说明服务端已更新。
const gameProtocolVersion = 3

var upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	// 插件房页面由聊天室 iframe 承载，来源不可预知；身份仍由 JWT 校验保证
	CheckOrigin: func(r *http.Request) bool { return true },
}

type server struct {
	cfg RuntimeConfig
	hub *Hub

	pub   *rsa.PublicKey
	integ nichijouSDK.IntegrationConfig
	// 允许本地开发时跳过 JWT（仅 --dev 时可用）
	devIdentity bool
}

func main() {
	configPath := flag.String("config", defaultRuntimePath, "运行配置 JSON")
	integrationPath := flag.String("integration", defaultIntegrationPath, "插件房接入配置 JSON")
	addr := flag.String("addr", "", "监听地址（覆盖配置）")
	staticDir := flag.String("static", "", "前端静态目录（覆盖配置）")
	dev := flag.Bool("dev", false, "本地开发：允许用 ?dev=1&nick=xxx 跳过 JWT")
	flag.Parse()

	cfg, err := loadRuntimeConfig(resolvePath(*configPath))
	if err != nil {
		log.Fatalf("读取运行配置失败: %v", err)
	}
	if *addr != "" {
		cfg.Addr = *addr
	}
	if *staticDir != "" {
		cfg.StaticDir = *staticDir
	}
	if *dev {
		cfg.AllowDevIdentity = true
	}

	integ, err := nichijouSDK.LoadIntegrationConfig(resolvePath(*integrationPath))
	if err != nil {
		log.Fatalf("读取接入配置失败: %v", err)
	}
	integ = integrationFromEnv(integ)

	data, err := loadGameData(resolvePath(cfg.DataDir))
	if err != nil {
		log.Fatalf("加载游戏数据失败: %v", err)
	}

	var pub *rsa.PublicKey
	if cfg.PubKeyPath != "" {
		pub, err = nichijouSDK.LoadPublicKey(resolvePath(cfg.PubKeyPath))
		if err != nil {
			log.Printf("[main] 公钥加载失败（将只提供页面服务）: %v", err)
			pub = nil
		}
	}

	hub := NewHub(cfg, data)
	hub.RunTickers()

	s := &server{
		cfg:         cfg,
		hub:         hub,
		pub:         pub,
		integ:       integ,
		devIdentity: cfg.AllowDevIdentity,
	}

	bridgeReady := integ.Chatroom != "" && integ.RoomID != 0 && integ.IntegrationID != "" && integ.BridgeSecret != "" && pub != nil
	if bridgeReady {
		bridge := nichijouSDK.NewBridge(nichijouSDK.Config{
			ChatroomWSBase: chatroomWSBase(integ.Chatroom),
			RoomID:         integ.RoomID,
			IntegrationID:  integ.IntegrationID,
			BridgeSecret:   integ.BridgeSecret,
			SecretVersion:  integ.SecretVersion,
			InstanceID:     cfg.InstanceID,
			PublicKey:      pub,
		}, nichijouSDK.Hooks{
			States:       hub.states,
			RoomLP:       hub.roomLP,
			OnUserLeave:  hub.onUserLeave,
			OnChat:       hub.onBridgeChat,
			OnConfig:     hub.onConfigUpdate,
			OnRoomClosed: hub.onRoomClosed,
		})
		hub.SetBridge(bridge, integ.RoomID)
		go bridge.Run()
		log.Printf("[main] 桥接已启动 roomId=%d integration=%s", integ.RoomID, integ.IntegrationID)
	} else {
		hub.SetBridge(nil, integ.RoomID)
		log.Printf("[main] 未配置接入凭证或公钥：仅提供页面服务（本地开发可加 --dev 用假身份联机）")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":       true,
			"bridge":   bridgeReady,
			"roomId":   integ.RoomID,
			"closed":   hub.IsClosed(),
			"protocol": nichijouSDK.ProtocolVersion,
			// gameProtocol：游戏前后端的同步协议版本（前端与后端必须一致，发版时一起换）
			"gameProtocol": gameProtocolVersion,
			"sdk":          nichijouSDK.Version,
			"staticDir":    cfg.StaticDir,
		})
	})
	if integ.ExchangeSecret != "" && integ.Chatroom != "" {
		mux.Handle("/exchange", nichijouSDK.NewExchangeHandler(nichijouSDK.ExchangeConfig{
			ChatroomBase:   integ.Chatroom,
			ExchangeSecret: integ.ExchangeSecret,
		}))
	}
	mux.Handle("/", http.FileServer(http.Dir(resolvePath(cfg.StaticDir))))

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           withNoCacheIndex(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("[main] 监听 %s，静态目录 %s", cfg.Addr, resolvePath(cfg.StaticDir))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("服务启动失败: %v", err)
	}
}

// chatroomWSBase 把聊天室 HTTP 基地址转换成 WS 基地址（不带路由前缀）。
func chatroomWSBase(httpBase string) string {
	base := strings.TrimSuffix(httpBase, "/")
	base = strings.TrimSuffix(base, "/chat_room_server")
	switch {
	case strings.HasPrefix(base, "https://"):
		return "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		return "ws://" + strings.TrimPrefix(base, "http://")
	default:
		return base
	}
}

// withNoCacheIndex 让 index.html 不被缓存，其余静态资源保持默认缓存策略。
func withNoCacheIndex(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	if s.hub.IsClosed() {
		http.Error(w, "room closed", http.StatusGone)
		return
	}

	nick, claims, err := s.authenticate(r)
	if err != nil {
		log.Printf("[ws] 身份校验失败: %v", err)
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	c := &client{
		conn:       conn,
		send:       make(chan []byte, 256),
		nick:       nick,
		avatar:     claims.Avatar,
		frame:      claims.Frame,
		roleID:     claims.RoleID,
		frameID:    claims.FrameID,
		registered: claims.Registered,
		seat:       -1,
	}
	log.Printf("[ws] %s 连接（已登录=%v 头像=%q）", nick, claims.Registered, claims.Avatar)

	go c.writePump()
	s.hub.addClient(c)
	s.readPump(c)
}

// authenticate 优先用聊天室签发的 JWT；--dev 时允许假身份（只用于本地联调）。
func (s *server) authenticate(r *http.Request) (string, *nichijouSDK.Claims, error) {
	if s.devIdentity && r.URL.Query().Get("dev") == "1" {
		nick := strings.TrimSpace(r.URL.Query().Get("nick"))
		if nick == "" {
			return "", nil, errors.New("dev 模式缺少 nick")
		}
		// 本地联调可以用 ?avatar=<url> 模拟聊天室头像，验证头像加载/裁圆效果
		avatar := strings.TrimSpace(r.URL.Query().Get("avatar"))
		return nick, &nichijouSDK.Claims{Sub: nick, Avatar: avatar}, nil
	}
	if s.pub == nil {
		return "", nil, errors.New("未配置公钥")
	}
	token := r.URL.Query().Get("token")
	if token == "" {
		return "", nil, errors.New("缺少 token")
	}
	claims, err := nichijouSDK.VerifyJWT(token, s.pub, s.integ.IntegrationID, s.integ.RoomID)
	if err != nil {
		return "", nil, err
	}
	return claims.Sub, claims, nil
}

func (c *client) writePump() {
	for data := range c.send {
		_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
			return
		}
	}
}

func (s *server) readPump(c *client) {
	var readErr error
	defer func() {
		s.hub.removeClient(c)
		_ = c.conn.Close()
		log.Printf("[ws] %s 断开: %v", c.nick, readErr)
	}()

	c.conn.SetReadLimit(128 * 1024)
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			readErr = err
			return
		}
		s.handleClientMessage(c, data)
	}
}

func (s *server) handleClientMessage(c *client, data []byte) {
	var head clientMsg
	if err := json.Unmarshal(data, &head); err != nil {
		return
	}
	switch head.T {
	case "chat":
		var m chatMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handleChat(c, m.Text)
		}
	case "in":
		var m inputMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handleInput(c, m)
		}
	case "pos":
		var m posMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handlePos(c, m)
		}
	case "snap":
		var m snapMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handleSnap(c, m)
		}
	case "pick":
		var m pickMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handlePick(c, m)
		}
	case "dmg":
		var m damageMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handleDamage(c, m)
		}
	case "shield":
		var m shieldMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handleShield(c, m.Amount)
		}
	case "drop":
		var m dropReqMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handleDropRequest(c, m)
		}
	case "obj":
		var m objMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handleObjectDestroyed(c, m.ID)
		}
	case "drop_remove":
		var m dropRemoveMsg
		if json.Unmarshal(data, &m) == nil {
			s.hub.handleDropRemove(c, m.ID)
		}
	case "enter":
		s.hub.handleEnter(c)
	case "spectate":
		s.hub.setSpectator(c)
	case "ping":
		var m pingMsg
		if json.Unmarshal(data, &m) == nil {
			// 原样回传 tag：UI 与网络层各用各的时钟，不能互相污染
			c.push(&pongMsg{T: "pong", TS: m.TS, Tag: m.Tag})
		}
	}
}
