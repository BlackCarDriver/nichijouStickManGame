# nichijouSDK（同步副本）

本目录是聊天室插件房 Go SDK 的**同步副本**，源码来自：

```
ChatRoomGameDemo/nichijouSDK
```

保留原包名 `nichijouSDK`，导入路径为 `stickmangame/server/internal/nichijou`。

- 不要在这里做业务改造；如需适配，请在 `server/` 的业务代码里包一层。
- 上游 SDK 升级时，整目录覆盖后执行 `go build ./...` 并重跑联调脚本。
- 当前同步版本：`version.go` 中 `Version = 0.1.0`、`ProtocolVersion = v1`。
- 同步时间：2026-11-13。
