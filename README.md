# OpenCode Remote

OpenCode Remote 是一个面向 VS Code 的远端 `opencode serve` 客户端扩展。它把 VS Code 里的本地代码上下文整理后发送给远端 OpenCode 服务，用于聊天、代码解释、重构建议和 inline completion，同时保留原 OpenCode 扩展里的本地终端命令。

这个项目适合下面的场景：

- OpenCode 运行在远端机器、容器、内网服务器或统一代理节点上。
- 代码仍然在本地 VS Code 中编辑，不希望远端服务直接读取本机文件系统。
- 需要把当前文件、选区、诊断、git diff 或明确引用的文件作为上下文发送给远端模型。
- 希望在 VS Code 里获得 OpenCode 聊天和自动补全能力。

## 核心功能

- 连接远端 `opencode serve`，支持 HTTP Basic Auth。
- 在 Activity Bar 中提供 OpenCode 聊天视图。
- 支持远端 session、模型、agent 的选择和管理。
- 自动收集本地 VS Code 上下文：当前文件、选区、诊断、可选 git diff、`@` 引用文件和手动附加文件。
- 可选本地 C/C++ code graph：插件内置轻量索引，不需要用户手动安装 `cgc`、Python 或数据库。
- 默认启用 local-only guard，提醒远端模型只使用 VS Code 提供的本地上下文。
- 可选 strict local-only agent，把远端请求绑定到一个禁用文件系统工具的 OpenCode agent。
- 支持远端 inline completion，包含 reasoning 清洗、当前词替换、语言感知缩进、接受后局部格式化和可诊断日志。
- 聊天历史默认只显示本插件创建的聊天 session，隐藏 inline completion session 和外部 OpenCode session，不删除远端历史数据。
- 保留原 OpenCode 终端命令：打开 opencode、在新终端打开 opencode、向终端插入当前文件路径。

## 工作方式

OpenCode Remote 不让远端 OpenCode 直接读取本地文件。扩展在 VS Code extension host 中收集上下文，然后把整理后的文本发送给远端服务。

一次聊天请求通常由这些部分组成：

- `User question:` 用户输入的问题。
- `Local Context Contract:` local-only 提示，要求远端只使用随请求提供的本地上下文。
- `Local workspace context:` 当前文件、选区、`@` 文件、附加文件、诊断和可选 git diff。
- `Local code graph context:` 可选本地 C/C++ 图检索结果，例如命中符号、调用者、被调用者、include 关系和少量证据片段。

如果问题明显是在询问本地文件，但扩展没有捕获到可用文件内容，local-only guard 会阻止发送或给出警告，避免远端服务去读自己的服务器文件系统。

## 本地 Code Graph

本地 code graph 面向 C/C++ 固件仓库。默认打开 workspace 后会自动在后台建立索引；如果关闭 `opencode.remote.codeGraph.enabled`，则不会自动索引。索引会在 VS Code extension host 中扫描 `.c`、`.h`、`.cc`、`.cpp`、`.hpp` 等文件，提取 include、宏、函数定义和函数调用关系。索引保存在 VS Code 的扩展 storage 中，不写入代码仓库。

聊天时不会把整仓符号表或整仓源码塞进 prompt。扩展会根据问题动态检索：

- 问“谁调用了 X”时，注入 X 的定义、调用者和关键调用点片段。
- 问“X 到 Y 的调用链”时，注入候选调用链和链路节点片段。
- 问影响范围时，注入调用者、被调用者、相关 include 和模块线索。
- 问架构概览时，注入目录/模块聚合摘要和热点符号。
- 问状态机时，注入 `state -> transition -> guard/action -> evidence` 表、Mermaid/DOT 图和状态路径候选。
- 问模块/子模块功能流程时，注入函数级、文件级、目录/模块级、子系统级摘要，以及经过预算控制的 evidence pack。

这个能力是轻量静态分析，不做完整宏展开或编译器级类型解析。如果仓库有复杂条件编译，回答会把 code graph 结果作为辅助证据，而不是替代真实编译。

### Local Analysis Bridge 与 Code Intelligence

扩展启动后会在 `127.0.0.1` 随机端口启动一个 token 保护的 Local Analysis Bridge，并在当前 workspace 的 `.opencode/tools/opencode_local_analysis.ts` 生成 OpenCode custom tool。这个工具只调用本机分析 API，不访问公网，也不允许任意文件系统工具绕过 VS Code 提供的 evidence。

