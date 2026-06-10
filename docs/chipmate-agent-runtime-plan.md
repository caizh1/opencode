# ChipMate Agent Runtime 重构方案

这份文档记录把当前 VS Code 插件从 `opencode serve` 客户端彻底重构为 ChipMate 的产品与工程方案。目标是一步到位剥离 opencode 运行时、命名、session、agent 和 storage，同时保留现有 QA 与 inline completion 的核心能力。

本文面向维护者和开发者，用来约束后续实现范围。真正开工时应按阶段拆分 PR，避免把 QA evidence、completion pipeline、UI 改名和 agent runtime 混在一个不可审查的大改里。

## 已确认决策

- 新插件名为 `ChipMate`，extension id 建议为 `local.chipmate`，`name` 为 `chipmate`。
- 完全删除 opencode 运行时依赖，不再连接 `opencode serve`，不迁移旧 session、旧 RAG/codegraph storage、旧 SecretStorage。
- 可以接受卸载旧扩展后安装新 VSIX；不保留旧 `OpenCode Remote` 身份。
- 运行时跟随 VS Code workspace extension host。Remote SSH / Dev Container 场景下，模型、storage、RAG、MCP stdio、skill 脚本都从远程 Linux host 视角运行。
- 第一版 provider 只做 OpenAI-compatible。
- Chat provider 支持 streaming，失败或 endpoint 不支持时 fallback 到非 streaming。
- 工具执行只接受标准 OpenAI-compatible `tool_calls`；不解析 ReAct、JSON 代码块、`<tool_call>` 这类文本伪协议。
- MCP v1 只支持 `stdio`。
- Skills 是重点能力，按 Agent Skills open standard 组织：一个目录、入口 `SKILL.md`、可选 `scripts/`、`references/`、`assets/`。
- Skills 和 MCP 不预置在 VSIX。插件从离线内网 HTTP 服务区读取静态 `catalog.json`，下载 zip 包并校验 sha256。
- 包用户级安装，workspace 级启用。多个 workspace 可复用同一 workspace host 上已下载包。
- 支持手动更新和切回旧版本，不做自动更新。
- Catalog 支持 optional `dependencies` 字段；无依赖声明也可安装。
- 写文件和 shell 必须支持，但由 workspace 权限 profile 控制。
- `Full Access` 下普通操作免确认，但保留少量硬保护和完整审计。
- 旧 opencode terminal 命令不保留。
- UI 沿用现有 Liquid Glass 风格，ChipMate Activity Bar 下分 `Chat`、`Skills`、`Index` 三个视图。

## 非目标

- 不重写 QA prompt/context/evidence 策略。
- 不重写 completion planner、retrieval、router、Qwen FIM prompt、postprocess、InlineEditBuilder 或质量门禁。
- 不做 OpenAI 之外的 provider。
- 不做 MCP Streamable HTTP 或旧 SSE transport。
- 不做 Git-based marketplace、登录、账号系统或动态 registry。
- 不执行包的 install/postinstall 脚本。
- 不自动安装 catalog dependencies。
- 不把 skills/MCP 包写进用户源码仓库。
- 不迁移旧 `opencode.remote.*` 配置、SecretStorage、session、RAG/codegraph index。

## 当前依赖边界

现有实现里，QA 与 completion 的核心能力主要已经在 VS Code 插件本地：

| 能力 | 当前位置 | 重构策略 |
| --- | --- | --- |
| QA context、selection、@file、diagnostics、git diff | `src/context.ts`、`src/chat-view.ts` | 保留策略，发送目标改为 AgentRuntime |
| QA codegraph/RAG evidence | `src/context.ts`、`src/repository-evidence.ts`、`src/codegraph-service.ts` | 保留策略，storage namespace 重建 |
| Completion planner/retrieval/postprocess/edit validation | `src/completion*.ts` | 保留 pipeline，删除 opencode provider 分支 |
| Direct completion OpenAI-compatible client | `src/completion-model-client.ts` | 泛化为 completion provider client，继续支持 coder/FIM |
| Chat session/history/SSE/abort | `src/chat-view.ts`、`src/remote-client.ts` | 用本地 session store + AgentRuntime 替换 |
| 远端 model/agent 列表 | `src/remote-client.ts`、`src/local-agent.ts` | 删除 agent 概念，新增 provider/model 配置 UI |
| `.opencode/tools` analysis bridge | `src/analysis-bridge.ts`、`src/analysis-tool-template.ts` | 删除 opencode custom tool 生成，能力改为内置 runtime tool |
| opencode terminal 命令 | `src/local-terminal.ts`、`package.json` | 删除 |

