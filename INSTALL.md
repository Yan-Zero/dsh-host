# Installation / 安装

## Requirements / 环境要求

- DeepSeek Harness `0.1.0-rc.6` or compatible
- Node.js 22.19+ or 24+
- pnpm
- SSH for remote attachment

## Local source install / 本地源码安装

```bash
git clone git@github.com:Yan-Zero/dsh-host.git
cd dsh-host
pnpm install
pnpm build
dsh plugin --profile host add "$PWD"
dsh --profile host
```

## SSH host without Node.js / 没有 Node.js 的 SSH 主机

The POSIX installer keeps Node.js, pnpm, Harness, and versioned releases under
`~/.dsh-host`; it does not modify the system package manager. Re-running it is
the upgrade path and switches the active release only after installation.

POSIX 安装器把 Node.js、pnpm、Harness 与版本化 release 都放在
`~/.dsh-host`，不会修改系统包管理器；重复运行同一个安装器就是升级流程。
安装器还会实际启动一次 PTY 子进程；终端运行时不可用时，安装不会伪装成功。

```bash
curl -fsSL https://raw.githubusercontent.com/Yan-Zero/dsh-host/main/scripts/install.sh | sh
```

For a source tarball copied over SSH / 使用 SSH 上传的本地源码包：

```bash
DSH_HOST_PACKAGE=/tmp/dsh-host-0.1.0.tgz sh ./scripts/install.sh
```

Uploaded tarballs are copied into the private package store under a
content-addressed name. Rebuilding the same prerelease version therefore does
not accidentally reuse stale profile-lock data.

On PowerShell / 在 PowerShell 中：

```powershell
git clone git@github.com:Yan-Zero/dsh-host.git
Set-Location dsh-host
pnpm install
pnpm build
dsh plugin --profile host add (Get-Location).Path
dsh --profile host
```

## Files / 文件

The default instance uses `$DSH_HOME/host/default/`:

- `identity`: stable Backend identity;
- `connection-token`: persistent secret, mode `0600` where supported;
- `endpoint.json`: current generation, PID, loopback port, and token-file path.
- `supervisor.log`: detached supervisor output and startup failures.
- `$DSH_HOME/host/registry/<instance>.json`: per-user live-instance discovery.

默认实例使用 `$DSH_HOME/host/default/`：`identity` 是稳定后端身份，
`connection-token` 是持久连接凭据，`endpoint.json` 描述当前进程和端口。

## Security / 安全

The Host only accepts `127.0.0.1`. Do not publish its port directly. Read the
endpoint and token over SSH, then use SSH local forwarding. Authentication can
be supplied as `X-DSH-Host-Token`, `Authorization: Bearer`, or `?tkn=` (needed
by WebSocket clients that cannot set custom headers).

Host 只监听 `127.0.0.1`，不要直接把端口暴露到公网。应通过 SSH 读取发现文件
和 token，再建立本地端口转发。请求可使用 `X-DSH-Host-Token`、Bearer 或
WebSocket 兼容的 `?tkn=`。

After forwarding, clients can verify the negotiated carrier with
`GET /dsh-host/protocol`. RPC uses `POST /api/<method>`; both event channels
support SSE and WebSocket on their respective `/api/events.*` paths.

建立转发后，客户端可通过 `GET /dsh-host/protocol` 校验协议。RPC 使用
`POST /api/<method>`，两条 `/api/events.*` 事件通道同时支持 SSE 与 WebSocket。

An externally managed secret can be selected with an absolute path:

```bash
dsh --profile host --connection-token-file /run/secrets/dsh-host-token
```

## Foreground / 前台运行

For systemd, launchd, Windows Services, containers, or debugging, let the
external manager own persistence:

```bash
dsh --profile host --foreground --instance default
```

The process prints one machine-readable `DSH_HOST_READY {...}` line after the
full Host API and event transport are mounted.

Detached startup waits for the same readiness barrier before returning. Slow
hosts can raise the default three-minute limit with `--startup-timeout`.