Bridge 暴露这些受控分析操作：`search`、`getFileSlice`、`getSymbol`、`getCallers`、`getCallees`、`getCallChain`、`getModuleMap`、`getStateMachines`、`getStatePath`、`queryEvidence`。每次工具调用都会记录审计信息：tool name、参数摘要、evidence 数、耗时、是否被策略阻断。

聊天面板中本地 code graph ready 后可点击 `Intel` 打开 Code Intelligence 面板，查看模块摘要、状态机、transition table、confidence，并从 evidence 跳转到源码行。

### Large Repository Analysis v0

The local code graph now exposes a `LocalAnalysisService`-style protocol for
large repositories. Full indexing, incremental indexing, recovery, query, and
benchmark work are tracked as queued jobs with `disabled`,
`indexingFull`, `indexingIncremental`, `ready`, `degraded`, `paused`,
`recovering`, `rescanScheduled`, and `error` states. Status includes progress,
active shard, queue length, error count, recent state transitions, schema
version, worker thread health, cache metrics, and memory budget state.

Indexes are still stored locally in VS Code global storage, but the sharded JSON
manifest now carries a SQLite-compatible schema contract for future backends:
`files`, `symbols`, `edges`, `postings`, `modules`, `state_machines`,
`summaries`, `snapshots`, and `schema_version`. The current backend is reported
as `json-sharded-sqlite-compatible`, so the runtime remains dependency-light
while preserving a stable migration target for a true SQLite daemon.

Fast parsing can run through a Node worker-thread pool controlled by
`opencode.remote.codeGraph.workerConcurrency`; AST mode keeps using the main
extension process because it needs VSIX-local WASM grammars. Watcher storms are
coalesced into one scheduled rescan after
`opencode.remote.codeGraph.watcherRescanThreshold` events. Indexing can be
paused, resumed, or cancelled from commands or the Code Intelligence UI.

For large benchmarks above 100k files, the benchmark switches to
`streaming-sharded` mode: it parses every synthetic file, records shard and
schema metrics, and lazily loads only query-relevant shards. This exercises the
large-repo memory model without keeping a million parsed files in the extension
host at once.

For scale checks, run:

```bash
bun run benchmark:codegraph -- --files=1000
```

The report includes file count, LOC, language mix, benchmark mode, module
count, average file size, call edges, symbols, parse/index time, throughput,
peak heap, index bytes, shard count, query P50/P95/P99, incremental update
time, and recovery time.

## 安装与连接

先在目标机器上启动 OpenCode 服务：

```bash
opencode serve
```

然后在 VS Code 中连接：

1. 打开 OpenCode Activity Bar 视图，或运行命令 `OpenCode Remote: Connect to Remote OpenCode`。
2. 输入远端服务地址，例如 `http://localhost:4096` 或 `https://opencode.example.com`。
3. 输入 Basic Auth 用户名。
4. 输入 Basic Auth 密码。密码会保存在 VS Code SecretStorage 中。
5. 使用 `OpenCode Remote: Test Remote OpenCode Connection` 检查连接状态。

连接成功后，状态栏会显示 `OpenCode: Connected`，聊天视图会从远端加载可用 session、provider/model 和 agent 信息。

## 聊天使用

聊天视图支持这些常用操作：

- 直接输入问题并发送给远端 OpenCode。
- 勾选 `Current file`，把当前编辑器文件加入上下文。
- 勾选 `Selection`，把当前选区加入上下文。
- 勾选 `Diagnostics`，把 VS Code diagnostics 加入上下文。
- 勾选 `Git diff`，把当前 workspace 的 git diff 加入上下文。
- 在输入框中使用 `@` 引用额外文件。
- 点击 `Attach` 手动附加本地文件到后续上下文。
- 点击 `Refresh` 刷新当前文件和上下文状态。
- 使用 `New Remote OpenCode Session` 创建新的插件聊天 session。

会话历史会过滤掉非本插件创建的远端 session。这样即使远端 OpenCode 还保存着其他工具、后台任务或 inline completion 产生的历史记录，VS Code 侧聊天列表也只显示 `VS Code chat` 类型的插件聊天。

## Inline Completion

inline completion 默认关闭。开启后，扩展会在编辑器中注册 VS Code inline completion provider，并把光标附近代码窗口发送给远端 OpenCode。

启用方式：

```json
{
  "opencode.remote.completion.enabled": true
}
```

补全逻辑包含几层保护和格式化：