## 新模块边界

建议分出这些新模块，避免继续让 `chat-view.ts` 承担过多 runtime 职责。

| 模块 | 职责 |
| --- | --- |
| `src/agent-runtime.ts` | 单轮/多轮 agent loop、tool_calls 调度、stream event 聚合、abort |
| `src/openai-chat-client.ts` | OpenAI-compatible chat completions，streaming SSE 和 non-stream fallback |
| `src/chat-session-store.ts` | workspace 本地 session/history/tool audit 持久化 |
| `src/tool-registry.ts` | 内置工具、skill tools、MCP tools 的统一注册与权限检查 |
| `src/permissions.ts` | workspace permission profile、approval prompt、硬保护、审计 |
| `src/skills-catalog.ts` | HTTP catalog 拉取、zip 下载、sha256 校验、安装/更新 |
| `src/skills-runtime.ts` | Agent Skills 发现、`SKILL.md` frontmatter 解析、资源读取、脚本运行 |
| `src/mcp-stdio.ts` | stdio MCP server 启动、tools/list、tools/call、进程生命周期 |
| `src/chipmate-settings.ts` | 新 settings namespace 读取与校验 |
| `src/chipmate-chat-view.ts` | Chat webview state 和用户交互，不直接跑 agent loop |
| `src/chipmate-skills-view.ts` | Catalog、安装、更新、启用、权限摘要 |
| `src/chipmate-index-view.ts` | Codegraph/RAG 状态、重建、暂停、恢复、配置 |

## Settings Namespace

新配置使用 `chipmate.*`。旧 `opencode.remote.*` 不迁移，可在激活时检测到旧配置后提示用户重新配置。

示例：

```json
{
  "chipmate.chat.apiBaseUrl": "http://127.0.0.1:8000/v1",
  "chipmate.chat.model": "Qwen/Qwen3.6-27B",
  "chipmate.chat.temperature": 0.2,
  "chipmate.chat.maxTokens": 4096,
  "chipmate.chat.streaming": true,

  "chipmate.completion.enabled": true,
  "chipmate.completion.apiBaseUrl": "http://127.0.0.1:8000/v1",
  "chipmate.completion.model": "qwen-coder",
  "chipmate.completion.profile": "qwen-coder-fim",
  "chipmate.completion.maxTokens": 128,
  "chipmate.completion.temperature": 0,
  "chipmate.completion.topP": 1,

  "chipmate.catalog.url": "http://intranet-chipmate-assets/catalog.json",
  "chipmate.permissions.profile": "askApproval",

  "chipmate.codeGraph.enabled": true,
  "chipmate.rag.embedding.endpoint": "",
  "chipmate.rag.embedding.model": "",
  "chipmate.rag.rerank.endpoint": "",
  "chipmate.rag.rerank.model": ""
}
```

Secrets 使用新 key，例如：

- `chipmate.chat.apiKey`
- `chipmate.completion.apiKey`
- `chipmate.rag.apiKey`

## Storage Model

所有 storage 都从新 extension id 重新开始。

| 数据 | 存放粒度 | 说明 |
| --- | --- | --- |
| 已下载 skill/MCP 包 | globalStorage | 按 package id/version 存储，同一 workspace host 复用 |
| workspace 启用列表 | workspaceState 或 workspace storage | 记录启用的 skill/MCP 及版本 |
| chat sessions | workspace storage | 本 workspace 的 session/message/tool audit |
| codegraph/RAG index | workspace/global storage 中的新 namespace | 不读旧 opencode index |
| permissions profile | workspaceState | 每个 workspace 单独选择 |
| tool approval history | workspaceState | 首次 script、MCP server、shell 命令确认记录 |

Remote Linux 场景下，上述路径都在远程 extension host。

## Agent Runtime

AgentRuntime 接收 `buildChatPrompt()` 的输出，并负责发送给 OpenAI-compatible chat provider。

普通无工具 QA 的路径应保持轻：

```text
Chat UI
  -> buildChatPrompt()
  -> AgentRuntime.run()
  -> OpenAIChatClient.chatCompletion(stream=true)
  -> local session store
  -> Chat UI stream events
```

启用 tool_calls 后：

```text
messages + enabled skills summary + enabled tools
  -> model stream
  -> assistant tool_calls
  -> ToolRegistry.authorize()
  -> execute internal / skill / MCP / shell tool
  -> append tool role messages
  -> continue model loop
  -> final assistant message
```

