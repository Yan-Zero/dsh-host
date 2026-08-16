# dsh-host

`dsh-host` 将 DeepSeek Harness 作为常驻、无界面的后端运行。AI 运行时、会话、
工具、工作区、审批、附件、后台任务与存储都留在 Host 机器上；客户端适配器断开
后，远端会话仍可继续，之后可以重新接入。

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
dsh plugin --profile host add /absolute/path/to/dsh-host
```

启动：

```bash
dsh --profile host
```

默认会启动后台 supervisor。开发或交给 systemd 等外部服务管理时，可使用：

```bash
dsh --profile host --foreground
```

使用 `--status` 查看共享 supervisor，使用 `--kill` 停止它；`--list` 会列出当前
OS 用户注册的全部存活 Host 实例。

所有客户端使用同一个 Host 协议：认证后的 `/api/<method>` RPC、
`/api/events.mux` 与 `/api/events.host` 事件流，以及
`/dsh-host/protocol` 协议发现。`dsh-remote-ssh` 原样转发这个端点，并为终端和
daemon 客户端导出 Node client；它的 Web surface 只为本机静态页面增加同源反向代理。

插件安装在远端 `host` profile 中，其配置、依赖、命令和 agent 作用域仍使用
Harness 的原生机制。客户端与插件接入方式见[Host 协议](./docs/PROTOCOL.zh.md)
和[插件契约](./docs/PLUGINS.zh.md)。

默认私有状态位于 `$DSH_HOME/host/default/`。每个 generation 还会在
`$DSH_HOME/host/registry/` 发布 per-user 注册项。远程客户端通过稳定实例名找到
当前 PID、随机 loopback 端口与 token；重新连接不会重启 Host。

部署与安全说明见 [INSTALL.md](./INSTALL.md)。

## 仓库边界

本仓库负责 Backend profile、认证和连接/发现契约，不挂载浏览器、终端、locale、
theme 或其他 UI package。

## 许可证

Apache-2.0