- 只使用 OpenCode 返回的可见 assistant text，丢弃 reasoning parts 和 `<think>...</think>`。
- 遇到明显 prompt 泄漏或 plan-mode 元文本时返回空补全，避免把内部推理插入代码。
- 对当前词使用显式 replace range，例如 `whil|` 可以替换成完整 `while (...) { ... }`。
- 对模型返回的整行补全做前缀对齐，例如 `void simulate|` 加上远端返回的 `void simulate_cpu_worker(...)` 时，只插入剩余后缀。
- 对 C/C++、JavaScript、TypeScript、Go、Rust、C# 等 brace language 做轻量语言感知缩进。
- 对 C/C++ 预处理指令处理 `#if/#else/#endif` 对齐。
- 接受补全后会尝试对刚插入的小范围调用 VS Code range formatter；没有 formatter 时安全跳过。
- 使用独立的 inline completion session，并在聊天历史中隐藏。

补全日志写入 `OpenCode Remote` output channel。`opencode.remote.completion.logLevel` 为 `info` 时会看到生命周期日志：

- `triggered`：VS Code 触发了补全 provider。
- `scheduled`：请求进入 debounce 调度。
- `reuse-pending`：同一位置复用已有 pending 请求。
- `sent`：已经向远端 OpenCode 发送请求。
- `received`：远端响应已返回。
- `empty`：远端没有可展示文本，或被 safety guard 过滤。
- `edit-ready`：已经构造出 VS Code 可展示的 completion edit。
- `returned`：provider 已把 item 返回给 VS Code。
- `cancelled`：请求被新位置、stale key 或 VS Code token 取消。

如果日志里已经出现 `returned` 但编辑器没有 ghost text，优先检查 `range`、`filterText` 和当前行输入是否匹配；debug 日志会输出更详细的 range 和首行摘要。

## 配置项

这些配置都可以在 VS Code settings JSON 中设置。

| Setting | Default | 说明 |
| --- | --- | --- |
| `opencode.remote.serverUrl` | `http://localhost:4096` | 远端 `opencode serve` base URL。 |
| `opencode.remote.username` | `opencode` | HTTP Basic Auth 用户名。 |
| `opencode.remote.defaultModel` | `""` | 可选默认模型，格式为 `provider/model`；为空时使用服务器默认。 |
| `opencode.remote.defaultAgent` | `""` | local-only 模式关闭时可选的默认 agent 名称。 |
| `opencode.remote.localOnlyAgent` | `vscode-local` | VS Code 本地代码理解必须使用的远端 agent 名称；聊天和补全都会发送该 agent。 |
| `opencode.remote.context.maxFileBytes` | `16000` | 每个本地文件最多加入的文本字节数。 |
| `opencode.remote.context.maxFiles` | `8` | 单次请求最多加入的本地文件数量。 |
| `opencode.remote.context.includeDiagnostics` | `true` | 默认是否加入 VS Code diagnostics。 |
| `opencode.remote.context.includeGitDiff` | `false` | 默认是否加入 git diff。 |
| `opencode.remote.context.localOnlyMode` | `true` | 是否启用 local-only guard。 |
| `opencode.remote.context.strictLocalOnlyAgent` | `true` | 兼容旧配置项；local-only 模式现在总是强制使用 `opencode.remote.localOnlyAgent`，找不到时会阻止请求。 |
| `opencode.remote.completion.enabled` | `false` | 是否启用远端 inline completion。 |
| `opencode.remote.completion.debounceMs` | `350` | 请求 inline completion 前的 debounce 时间，单位毫秒。 |
| `opencode.remote.completion.logLevel` | `info` | 补全日志等级，可选 `off`、`info`、`debug`。 |
| `opencode.remote.codeGraph.enabled` | `true` | 是否自动启用本地 C/C++ code graph。关闭后不会自动索引。 |
| `opencode.remote.codeGraph.promptOnWorkspaceOpen` | `true` | 旧版询问开关；当前默认自动索引，保留用于兼容已有配置。 |
| `opencode.remote.codeGraph.analysisMode` | `auto` | code graph 分析模式；`auto` 会优先使用随 VSIX 单包内置的 Tree-sitter WASM AST 分析，失败时降级为 fast。 |
| `opencode.remote.codeGraph.maxFiles` | `50000` | 最多索引的 C/C++ 文件数量。 |
| `opencode.remote.codeGraph.maxContextBytes` | `24000` | 单次请求最多注入的 code graph 上下文字节数。 |
| `opencode.remote.codeGraph.maxDeepFiles` | `24` | 预留给深度机制/状态机分析的候选文件上限。 |
| `opencode.remote.codeGraph.maxStateTransitions` | `120` | 预留给状态机证据的转移数量上限。 |
| `opencode.remote.codeGraph.watcherRescanThreshold` | `750` | watcher 队列达到该数量后合并为一次 scheduled rescan。 |
| `opencode.remote.codeGraph.workerConcurrency` | `4` | 本地分析 worker batch 和 benchmark planning 的目标并发。 |
| `opencode.remote.codeGraph.queryCacheSize` | `80` | 本地 code graph 热查询上下文缓存数量。 |
| `opencode.remote.codeGraph.memoryLimitMb` | `4096` | 本地 code graph 的软堆内存预算，超过后清理热缓存并标记 degraded。 |
| `opencode.remote.codeGraph.compileCommandsPath` | `""` | 可选 `compile_commands.json` 路径，后续 semantic 分析使用。 |
| `opencode.remote.codeGraph.clangdPath` | `""` | 可选 workspace host 上的 `clangd` 路径，后续 semantic 分析使用。 |
| `opencode.remote.codeGraph.scipClangPath` | `""` | 可选 workspace host 上的 `scip-clang` 路径，后续 semantic 分析使用。 |
| `opencode.remote.codeGraph.excludeGlobs` | `[]` | 本地 code graph 额外排除规则。 |
| `opencode.remote.analysis.bridge.enabled` | `true` | 启动 localhost-only Analysis Tool Bridge，并生成 OpenCode custom tool。 |
| `opencode.remote.analysis.maxEvidenceItems` | `40` | 单次 analysis tool 或 evidence pack 最多返回的证据条目数。 |
| `opencode.remote.analysis.maxEvidenceBytes` | `60000` | 单次 analysis tool 或 evidence pack 最多返回的证据字节数。 |
| `opencode.remote.analysis.maxFileSliceBytes` | `16000` | 单次本地文件片段查询最多返回的字节数。 |
| `opencode.remote.analysis.maxGraphEdges` | `120` | 调用图和状态机查询最多返回的边数。 |
| `opencode.remote.analysis.maxPaths` | `10` | 状态路径或调用路径最多返回的路径数。 |