Loop 需要硬限制：

- 最大 tool round 数。
- 最大单次工具输出字节数。
- 最大 session context token 预算。
- 每个 request 的 AbortController 贯穿 HTTP request、child process、MCP call。
- 所有 tool call 写入审计日志。

## OpenAI-Compatible Provider

Chat 使用 `/v1/chat/completions`。

需要支持：

- `stream: true` SSE delta。
- non-stream fallback。
- `tools`、`tool_choice`、assistant `tool_calls`。
- tool role message 回灌。
- `reasoning_content` 或 provider 扩展字段的安全展示。
- Abort。
- request/response 错误归一化。

不做：

- 文本伪 tool call 解析。
- Provider-specific agent 协议。
- 服务端 session。

Completion 继续保留现有 direct coder 模型能力：

- `generic-chat` 走 `/chat/completions`。
- `qwen-coder-fim` 走 raw `/completions`。
- 普通代码、C/C++ embedded、函数体续写、top-level declaration 继续用 Qwen FIM。
- 自然语言命令、comment-to-test、comment-to-code 不走普通 FIM。
- 删除 `completion.provider = opencode`，保留 direct path。

## Skills Catalog

离线 HTTP 服务区是静态文件服务，不需要登录。

建议目录：

```text
http://intranet-chipmate-assets/
  catalog.json
  skills/
    embedded-c-review-1.0.0.zip
    qemu-debug-1.1.0.zip
  mcps/
    code-search-mcp-0.1.0.zip
```

