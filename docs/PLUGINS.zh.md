# Host 插件契约

Host 插件就是安装并组合在远端 `host` profile 中的普通 DeepSeek Harness 插件。
`dsh-host` 不加载客户端插件，也不会复制客户端的插件清单。

## 安装到执行 profile

```bash
dsh plugin --profile host add <package>
dsh plugin --profile host install
```

`$DSH_HOME/profiles/host/` 中的 profile 负责依赖解析、bundle 顺序、配置和热重载。
运行时 Loader 的 `ctx.baseUrl` 锚定该 profile 目录。插件应当分别使用：

- 自己的 `import.meta.url` 定位包内资源；
- Harness home-path service 定位 Harness 共享状态；
- 收到命令的 agent/session 定位当前项目工作区。

`process.cwd()` 不是工作区契约。除非协议明确定义，否则客户端路径在远端 Host
中没有意义。

## 命令只注册一次

可执行的斜杠命令必须注册到 `@deepseek-ai/dsh-commands`，且注册过程不得依赖
`tuiWorkspaces`、命令树、浏览器或其他前端 service：

```ts
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  ctx.inject(['commands'], commandCtx => commandCtx.commands.register({
    name: 'example',
    description: '运行示例',
    input: { hint: '[value]' },
    handler: async ({ agent, rawInput, signal }) => {
      signal.throwIfAborted()
      // 从远端 agent/session 解析项目，不能使用 process.cwd()。
      return { kind: 'success', text: `收到：${rawInput}` }
    },
  }))
}
```

插件可以在相应前端 service 存在时另行注册补全树。补全信息可以增强 UI，但不能
决定命令是否存在。

## 作用域与执行权

命令目录针对已经接入的远端 agent 解析。agent-scoped 注册可以沿用 Harness 的
正常作用域规则覆盖全局注册。对于远端 session，远端命令目录是唯一权威来源：

- 客户端保留自己的内置导航命令；
- 客户端显示 Host 返回的插件命令；
- 客户端不得把本机安装的插件命令混入远端 session；
- Host 没有声明 capability 时，应视为不支持远端插件命令，不能回退到本机执行。

命令处理器在 Host 上运行，使用远端 profile 的配置、凭据、文件系统、工具和进程
环境。需要客户端配合的交互行为必须有明确的协议 capability，不能静默改到本机执行。
