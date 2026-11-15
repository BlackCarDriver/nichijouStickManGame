package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"

	"github.com/BlackCarDriver/nichijouSDK"
)

// RuntimeConfig 是本游戏自己的部署配置（监听地址、静态目录、玩法参数）。
// 插件房的接入凭证单独放在 integration.json，由聊天室管理端下发。
type RuntimeConfig struct {
	Addr       string `json:"addr"`
	InstanceID string `json:"instanceId"`
	PubKeyPath string `json:"pubkey"`
	StaticDir  string `json:"staticDir"`
	DataDir    string `json:"dataDir"`
	MaxPlayers int    `json:"maxPlayers"`
	// 一局结束后的结算展示时长（秒），到点自动换图重开
	RoundEndSeconds int `json:"roundEndSeconds"`
	// 结算弹窗延迟（秒）：先看"被谁击败"的镜头，再弹结算
	ResultDelaySeconds int  `json:"resultDelaySeconds"`
	AllowDevIdentity   bool `json:"allowDevIdentity"`
	// 对局模式：random（每局随机，默认）| ffa（个人混战）| tdm（红蓝团队战）
	Mode string `json:"mode"`
}

const (
	defaultRuntimePath     = "config/plugin_config.json"
	defaultIntegrationPath = "config/integration.json"
)

func defaultRuntimeConfig() RuntimeConfig {
	return RuntimeConfig{
		Addr:               ":8092",
		InstanceID:         "stickman-1",
		PubKeyPath:         "config/plugin_jwt.pub.pem",
		StaticDir:          "../dist",
		DataDir:            "../data",
		MaxPlayers:         8,
		RoundEndSeconds:    4,
		ResultDelaySeconds: 4,
		AllowDevIdentity:   false,
		Mode:               "random",
	}
}

// loadRuntimeConfig 读取运行配置；文件不存在时返回默认值（仅提供页面服务）。
func loadRuntimeConfig(path string) (RuntimeConfig, error) {
	cfg := defaultRuntimeConfig()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return cfg, nil
		}
		return cfg, err
	}
	if len(raw) == 0 {
		return cfg, nil
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, err
	}
	if cfg.MaxPlayers <= 0 {
		cfg.MaxPlayers = 8
	}
	if cfg.MaxPlayers > 16 {
		cfg.MaxPlayers = 16
	}
	if cfg.RoundEndSeconds <= 0 {
		cfg.RoundEndSeconds = 4
	}
	cfg.Mode = normalizeMode(cfg.Mode)
	return cfg, nil
}

// 支持的对局模式（与客户端 protocol.ts 的 MatchMode 一一对应）。
const (
	modeRandom = "random"
	modeFFA    = "ffa"
	modeTDM    = "tdm"
)

// normalizeMode 把配置里的模式归一到合法值；未知值一律回退为随机。
func normalizeMode(mode string) string {
	switch mode {
	case modeFFA, modeTDM, modeRandom:
		return mode
	default:
		return modeRandom
	}
}

// resolvePath 把配置里的相对路径按"启动目录"解析，避免依赖进程 cwd 的偶然值。
func resolvePath(path string) string {
	if path == "" || filepath.IsAbs(path) {
		return path
	}
	return filepath.Clean(path)
}

func envInt(name string, fallback int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// integrationFromEnv 允许用环境变量覆盖接入配置（部署时不必改文件）。
func integrationFromEnv(base nichijouSDK.IntegrationConfig) nichijouSDK.IntegrationConfig {
	out := base
	if v := os.Getenv("CHATROOM"); v != "" {
		out.Chatroom = v
	}
	if v := os.Getenv("INTEGRATION_ID"); v != "" {
		out.IntegrationID = v
	}
	if v := os.Getenv("BRIDGE_SECRET"); v != "" {
		out.BridgeSecret = v
	}
	if v := os.Getenv("EXCHANGE_SECRET"); v != "" {
		out.ExchangeSecret = v
	}
	out.RoomID = envInt("ROOM_ID", out.RoomID)
	if v := os.Getenv("SECRET_VERSION"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			out.SecretVersion = n
		}
	}
	return out
}
