# dsh-host

`dsh-host` 将 DeepSeek Harness 作为常驻、无界面的后端运行。AI 运行时、会话、
工具、工作区、审批、附件、后台任务与存储都留在 Host 机器上；本地 TUI、Web
或 Remote SSH 客户端断开后，远端会话仍可继续，之后可以重新接入。

它参考了 VS Code 远程架构的进程边界：远端执行独立于观察客户端持续运行。下面的
通信协议与认证方式属于 dsh-host 自己的契约，并不是 VS Code 协议：

- 默认启动脱离终端的常驻 supervisor；
- 只监听 loopback 的 HTTP/WebSocket 端点；
- dsh-host 的持久 connection token 与 endpoint registry 分开保存；
- 客户端通过 SSH 读取发现信息并转发端口；
- 暴露完整 Harness Host API，而不是缩水的“远程工具”接口。

## 安装

构建后，将它添加到独立 profile：

```bash
pnpm install
pnpm build
dsh plugin --profile dsh-host add /absolute/path/to/dsh-host
```

启动：

```bash
dsh --profile dsh-host
```

默认会启动后台 supervisor。开发或交给 systemd 等外部服务管理时，可使用：

```bash
dsh --profile dsh-host --foreground
```

使用 `--status` 查看共享 supervisor，使用 `--kill` 停止它。

本机 Web profile 安装 `dsh-remote-ssh` 后，可在 SSH 主机旁选择 **打开
Backend**。观察窗口在本机显示，但 API 与事件流通过同一条 SSH 连接接入本 Host。

默认私有状态位于 `$DSH_HOME/host/default/`。远程客户端通过 SSH 读取
`endpoint.json` 和 token 文件，再转发 loopback 端口。

部署与安全说明见 [INSTALL.md](./INSTALL.md)。

## 仓库边界

本仓库只负责 Backend profile 及其连接/发现契约。TUI、Web、Remote SSH 适配器
与 profile 迁移可以作为独立插件演进，而无需改变会话实际运行的位置。

## 许可证

Apache-2.0