### VS Code Local Agent 示例

VS Code 本地代码理解必须在远端 OpenCode 配置一个名为 `vscode-local` 的 agent。插件连接后会通过 `/agent` 拉取远端 agent 列表，只高亮并使用 `vscode-local`；其他 agent 只展示为不可选。若远端没有 `vscode-local`，或 agent 列表加载失败，聊天和 inline completion 都会 fail closed，不会回落到远端默认 agent。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "vscode-local": {
      "description": "Answer VS Code remote-extension questions only from prompt-supplied local context.",
      "mode": "primary",
      "permission": {
        "read": "deny",
        "glob": "deny",
        "grep": "deny",
        "list": "deny",
        "bash": "deny",
        "edit": "deny",
        "task": "deny",
        "external_directory": "deny",
        "lsp": "deny",
        "skill": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "opencode_local_analysis": "allow"
      }
    }
  }
}
```

这个 agent 应只根据插件注入的 VS Code 本地上下文、diagnostics、git diff、本地 code graph evidence 和 `opencode_local_analysis` 结果回答；不要允许它读取或修改远端 OpenCode server 文件系统。扩展也会生成 `.opencode/vscode-local-agent-policy.template.json` 作为离线权限模板。

## 命令与快捷键

| Command | 说明 |
| --- | --- |
| `OpenCode Remote: Connect to Remote OpenCode` | 连接远端 OpenCode。 |
| `OpenCode Remote: Disconnect Remote OpenCode` | 断开当前连接。 |
| `OpenCode Remote: Test Remote OpenCode Connection` | 测试当前连接配置。 |
| `OpenCode Remote: Open Remote OpenCode Chat` | 打开聊天视图。 |
| `OpenCode Remote: New Remote OpenCode Session` | 创建新的插件聊天 session。 |
| `OpenCode Remote: Ask OpenCode About Selection` | 用当前选区作为上下文快速提问。 |
| `OpenCode Remote: Ask OpenCode About Current File` | 用当前文件作为上下文快速提问。 |
| `OpenCode Remote: Add File to OpenCode Context` | 把当前文件或选择的文件附加到聊天上下文。 |
| `OpenCode Remote: Clear OpenCode Context` | 清空已附加的上下文文件。 |
| `OpenCode Remote: Index Local Code Graph` | 建立或增量刷新本地 C/C++ code graph。 |
| `OpenCode Remote: Rebuild Local Code Graph` | 强制重建本地 C/C++ code graph。 |
| `OpenCode Remote: Pause Local Code Graph Indexing` | 暂停正在排队或执行的本地 code graph 索引任务。 |
| `OpenCode Remote: Resume Local Code Graph Indexing` | 恢复暂停的本地 code graph 索引任务。 |
| `OpenCode Remote: Cancel Local Code Graph Indexing` | 取消当前和排队中的本地 code graph 索引任务。 |
| `OpenCode Remote: Run Local Code Graph Benchmark` | 运行 synthetic repo benchmark，并把报告写入 output channel。 |
| `OpenCode Remote: Show Local Code Graph Status` | 查看本地 code graph 索引状态。 |
| `OpenCode: Open opencode` | 在终端中打开 opencode。 |
| `OpenCode: Open opencode in new tab` | 在新终端标签中打开 opencode。 |
| `OpenCode: Add Filepath to Terminal` | 向终端插入当前文件路径。 |

默认快捷键：

| 快捷键 | 命令 |
| --- | --- |
| `Ctrl+Escape` / `Cmd+Escape` | `opencode.openTerminal` |
| `Ctrl+Shift+Escape` / `Cmd+Shift+Escape` | `opencode.openNewTerminal` |
| `Ctrl+Alt+K` / `Cmd+Alt+K` | `opencode.addFilepathToTerminal` |

## 本地开发

安装依赖：

```bash
bun install
```

常用开发命令：

```bash
bun run compile
bun test
bun run benchmark:codegraph -- --files=1000
bun run package
```

`bun run package` 是提交或交付前必须运行的最终验证步骤。它会执行 type checking、linting 和 TypeScript compilation。

在 VS Code 中按 `F5` 可以启动 Extension Development Host。

## 本地打包安装

生成本地 VSIX：

```bash
bun run vsix
```

然后在 VS Code 中安装生成的 `opencode-remote-<version>.vsix`，或使用命令行：

```bash
code --uninstall-extension local.opencode-remote
code --install-extension opencode-remote-<version>.vsix
```

安装后建议运行 `Developer: Reload Window`。

如果仓库根目录已经存在 `opencode-remote-*.vsix`，再次生成本地 VSIX 前应先递增 `package.json` 的 patch version，避免 VS Code 继续使用旧版本缓存。

## 常见问题

### 连接失败

先确认远端 `opencode serve` 正在运行，并检查 `opencode.remote.serverUrl` 是否包含正确协议、域名和端口。连接测试超时会在 `OpenCode Remote` output channel 中显示 timeout 信息。

### 认证失败

确认 `opencode.remote.username` 和保存到 VS Code SecretStorage 的密码正确。可以重新运行 `OpenCode Remote: Connect to Remote OpenCode` 覆盖连接配置。

### 聊天提示没有捕获当前文件

确认编辑器中打开的是 `file` scheme 的本地文件，并且聊天视图里的 `Current file` 已勾选。如果是临时 buffer、远端虚拟文档或未打开文件，扩展可能无法收集文件内容。

### 问本地文件时被阻止

这是 local-only guard 的预期行为。请打开目标文件，或在聊天框中使用 `@` 引用文件，再重新发送问题。

### 聊天历史里看不到某些远端 session

扩展只显示自己创建的 `VS Code chat` session。外部 OpenCode 工具 session、后台任务 session 和 inline completion session 会被隐藏，但不会从远端删除。

### Inline completion 没有出现

先确认：

- `opencode.remote.completion.enabled` 已开启。
- 远端连接处于 connected 状态。
- 当前文档是本地文件。
- output channel 中能看到 `[completion] triggered`、`sent`、`received` 或 `returned`。

如果只有 `triggered`，可能还在 debounce 或被 VS Code token 取消。如果有 `received` 但没有 `edit-ready`，通常是远端返回空文本、reasoning 被清洗后为空，或 completion edit 被安全规则拒绝。如果有 `returned` 但没有 ghost text，可以把 `opencode.remote.completion.logLevel` 改成 `debug`，查看 range、filterText 和首行摘要。

### Inline completion 缩进不符合预期

扩展会根据当前文件附近代码、编辑器 tab 设置和语言 profile 做预格式化，接受后再尝试调用 VS Code range formatter。最终格式仍然依赖当前语言的 formatter provider；如果项目没有安装对应 formatter，接受后的格式化命令会安全跳过。

## License

MIT