`catalog.json` 示例：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-06-10T00:00:00Z",
  "packages": [
    {
      "id": "embedded-c-review",
      "type": "skill",
      "name": "Embedded C Review",
      "version": "1.0.0",
      "description": "Review embedded C changes for safety, register access, and RTOS constraints.",
      "downloadUrl": "skills/embedded-c-review-1.0.0.zip",
      "sha256": "<hex>",
      "sizeBytes": 12345,
      "permissions": {
        "readsWorkspace": true,
        "runsScripts": true,
        "writesWorkspace": false,
        "runsShell": false
      },
      "dependencies": [
        {
          "id": "code-search-mcp",
          "type": "mcp",
          "version": ">=0.1.0",
          "required": false
        }
      ]
    },
    {
      "id": "code-search-mcp",
      "type": "mcp",
      "name": "Code Search MCP",
      "version": "0.1.0",
      "description": "Expose repository search as MCP stdio tools.",
      "downloadUrl": "mcps/code-search-mcp-0.1.0.zip",
      "sha256": "<hex>",
      "sizeBytes": 56789,
      "permissions": {
        "readsWorkspace": true,
        "runsProcess": true
      }
    }
  ]
}
```

`dependencies` 是 optional。插件不从 `SKILL.md` 自动推断依赖，只可做 warning。

下载流程：

1. 拉取 catalog。
2. 展示包列表、版本、权限摘要、依赖提示。
3. 用户选择安装。
4. 下载 zip。
5. 校验 sha256。
6. 解压到 globalStorage package cache。
7. 读取包内 metadata，校验类型。
8. 当前 workspace 启用或保持仅安装。

更新流程：

- 用户手动刷新 catalog。
- UI 显示可更新版本。
- 下载新版本到新目录。
- 默认切换 workspace 启用版本。
- 保留旧版本，允许手动切回。

## Skills Runtime

Skill 包应符合 Agent Skills open standard。入口是 `SKILL.md`，可以包含：

- YAML frontmatter：`name`、`description`、可选 `compatibility`、`allowed-tools`。
- 正文：skill 使用说明。
- `scripts/`：可执行脚本。
- `references/`：按需读取的长文档。
- `assets/`、`templates/`：资源和模板。

Agent runtime 不在启动时把完整 skill 内容全部塞进模型。采用 progressive disclosure：

1. System/developer context 只注入已启用 skills 的 `name`、`description`。
2. 模型需要时调用 `skill.activate`，读取完整 `SKILL.md`。
3. 模型需要参考资料时调用 `skill.read_resource`。
4. 模型需要脚本时调用 `skill.run_script`。

内置 skill tools：

| Tool | 作用 | 权限 |
| --- | --- | --- |
| `skill.list` | 列出当前 workspace 已启用 skills | 只读 |
| `skill.activate` | 加载某个 skill 的完整 `SKILL.md` | 只读 |
| `skill.read_resource` | 读取 skill 包内 references/assets/templates | 只读，路径限制在包内 |
| `skill.run_script` | 执行 skill 包内脚本 | 受 permission profile 和首次脚本确认控制 |

脚本执行规则：

- 不执行 install/postinstall。
- 只允许包内已安装版本目录下的脚本。
- 首次运行具体脚本时弹 UI 展示命令、args、cwd、env key、权限摘要。
- 后续是否免确认由 workspace permission profile 和用户确认历史决定。
- 输出大小、运行时间和 cwd 受限制。
- 所有调用记录 audit。

## MCP Stdio V1

MCP 包是 zip，包内必须有 `mcp.json`。

示例：

```json
{
  "schemaVersion": 1,
  "name": "code-search-mcp",
  "transport": "stdio",
  "command": "node",
  "args": ["${packageRoot}/server.js"],
  "cwd": "${workspaceFolder}",
  "env": {
    "CHIPMATE_WORKSPACE": "${workspaceFolder}"
  },
  "permissions": {
    "readsWorkspace": true,
    "writesWorkspace": false,
    "runsShell": false
  }
}
```

规则：

- v1 只支持 `stdio`。
- 不自动安装依赖。
- command 可指向包内脚本或系统命令。
- 启动前 UI 展示 command、args、cwd、env keys。
- MCP tools/list 结果进入 ToolRegistry。
- tools/call 仍受 permission profile 控制。
- 进程按 workspace 管理，禁用时停止。

## 内置工具与权限

ChipMate v1 内置工具：

| Tool | 说明 |
| --- | --- |
| `workspace.search` | 搜索 workspace 文件或文本，受 exclude 和结果数限制 |
| `workspace.read_file` | 读取 workspace 内文件片段 |
| `workspace.write_file` | 写 workspace 文件，受权限控制 |
| `workspace.apply_patch` | 对 workspace 文件应用 patch，受权限控制 |
| `workspace.get_selection` | 当前文件、选区、光标上下文 |
| `workspace.get_diagnostics` | VS Code diagnostics |
| `codegraph.query_evidence` | 复用现有 codegraph/RAG evidence |
| `shell.run` | 在 workspace host 运行 shell 命令，受权限控制 |
| `skill.*` | skill 发现、激活、资源读取、脚本执行 |
| `mcp.*` | 已启用 MCP tools |

Permission profiles：

| Profile | 行为 |
| --- | --- |
| `readOnly` | 允许读文件、搜索、diagnostics、codegraph/RAG、skill 读取；禁止写文件和 shell |
| `askApproval` | 读操作自动允许；写文件、apply patch、shell、skill script、MCP 可执行工具弹确认 |
| `trustedWorkspace` | workspace 内写文件、已启用 skill script、已启用 MCP tool 可直接执行；shell 默认仍确认 |
| `fullAccess` | 普通写文件和 shell 免确认，但保留硬保护与审计 |

硬保护示例：

- 阻止明显删除系统根目录或 home 关键目录的命令。
- 阻止修改 SSH key、shell profile、系统 credential 目录，除非显式二次确认。
- 阻止 workspace 外写文件，除非 profile 允许并二次确认。
- 阻止读取或输出过大的敏感路径。

## UI 信息架构

Activity Bar 容器为 `ChipMate`，图标和控件沿用现有 Liquid Glass 风格。

### Chat 视图

负责：

- 对话 timeline。
- Composer 和上下文开关。
- 当前 chat provider/model 状态。
- 当前 permission profile chip。
- 已启用 skill/MCP 摘要。
- Stop/Cancel。
- Export Markdown/JSON。
- Tool call 状态和 audit 摘要。

删除：

- Remote OpenCode connection。
- Agent 列表。
- Remote sessions。
- Server tool warning。

### Skills 视图

负责：

- Catalog URL 与刷新状态。
- 包列表：未安装、已安装、可更新、已启用。
- Skill/MCP 详情：描述、版本、权限摘要、依赖、sha256、大小。
- 安装、更新、启用、禁用、切换版本。
- 首次 skill script / MCP command 确认历史。
- 下载与校验错误展示。

### Index 视图

负责：

- Codegraph 状态。
- RAG embedding/rerank 配置。
- 索引重建、暂停、恢复、取消。
- Query trace / readiness / storage namespace。
- 旧 storage 不迁移提示。

Completion 不单独占主视图。它作为编辑器内体验，在 settings 和 Chat 顶部状态中展示启用状态即可。

## QA/Completion 保护策略

第一阶段必须保证：

- `buildChatPrompt()` 的 prompt 结构不做策略性重写。
- `retrieveChatAnalysisEvidence()` 与 repository evidence orchestration 不做语义改造。
- Completion 的 planner/retrieval/router/postprocess/edit validation 不做行为改造。
- 只替换 transport：`RemoteOpenCodeClient.sendMessageAsync()` 变为 `AgentRuntime.run()`。
- 不需要工具时，QA 仍可走一次模型请求，避免 tool loop 改变回答风格。
- Completion 只删除 opencode provider 分支，直连 coder 模型路径保持。

回归测试应先锁住：

- QA prompt 中 selection/current file/@file/diagnostics/codegraph evidence 的组成。
- Local-only guard 在没有本地上下文时的 fail-closed 行为。
- Completion direct OpenAI-compatible URL、请求体、FIM/raw `/completions` 行为。
- Completion planner 场景矩阵和 edit acceptance semantics。

## 分阶段实施

### Phase 0：准备与命名切换

- 新建 ChipMate package metadata、命令 namespace、配置 namespace、view container。
- 删除旧 opencode terminal 命令。
- 新建 settings reader 和 SecretStorage key。
- 不迁移旧 storage。
- 加 manifest 测试覆盖新命名和旧命名删除。

### Phase 1：保行为替换 Chat Transport

- 新增 `OpenAIChatClient`。
- 新增 `ChatSessionStore`。
- 新增 `AgentRuntime` 最小无工具路径。
- `chat-view` 发送路径从 `RemoteOpenCodeClient` 替换为 AgentRuntime。
- 保留 `buildChatPrompt()` 和 QA evidence 策略。
- 支持 streaming + non-stream fallback + abort。

### Phase 2：Completion 去 opencode

- 删除 `CompletionProvider = "opencode"`。
- 删除 completion session 相关 opencode 代码。
- 保留 direct OpenAI-compatible completion path。
- 更新 docs/code-completion.md 的后端路径与 settings。
- 补测试确保 Qwen FIM/direct coder 行为不变。

### Phase 3：权限与内置工具

- 新增 permission profile。
- 新增 ToolRegistry。
- 实现 workspace read/search/write/apply_patch、shell、diagnostics、codegraph 工具。
- 加 approval UI 和 audit log。

### Phase 4：Skills Catalog 与 Runtime

- 实现 HTTP catalog 拉取。
- 实现 zip 下载、sha256 校验、安装、更新、切版本。
- 实现 Agent Skills 解析、progressive disclosure。
- 实现 `skill.activate`、`skill.read_resource`、`skill.run_script`。
- Skills 视图落地。

### Phase 5：MCP Stdio

- 实现 MCP package install metadata。
- 实现 stdio MCP client。
- tools/list 接入 ToolRegistry。
- tools/call 接入 permission profile 和 audit。

### Phase 6：Index 视图与收尾

- 将 codegraph/RAG UI 拆到 Index 视图。
- 更新 README 和 docs。
- 运行完整测试、package、VSIX。

## 测试地图

| 范围 | 建议测试 |
| --- | --- |
| Manifest | 新 extension id、commands、views、settings，无 opencode terminal 命令 |
| Settings | 新 namespace 默认值、旧配置不迁移、SecretStorage key |
| OpenAI chat client | streaming delta、tool_calls、non-stream fallback、错误、abort |
| Agent runtime | 无工具 QA、tool loop、max rounds、abort child process |
| Session store | 新建、切换、导出、tool audit、workspace 隔离 |
| Permissions | 四种 profile、approval、fullAccess 硬保护 |
| Skills catalog | catalog 解析、download URL、sha256、zip slip 防护、版本更新 |
| Skills runtime | `SKILL.md` frontmatter、activate、resource read、script first-run confirmation |
| MCP stdio | server start、tools/list、tools/call、disable stop |
| QA regression | `buildChatPrompt()` context/evidence 不变 |
| Completion regression | direct chat/raw completions、Qwen FIM、edit validation、telemetry |
| Remote host | workspace host 路径、stdio spawn、storage 位置、localhost endpoint 语义 |

## 文档与外部标准

Skills 设计参考 Agent Skills open standard 与主流实现：

- Agent Skills specification: https://agentskills.io/specification
- Claude Agent Skills docs: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- OpenAI Codex Skills docs: https://developers.openai.com/codex/skills

MCP v1 只采用 stdio transport。后续如需 HTTP，可再增加 Streamable HTTP transport：

- MCP transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
