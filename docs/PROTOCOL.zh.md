# dsh-host 协议 v1

这是 `dsh-host` 面向客户端的公开、UI 中性连接契约。终端、桌面应用、daemon
或浏览器适配器都可以接入；Host 不需要安装任何特定 UI。

## 发现与认证

SSH 侧安装器或连接器读取 Host endpoint 文件、转发其 loopback 端口，然后请求
`GET /dsh-host/protocol`。所有 HTTP 请求与 WebSocket upgrade 必须使用以下一种
认证方式：

- `Authorization: Bearer <connection-token>`
- `X-DSH-Host-Token: <connection-token>`

客户端必须检查 `protocolVersion` 和 `capabilities`，不能用 npm 包版本代替协议
协商。未知 capability 应被忽略；未公布 capability 的可选操作不得调用。

## RPC

Harness 核心方法使用 `POST /api/<method>` 与标准 Harness RPC envelope。扩展方法
使用 `POST /api/<namespace>/<method>`：

```json
{
  "type": "client-request",
  "rpcId": "unique-id",
  "method": "control/commandCatalog",
  "payload": { "args": { "sessionId": "session-id" } }
}
```

返回值是标准 `server-response`。HTTP 请求成功不代表操作成功，客户端还必须检查
`result.ok`。

## 事件

`/api/events.mux` 与 `/api/events.host` 是需要认证、仅下行的 WebSocket。每条消息
都是标准 Harness `server-request` frame；所有修改操作仍通过 RPC 发出。

## 插件命令

capability `dsh.commands.catalog.v1` 提供
`control/commandCatalog({ sessionId })`。`dsh-host/control` 导出了对应的常量和
TypeScript 请求/返回类型。该方法返回远端 agent 的有效命令目录：

```json
{
  "commands": [
    { "name": "example", "description": "运行示例", "input": { "hint": "[value]" } }
  ]
}
```

命令仍通过普通 session prompt API 发送斜杠命令文本，由远端命令注册表判断并
执行。客户端不得回退执行本地同名插件命令。插件侧约定见
[PLUGINS.zh.md](./PLUGINS.zh.md)。

## 兼容性

协议 v1 的新增能力必须通过 capability 声明。删除或改变现有字段、endpoint 或
capability 的含义，需要发布新的协议或 capability 版本。错误文本只用于诊断，
不是稳定的机器接口。
