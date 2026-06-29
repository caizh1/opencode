# ChipMate

ChipMate 是一个运行在 VS Code `workspace` extension host 内的直连 OpenAI-compatible 编码助手。它把聊天问答、inline completion、workspace skills、工具调用、本地 CodeGraph/RAG、Document RAG、AI 注释和 Agent Terminal 放在同一个 workspace host 里运行；使用 Remote SSH 时，这些能力跟随远端 Linux extension host，而不是本机 UI 进程。

这个 README 面向两类读者：

- 使用者：如何配置 provider、打开聊天、使用补全、RAG、文档检索、AI 注释和 Agent Terminal。
- 维护者：当前公开命令、关键配置、安全边界、打包规则和排障入口。

## 快速开始

最低运行环境由 `package.json` 决定：当前 VS Code engine floor 是 `^1.93.0`。本地开发使用 Bun：

```bash
bun install
bun run compile
```

在 VS Code 中使用时，至少需要配置一个 OpenAI-compatible provider：

```json
{
  "chipmate.provider.apiBaseUrl": "http://127.0.0.1:8000/v1",
  "chipmate.provider.chatModel": "qwen-coder",
  "chipmate.completion.enabled": true,
  "chipmate.completion.provider": "qwen-direct",
  "chipmate.completion.profile": "qwen-coder-fim",
  "chipmate.completion.model": "qwen-coder-30b0"
}
```

API key 通过命令 `ChipMate: Set ChipMate Provider API Key` 或 ChipMate 设置面板保存到 VS Code SecretStorage，不写入 `settings.json`。同一个 key 供 chat、inline completion、RAG embedding、RAG rerank、Document RAG 和需要模型的工具流程复用。

常用入口：

- Activity Bar 的 `ChipMate` 视图打开聊天侧边栏。
- `ChipMate: Set ChipMate Provider API Key` 保存 provider key。
- `Open ChipMate Agent Terminal` 打开自然语言命令终端。
- 右键编辑器或 SCM 视图使用 AI 注释命令。

## 核心能力

- Chat / QA：直连 `/chat/completions` SSE streaming，支持停止生成、session JSONL 落盘、最近历史、rolling memory summary、本地上下文、skills、工具循环、Mermaid 和 draw.io 渲染。
- Inline Completion：默认启用 `qwen-direct`，普通代码补全继续走 Qwen FIM；支持最近编辑、最近打开文件、import definition、root-path 轻量上下文和手动 regenerate hotkey。
- CodeGraph / Code RAG：本地 C/C++ code graph 和可选 embedding/rerank RAG，状态可在 composer 附近查看，也可用命令重建、暂停、恢复、取消和查看状态。
- Document RAG：自动扫描 workspace 中的 `.doc`、`.docx`、`.xlsx`、`.xlsm`、`.pdf`，建立独立文档向量索引，并在聊天和工具检索中提供文档 evidence。
- Workspace Skills：发现 workspace `.agents/skills/*/SKILL.md` 和兼容 `.claude/skills/*/SKILL.md`，支持 parent repo 与可选用户级扫描、显式 `$skill`/`/skill` 调用、核心 frontmatter、visibility overrides、渐进加载、资源索引、`scripts/`、`references/`、`assets/` 和动态 `!command` 指令说明。
- Tools / Permissions：`chipmate.tools.enabled=false` 时不向模型发送任何 tool schema；开启后按当前 permission mode 执行读、检索、graph、文档和受限文件编辑类工具。
- Agent Terminal：在 VS Code terminal profile 中提供 ChipMate 终端，shell 命令直接执行，自然语言请求会先规划、展示、确认，再执行；失败后可尝试有限修复。
- AI 注释：支持为选区、当前函数或工作区改动生成中文注释候选，带 review panel、accept/reject/clear、批量接受和 CodeLens/装饰。
- Word / Diagram 辅助：支持 `documents` skill 驱动的通用 Word `.docx` 创建/编辑工作流、`read_docx` 语义读取、`inspect_word_document`/`apply_word_document_edits` 受控编辑、`create_word_document` 生成 preset-aware `.docx` 文档、`chipmate_render_mermaid_diagram` 远端优先/本地兜底生成 Mermaid `.mmd`/`.png` artifact，以及 draw.io / diagrams.net fenced block 的本地渲染和导出。
- 模块详细设计文档：通过通用 QA/agent flow + `chip-design-doc` skill + 通用 Word/Mermaid 工具完成；用户可以描述子模块、文件、选区、入口符号、机制或流水线，模型先定位范围并收集 CodeGraph/RAG evidence，再生成芯片级详细设计 DOCX。输出当前实现方案、功能清单、主/子业务流程、代码流程、状态机切换表、嵌入 Word 的 Mermaid PNG、Mermaid 图源和 evidence ledger；不会默认对整仓生成。
- MCP：配置面板保留 Coming Soon 区块；当前版本不启动 MCP server、不安装 artifact、不暴露 MCP 工具。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `chipmate.openChat` | 打开 ChipMate Chat |
| `chipmate.newSession` | 新建聊天 session |
| `chipmate.askSelection` | 对当前选区提问 |
| `chipmate.askCurrentFile` | 对当前文件提问 |
| `chipmate.designDoc.generate` | 基于当前文件/选区生成模块级详细设计文档 |
| `chipmate.addSelectionToContext` | 把选区加入聊天上下文 |
| `chipmate.addFileToContext` | 把当前文件加入聊天上下文 |
| `chipmate.clearContext` | 清空手动上下文 |
| `chipmate.openOutput` | 打开 ChipMate Output |
| `chipmate.provider.setApiKey` | 保存 provider API key |
| `chipmate.agentTerminal.open` | 打开 ChipMate Agent Terminal |
| `chipmate.qwenAutocomplete.regenerate` | 对当前位置强制重新采样 inline completion |
| `chipmate.qwenAutocomplete.showLogs` | 打开 Qwen autocomplete 日志 |
| `chipmate.qwenAutocomplete.exportDiagnostics` | 导出 Qwen autocomplete 诊断 |
| `chipmate.codeGraph.index` / `rebuild` / `pause` / `resume` / `cancel` / `status` | 管理本地 CodeGraph |
| `chipmate.codeGraph.benchmark` | 运行本地 CodeGraph benchmark |
| `chipmate.documentRag.rebuild` / `pause` / `resume` / `status` | 管理 Document RAG |
| `chipmate.comments.generateForSelection` | 为选中代码生成 AI 注释 |
| `chipmate.comments.generateForCurrentFunction` | 为当前函数生成 AI 注释 |
| `chipmate.comments.generateForWorkspaceChanges` | 为工作区改动生成 AI 注释 |
| `chipmate.comments.accept` / `acceptAll` / `reject` / `clear` | 处理 AI 注释候选 |

Qwen completion regenerate 默认快捷键：

- macOS：`Cmd+Alt+]`
- Windows / Linux：`Ctrl+Shift+]`

## Provider 与上下文

关键 provider 设置：

```json
{
  "chipmate.provider.apiBaseUrl": "http://127.0.0.1:8000/v1",
  "chipmate.provider.chatModel": "qwen-coder",
  "chipmate.provider.maxTokens": 4096,
  "chipmate.provider.temperature": 0.2,
  "chipmate.provider.topP": 1
}
```

`/models` 发现失败时，ChipMate 会继续使用手填的 chat/completion model。`chipmate.provider.maxTokens` 是输出 token 上限，不是完整输入上下文安全上限；最终请求还可能包含本地文件、diagnostics、git diff、CodeGraph evidence、Document RAG evidence 和工具结果。

聊天请求默认带最近 `10` 轮 raw chat history，由 `chipmate.context.maxHistoryTurns` 控制，并受 `chipmate.context.maxHistoryBytes=40000` 限制。超出最近窗口的同一 session 旧对话会在 `chipmate.context.memorySummary.enabled=true` 时滚动压缩为 `Conversation memory summary`，默认最多 `12000` bytes，并随下一次请求一起发送。

常用上下文设置：

```json
{
  "chipmate.context.maxFileBytes": 16000,
  "chipmate.context.maxFiles": 8,
  "chipmate.context.includeDiagnostics": true,
  "chipmate.context.includeGitDiff": false,
  "chipmate.context.maxHistoryTurns": 10,
  "chipmate.context.maxHistoryBytes": 40000,
  "chipmate.context.memorySummary.enabled": true,
  "chipmate.context.memorySummary.maxBytes": 12000
}
```

设置 `chipmate.context.maxHistoryTurns=0` 只关闭 raw history；如果要完全不带同一 session 的旧对话信息，也需要关闭 `chipmate.context.memorySummary.enabled`。

## Inline Completion

Inline completion 默认开启：

```json
{
  "chipmate.completion.enabled": true,
  "chipmate.completion.provider": "qwen-direct",
  "chipmate.completion.profile": "qwen-coder-fim",
  "chipmate.completion.model": "qwen-coder-30b0",
  "chipmate.completion.contextLength": 200000,
  "chipmate.completion.maxPromptTokens": 1024,
  "chipmate.completion.maxTokens": 128
}
```

当前补全路线保留产品级 pipeline：planner、symbol resolver、context retriever、packer、router、postprocessor、inline edit builder、eval fixtures 和 structured telemetry。普通代码补全继续使用 Qwen FIM；自然语言命令、comment-to-test 和 deterministic symbol completion 不走普通 FIM。

补全输出约束：

- Inline completion range 必须保持单行。
- 不展示 echoed prefix、重复注释、空输出或 suffix-duplicated output。
- `chipmate.completion.contextLength=200000` 是默认 fast path；设置为 `0` 才会尝试从只读 `/models` metadata 自动探测并回退到 `200000`。
- `chipmate.completion.commentGuidedRetrievalMode=qa-exact` 表示 C/C++ comment-guided completion 复用 QA 风格 evidence 检索核心，再投影成短 FIM context。

## CodeGraph 与 Code RAG

CodeGraph 和 Code RAG 配置前缀均为 `chipmate.*`：

```json
{
  "chipmate.codeGraph.enabled": true,
  "chipmate.codeGraph.analysisMode": "auto",
  "chipmate.codeGraph.indexTests": false,
  "chipmate.rag.embedding.endpoint": "http://127.0.0.1:8000/v1/embeddings",
  "chipmate.rag.embedding.model": "qwen3-embedding-8b",
  "chipmate.rag.embedding.batchSize": 64,
  "chipmate.rag.embedding.concurrentRequests": 2,
  "chipmate.rag.rerank.endpoint": "http://127.0.0.1:8000/rerank",
  "chipmate.rag.rerank.model": "qwen3-reranker-8b",
  "chipmate.rag.indexTests": false
}
```

默认情况下，CodeGraph 和 Code RAG 都不会索引路径 segment 精确为 `test` 或 `tests` 的目录，大小写不敏感，例如 `test/foo.c`、`src/tests/foo.c`、`a/Test/b.cpp` 会被跳过；`contest/foo.c`、`testdata/foo.c`、`unit_test/foo.c` 不会被跳过。需要测试代码进入本地 code graph 时，设置 `chipmate.codeGraph.indexTests=true` 并重建 code graph。

`chipmate.rag.indexTests=true` 只有在 `chipmate.codeGraph.indexTests=true` 且 code graph 已包含测试文件时才会为测试路径生成 RAG chunks。切换 CodeGraph test 索引策略会触发 code graph 从 0 重建；切换 RAG test 索引策略后，旧 RAG manifest 会因为内容策略不匹配而不被复用。

本地 code graph 使用有界 JSON 分片和 derived sidecar 落盘，避免大仓库保存阶段生成无限增长的单个 JSON。保存阶段看到类似 `Saving shard ... part 0000` 不等于扫描失败，它通常表示扫描/解析已完成，正在把 shard、sidecar 和 manifest 写入 extension `globalStorage`。

RAG endpoint 默认只允许 localhost、私网 IP、内网域名和 `chipmate.rag.allowedHosts` 中显式列出的 host。Embedding response 默认 `encodingFormat=auto`，batch/concurrency 默认分别为 `64` 和 `2`，用于兼顾吞吐和 provider 压力。

### Code RAG embedding indexing 机制

Code RAG 的 embedding 索引建立在本地 CodeGraph 之上：CodeGraph 先完成结构索引，Code RAG 再从 function、file/module summary、state transition 和 text-window 等 chunks 生成 embedding。已有向量只有在 provider、model、dimension、`indexTests`、source index 等身份匹配时才会复用；不匹配时按当前策略重建或跳过复用。Partial checkpoint、最终 shard 和 manifest 都写入 VS Code extension `globalStorage`，所以中途中断不等于已有向量丢失。

批次和并发是两个不同概念：

- `chipmate.rag.embedding.batchSize=64` 表示每个 embedding HTTP request 最多带 64 个 chunks；`chipmate.rag.embedding.maxTokensPerRequest=65536` 还可能因为单次估算 token 上限把 batch 拆得更小。
- `chipmate.rag.embedding.concurrentRequests=2` 表示初始同时最多 2 个 request。前 2 个完成后会继续调度下一批，不是一次 indexing run 只发 2 次请求。
- worker 会自适应：遇到 retry、rate-limit 或 timeout 等 provider 压力时可从 `2 -> 1` 降级；连续稳定成功后可升到 `configured + 1`，默认即最多 `3`。
- `chipmate.rag.embedding.maxInFlightTokens=360000` 限制所有 in-flight request 的估算 token 总量，避免并发请求一起压爆 provider。
- `chipmate.rag.embedding.maxRequestsPerRun=100` 是一次 indexing run 的总 embedding HTTP request 上限，和耗时无关；重试也计入这个计数。设为 `0` 表示不限制。

例如有 `14634` 个 pending chunks、`batchSize=64` 时，理论上约需要 `ceil(14634 / 64) = 229` 次 embedding request。`concurrentRequests=2` 只表示每次最多并发跑 2 个 request；默认第 100 个 request 后如果仍有 pending chunks，会触发 `request-budget`，保存 partial index，然后按自动恢复策略继续下一轮。

重试和 paused 语义按原因区分：

- `429`、`408`、`5xx` 是 retryable HTTP 错误，按 `chipmate.rag.embedding.maxRetries=3` 重试；delay 优先使用 `Retry-After`，否则按 `chipmate.rag.embedding.retryBackoffMs=2000` 做指数退避。
- retryable 错误重试耗尽后通常进入 `rate-limit` paused；`request-budget` 和 `rate-limit` 在 `chipmate.rag.embedding.resumeAutomatically=true` 时会自动 schedule resume，`request-budget` 默认使用 `chipmate.rag.embedding.resumeDelayMs=60000`。
- `fetch failed`、没有 HTTP response、embedding response 向量数量不匹配、向量归一化失败等进入 `provider-error`，通常不会自动继续。需要先修 provider、网络、证书、proxy、key 或 model 配置，再重新触发 RAG 构建或恢复。
- 用户手动暂停是 `manual`，不会自动恢复；需要使用 RAG 的 Resume 控制或对应命令。

排查 Code RAG indexing 时优先看 `Output > ChipMate`。关键日志包括 `[rag-index] embedding`、`embedding batch`、`paused:`、`resume scheduled`、`auto resume starting`、`auto resume skipped`、`[rag-http] response` 和 `[rag-http] error`。如果是 `fetch failed`，详细原因通常在 `[rag-http] error` 后面的 `errorCode`、`causeCode`、`causeHostname`、`causePort`、`causeAddress`、`causeMessage` 等字段里；如果只有 `[rag-http] request` 后直接失败而没有 response，应优先排查 VS Code extension host 的网络、TLS、proxy、DNS 或 CA 差异。

## Document RAG

Document RAG 默认开启，扫描当前 workspace 中的 `.doc`、`.docx`、`.xlsx`、`.xlsm`、`.pdf`：

```json
{
  "chipmate.documentRag.enabled": true,
  "chipmate.documentRag.maxFiles": 5000,
  "chipmate.documentRag.maxFileBytes": 26214400,
  "chipmate.documentRag.maxExtractedBytesPerFile": 1048576,
  "chipmate.documentRag.maxChunks": 50000,
  "chipmate.documentRag.queryTopK": 12,
  "chipmate.documentRag.maxEvidenceBytes": 24000
}
```

Document RAG 使用同一 provider key 和 RAG embedding/rerank 设置。它会建立独立文档索引，聊天请求可自动注入相关文档 evidence，工具开启后也可通过 `chipmate_search_documents` 检索。

解析边界：

- `.docx` / `.doc` 提取 Word 正文文本。
- `.xlsx` / `.xlsm` 提取工作表、范围、表头、行列、公式和值；`.xlsm` 不执行宏。
- `.pdf` 只提取已有文本层；图片型或扫描型 PDF 不做 OCR。
- 临时 Office 文件、`.git` 等路径会被跳过，额外排除可用 `chipmate.documentRag.excludeGlobs`。

## Tools 与权限

`chipmate.tools.enabled` 是模型工具调用总开关，默认 `false`。关闭时，direct chat runtime 不会在 `/chat/completions` 请求中发送 `tools` 或 `tool_choice`；如果 provider 仍返回 `tool_calls`，ChipMate 会忽略并且不会执行 workspace tool。

开启后，当前可暴露给模型的工具按能力分组：

- Workspace 读与检索：`chipmate_read`、`chipmate_search_text`、`chipmate_read_evidence`、`chipmate_read_skill_resource`。
- Skill 资源与安全脚本：`chipmate_read_skill_resource`、`chipmate_run_skill_script`；脚本执行只允许 active skill 的 `scripts/manifest.json` 显式 `directExecution: true` 且声明 executable entrypoint 的 helper，并继续走命令权限审批。
- Code evidence / graph：`chipmate_search_code`、`chipmate_graph_inspect_symbol`、`chipmate_graph_find_references`、`chipmate_graph_callers`、`chipmate_graph_callees`、`chipmate_graph_trace_call_chain`、`chipmate_graph_analyze_impact`、`chipmate_graph_map_module`、`chipmate_graph_find_state_machines`、`chipmate_graph_trace_state_path`。
- Document / Word：`chipmate_search_documents`、`read_docx`、`inspect_word_document`、`apply_word_document_edits`、`audit_word_document_styles`、`normalize_word_document_styles`、`apply_word_template_styles`、`audit_word_document_fields`、`flatten_word_ref_fields`、`materialize_word_seq_fields`、`compare_word_documents`、`merge_word_documents`、`extract_xlsx_table`、`export_word_table_to_csv`、`chipmate_render_mermaid_diagram`、`create_word_document`。
- Workspace 创建与精确编辑：`chipmate_create_file`、`chipmate_create_directory`、`chipmate_edit_file`。

`chipmate.permissions.mode` 支持三档：

| Mode | 行为 |
| --- | --- |
| `ask` | 默认模式。低风险只读工具可放行；文件创建、目录创建、精确编辑等操作需要按策略和 UI 审批。 |
| `auto` | 自动放行低风险操作；高风险操作仍需策略判断或审批。 |
| `full-access` | 对已暴露工具不拦截，只记录审计 JSONL。 |

工具结果会写入 `globalStorage/audit/*.jsonl`，聊天消息写入 `globalStorage/sessions/*.jsonl`。`allowed-tools` 在工具开启时作为 skill 提示、active skill policy 和审计信息，不能越过当前 permission mode；direct chat 会按本轮实际暴露工具过滤，并记录 active skill 是否声明了对应工具。

`chipmate-local` 是 workspace-host guard agent；`chipmate.context.strictLocalOnlyAgent` 保留为兼容 guard 开关。当前版本的 agent、tools、skills、CodeGraph、RAG 和 Document RAG 都在 VS Code workspace extension host 内运行。`chipmate.tools.enabled=false` 只关闭模型主动工具调用入口，不关闭手动附件、`@mention` 文件、CodeGraph/RAG evidence 或 inline completion。

## Workspace Skills

ChipMate 默认扫描当前 workspace 的 `.agents/skills` 和兼容 `.claude/skills`，并沿 workspace 父目录向上寻找 `.agents/skills`，用于 monorepo/module skill。用户级 `~/.agents/skills` 默认开启；在 `chipmate.skills.scanClaudeSkills=true` 时也会扫描 `~/.claude/skills`。如需只使用 workspace skills，可设置 `chipmate.skills.scanUserSkills=false`。

Skills 设置页支持 `Import Skill...` 和拖拽导入 skill 目录、父目录或单个 `SKILL.md`。导入前会校验 YAML frontmatter、`description`、`allowed-tools` 和资源引用；有效 skill 会复制到用户级 `~/.agents/skills/<commandName>`，脚本只复制不执行，当前不支持 zip 导入。

```text
.agents/
  skills/
    firmware-review/
      SKILL.md
      scripts/
      references/
      assets/
```

示例 `SKILL.md`：

```markdown
---
name: firmware-review
description: Review firmware patches and call out correctness risks.
allowed-tools:
  - chipmate_search_text
  - chipmate_read
---

Read changed files first. If evidence is missing, use workspace tools when tools are enabled; otherwise ask the user to open or @mention the file.
```

Skill 列表只展示元信息；启用后才把正文注入 prompt。`scripts/`、`references/`、`assets/` 是技能资源目录，动态 `!command` 只作为技能文本里的运行提示，实际执行仍要走工具和权限路径。

显式调用可以在聊天里使用 `$firmware-review` 或 `/firmware-review`。active skill 的 `references/`、`assets/`、`scripts/` 文件不会一次性塞进 prompt；模型需要时只能通过 `chipmate_read_skill_resource` 读取。脚本不会被自动执行；只有 active skill 的 `scripts/manifest.json` 显式允许 direct execution 并声明 executable entrypoint 时，模型才能通过 `chipmate_run_skill_script` 请求运行，且仍受普通命令权限审批和审计约束。

## Agent Terminal

Agent Terminal 是一个 VS Code terminal profile，入口是 `Open ChipMate Agent Terminal`。它支持：

- 直接输入 shell 命令并在 workspace cwd 下执行。
- 输入自然语言时，先让模型规划命令，再展示目的、风险、预期结果和命令文本。
- 用户确认后执行；高风险或需要修改的命令不会静默运行。
- 命令失败后，结合输出进行有限次数修复规划。
- `Ctrl+C` 可取消当前任务、确认框或澄清输入。

Agent Terminal 会做轻量项目侦察，但仍以当前 workspace 文件和终端输出为证据边界；遇到 sudo、交互密码、TTY 限制等非交互终端问题时，应转到普通终端或手动处理。

## AI 注释

AI 注释命令面向代码审阅和注释候选生成：

- 选区注释：`ChipMate: 为选中代码生成 AI 注释`
- 当前函数注释：`ChipMate: 为当前函数生成 AI 注释`
- 工作区改动注释：`ChipMate: 为工作区改动生成 AI 注释`
- 候选处理：接受、接受全部、拒绝、清除

当前支持语言包括 C/C++、CUDA C++、Objective-C、Objective-C++、Shell、Makefile 和 YAML。当前函数模式支持 C/C++、Shell 和 Makefile。生成过程会重建本轮 prompt，不复用 QA session transcript；pending proposals 只用于 review panel、装饰、CodeLens 和 accept/reject/clear 流程。

## 图表与 Word 文档

聊天回答支持 Mermaid fenced diagram 本地渲染。用户请求 draw.io / diagrams.net 图时，ChipMate 会引导模型输出 fenced `drawio` XML block，并在 webview 内用随扩展打包的离线 draw.io runtime 渲染和导出 PNG。

文档工具包括：

- `read_docx`：读取本地 `.docx` 的语义结构，返回 heading、段落、列表、表格、heading path 和 bounded previews。
- `inspect_word_document` / `apply_word_document_edits`：先检查现有 `.docx` 并返回可验证 locator，再执行受控编辑；支持新增章节（有序 blocks、段落、rich paragraph、真实 Word 列表、PNG figure/图注/bookmark、表格、callout、brief/key-facts card group、source evidence card group、quote/pull-quote block、code block、true footnote/endnote note runs）、段内精确文本替换、纯文本/rich paragraph 段落替换、段落替换为有序同级结构块（paragraph/rich paragraph/list/PNG figure/table/callout/brief/evidence/quote/code）、段落级纯文本和富文本真实 Word 修订红线、段内真实 Word 修订红线、表格单元格文本真实 Word 修订红线、接受/拒绝全部修订、heading level 修复、表格单元格更新、整表替换、真实合并单元格 `colSpan`/`rowSpan`、表格重复/header row 标记、列表项替换、section page setup 尺寸/方向/边距更新、图片 title/alt metadata 更新、本地 PNG 图片本体替换、Figure/Table caption 文本更新并保留 `SEQ` 字段/bookmark、hyperlink 显示文本/目标 URL/内部 anchor/tooltip 更新、REF/PAGEREF cross-reference 字段和 marker authoring、多段 footnote/endnote 文本更新、段落批注、多段批注正文更新、批注完成标记并同步 commentsExtended 元数据、plain-text/checkbox/dropdown/date SDT 表单字段检查/填充、rich/nested SDT 检查并以 `fillUnsupportedReason` fail closed、简单 VML 文本水印新增到所有已有 header part、检查 document/header/footer VML 文本水印、VML 图片背景和 DrawingML 图片背景并按 locator 移除对应 XML、现有 footnote/endnote 检查与报告、现有图片/图形 placement/关系/content type/replace 支持状态/alt text 检查、现有 Figure/Table caption 检查、现有 hyperlink 文本/目标检查、现有 Word 字段类型/指令/cached text 检查、现有 style catalog 和样式使用量检查、清理全部批注/commentsExtended/commentsIds 元数据、外发前元数据清理、精确可见文本脱敏，以及仅在 native operation 覆盖不了时使用的受控 `patchOoxmlPart` 低层 XML OOXML repair。
- `audit_word_document_styles` / `normalize_word_document_styles`：审计 `.docx` 中 run-level direct formatting、paragraph spacing/indent 覆盖、字体使用和疑似 heading 未用 Heading style；可生成新的样式规范化副本，默认只清理 run-level 覆盖，paragraph cleanup 和 heading spacing enforcement 需显式选择。
- `apply_word_template_styles`：把 `.dotx` 或模板 `.docx` 的 `styles.xml`、`theme1.xml`、`fontTable.xml`、`numbering.xml` 套用到目标 `.docx` 的新副本，保留目标正文，并执行结构和渲染检查；可用 `styleAllowlist` 只导入指定模板 style id 及其 basedOn/next/link 依赖。返回 `templateAudit` 报告 style/numbering 冲突、选择性导入策略、模板关系和媒体复制情况；被复制 style/numbering/theme 部件中引用的本地图片关系会连同 media 一起复制，非图片/外部/缺失关系会 fail closed。页数、分页和表格换行可能随模板变化。
- `audit_word_document_fields` / `flatten_word_ref_fields` / `materialize_word_seq_fields`：审计 Word 字段类型和 stale-field 风险，包括 `TOC`、`PAGE`、`NUMPAGES`、`SEQ`、`REF`、`PAGEREF`；可生成把复杂 `REF` / `PAGEREF` 字段缓存显示文本展平成普通文本的新副本，也可生成保留 live `SEQ` 字段但重算 caption/table/figure 缓存可见编号的新副本，用于稳定 headless 渲染。不会刷新 `PAGE`、`NUMPAGES` 或 `TOC`。
- `compare_word_documents`：比较两个本地 `.docx`，生成可比较文本 diff，复用 DOCX -> PDF -> page PNG 渲染链路检测变更页，并把 `text-diff.txt`、变更页 before/after PNG、像素高亮 diff PNG、changed-ratio、changed bbox、3x3 changed-region summary、visual severity、risk flags 写入 `.chipmate/docs/diff`；可选 `pixelThreshold` 用于更严格或更宽松地处理抗锯齿/渲染噪声。
- `merge_word_documents`：把一个本地 `.docx` 的正文 OOXML append 到另一个 `.docx`，保留 base 文档包结构、页眉页脚和最终 section settings；默认拒绝 append 文档中的 drawings/images。显式 `allowDrawings` 时会合并 append body 引用的本地图片 relationship 和 `word/media/*` 部件；hyperlink relationship 会被重映射，style/numbering 使用 base-wins 策略并在 `mergeAudit`/warnings 中报告冲突或 append-only 引用，非图片嵌入对象 relationship 会 fail closed。
- `extract_xlsx_table` / `export_word_table_to_csv`：`extract_xlsx_table` 从本地 `.xlsx` / `.xlsm` 的简单矩形工作表范围提取 `TableSpec`，供模型放入 `create_word_document` 或 `apply_word_document_edits` 的表格操作；不重算公式、不迁移电子表格样式或合并单元格语义。`export_word_table_to_csv` 按 `inspect_word_document` 返回的 `tableIndex` 把现有 Word 表格导出为 `.chipmate/docs/tables/*.csv` artifact。
- `chipmate_render_mermaid_diagram`：当模型需要把 Mermaid 图嵌入 Word 或保留图表 artifact 时，先写出 `.chipmate/docs/diagrams/*.mmd`，再优先调用配置的远端 ChipMate render server `/render/mermaid` 生成 PNG；远端不可用或失败时会记录原因并尝试本地 Chrome/Edge fallback。成功时返回 `*.png` 路径、尺寸、FigureSpec-compatible image 字段、render provider/fallback 诊断和聊天内 Mermaid 预览 artifact；不调用在线 Mermaid 服务。
- `create_word_document`：当完整 `WordDocSpec` 已准备好时，在 workspace 下生成 preset-aware `.docx` 文档，支持 PNG figure 或本地 PNG artifact path、带 cached `SEQ` 编号字段的 Word Caption 图注、figure/table caption bookmark、结构化 rich paragraph、brief/key-facts card group、source evidence card group、quote/pull-quote block、多级 bullet/numbered/checklist Word numbering、definition list、source list、带真实 `gridSpan`/`vMerge` 的合并单元格表格、外部/内部 hyperlink、REF/PAGEREF cross-reference 字段，以及 rich paragraph 文本中的 `{{ref:bookmark|visible text}}` / `{{pageref:bookmark|page text}}` authoring marker 到真实 Word 字段的转换、静态可点击 TOC / Top / Bottom / 返回目录内部导航、true footnote/endnote（`note.text` 换行会生成多段 note body）、plain-text/checkbox/dropdown/date SDT 表单字段和 Word documentProtection 设置；这些 SDT 字段之后可通过 `inspect_word_document` / `fillContentControl` 受控填充。工具会返回生成路径、设计 preset、warnings、结构/a11y/table overflow 检查和 DOCX -> PDF -> page PNG 渲染质量状态，并包含每页 PNG 的视觉摘要（尺寸、ink ratio、content bounds、edge ink）用于发现空白页、裁剪和溢出风险。
- `inspect_word_document`：读取现有 `.docx` 的段落、表格、批注、plain-text/checkbox/dropdown/date content controls、rich/nested content control fill 支持状态、水印、脚注/尾注（保留多段 note body 换行）、图片、Figure/Table captions、hyperlinks、section/page setup、Word fields、styles，以及真实 Word numbering/list groups；summary 会返回 `trackedChangeTypeCounts` 和 `advancedTrackedChangeWarnings`，用于区分普通插入/删除、move revisions 和 formatting revisions；批注 inspection 会返回多段正文、anchor、`commentsExtended.xml` / `commentsIds.xml` thread metadata（`paraId`、`parentParaId`、`parentCommentId`、`durableId`、`resolvedSource`、`commentsExtendedDone`），列表 inspection 会返回 list kind、level、item count、段落 list membership 和只读 list locator，图片 inspection 会返回 inline/floating placement、embedded/external/missing relationship mode、media target/path/content type、media existence、size、title/alt 和 `replaceSupported` / `replaceUnsupportedReason`，caption inspection 会返回 caption kind、label、cached number、`SEQ` instruction、bookmark 和只读 caption locator。
- `apply_word_document_edits`：基于 `inspect_word_document` 返回的 locator 生成新 `.docx`，支持按 `insertSection.blocks` 指定顺序插入段落/rich paragraph/真实 Word 列表/PNG figure/表格/callout/brief card group/source evidence card group/quote block/code block；rich paragraph 可写入粗体、斜体、外部 hyperlink、内部 anchor hyperlink、REF/PAGEREF 字段、cross-reference authoring marker 和 true footnote/endnote note runs，note 文本中的换行会写成多段 note body。也支持纯文本段落替换、rich paragraph 段落替换、段落替换为有序同级结构块、段内替换、整段纯文本 tracked change、整段 rich tracked change、跨 run 段内真实 tracked change、`updateTableWithTrackedChange` 表格单元格文本 tracked change、move revision 接受/拒绝、formatting revision fail-closed、`updateHeadingLevel` 标题层级修复、表格单元格更新、`replaceTable` 整表替换为 fixed-layout 表格并支持 `colSpan`/`rowSpan`、`updateTableHeaderRows` 表格重复/header row 标记、`updateList` 列表项替换、`updateSectionPageSetup` 页面尺寸/方向/边距更新、`updateImageAltText` 图片替代文本/标题更新、`replaceImage` 本地 PNG 图片本体替换（仅当 inspection image `replaceSupported` 为 true；外链图、缺失关系、无法解析 media target 或非 PNG media 会给出 unsupported reason）、`updateCaptionText` Figure/Table caption 文本更新并保留 `SEQ` 字段/bookmark、`updateHyperlinkText` hyperlink 显示文本更新、`updateHyperlinkTarget` hyperlink URL/内部 anchor/tooltip 更新、`updateNoteText` 脚注/尾注正文多段更新、批注新增、多段 `updateCommentText` 批注正文更新、`setCommentResolved` 同步 legacy comments 与 existing commentsExtended 状态、`fillSupported` content control 填充、rich/nested content control 拒绝填充并报告原因、水印、修订接受/拒绝、元数据清理、精确文本脱敏，以及 `patchOoxmlPart` 受控 OOXML XML part 补丁。`patchOoxmlPart` 只允许 `documentEnd` locator、XML package part allowlist、精确 `oldText`/`anchor`/`closeTag` 预条件和 `expectedOccurrences`，并禁止 external relationships、macro、OLE、ActiveX 和 embedded binary 引用；补丁后仍执行结构检查与渲染检查。

`documents` skill 还包含 `scripts/manifest.json`，作为 Codex-style helper script catalog。它列出 Codex documents helper script 名称、ChipMate 对应工具或 backlog 项、执行边界和状态；当前 documents catalog 默认是只读 skill resource，模型可通过 `chipmate_read_skill_resource` 读取来选择正确工具。只有未来某个 helper 在 manifest 中显式 opt in direct execution 时，才可通过 `chipmate_run_skill_script` 在 W43 安全边界内执行。

模块详细设计文档 flow 会在用户明确要求“详细设计文档 / 模块设计文档 / 芯片级设计文档”且给出子模块范围时触发。范围可以来自 Chat 中的 `@目录` / `@文件`，也可以来自命令 `ChipMate: Generate Module Detailed Design Document` 对当前文件或选区的上下文。生成结果包括：

- `.docx` 正式文档，包含现有方案、功能详细设计、业务流程、代码流程、状态机迁移表、缺口和证据索引；架构图、业务流程图、代码流程图、状态机图会以 Mermaid 渲染后的 PNG 插入对应章节。
- `.chipmate/docs/<run-id>/diagrams/*.mmd` Mermaid 图源文件，以及同目录 `*.png` 渲染图像 artifact；聊天界面仍会直接预览 Mermaid 图表。
- `.chipmate/docs/<run-id>/run-summary.json` 与 `evidence-ledger.json`，用于复核证据覆盖、图表列表和缺失项。

Word 正文不把 Mermaid 语法当作图表主体展示；`.mmd` 是可追溯源文件，`.png` 是 Word 正文使用和人工复核的渲染结果。如果远端 Mermaid render 和本地 Chrome/Edge fallback 都失败，详细设计文档生成会 fail closed，不会降级生成只有 Mermaid 语法的 Word。若远端失败但本地 PNG fallback 成功，最终回答会明确披露 fallback。

这些工具不是通用文件写入器；普通文件创建/编辑应走 `chipmate_create_file`、`chipmate_create_directory`、`chipmate_edit_file` 的权限路径。

## 开发与验证

常用开发命令：

```bash
bun install
bun test
bun run lint
bun run compile
bun run package
bun run fixtures:docx -- --out /tmp/chipmate-docx-fixtures
```

`bun run package` 是交付前必跑的验证入口，会执行 type checking、linting 和 TypeScript compilation。
`bun run fixtures:docx` 会生成本地 Word/documents 回归 DOCX fixtures 和 `manifest.json`，用于水印、修订、字段/图注等 tricky OOXML smoke，不是普通用户交付物。

补充验证：

```bash
bun run verify:document-runtime -- chipmate-<version>.vsix
bun run verify:qwen-vsix -- chipmate-<version>.vsix
bun run test:vscode
```

`test:vscode` 会先跑 `bun run package`，再启动 VS Code extension test host。旧版兼容性验证应使用低水位 VS Code host，例如 `1.93.x`，而不是只看当前最新 VS Code。

## 本地 VSIX 打包

本地 VSIX 使用 build-number prerelease 版本：

```text
<release-version>-build.<build-number>
```

常规打包：

```bash
bun run vsix
```

这会把当前 release line 的 build number 加一，然后委托 `vsce package`。例如 `0.1.0-build.3` 会打出 `0.1.0-build.4`。

切换 release line 或指定 build：

```bash
bun run vsix -- --release 0.1.2
bun run vsix -- --release 0.1.2 --build 1
```

不要为了普通本地包自动改 `0.1.0` 到 `0.1.1` 或其他 release version；`x.y.z` release line 由用户明确控制。

### 本地默认 Provider / RAG 注入

私有 provider 和 RAG 默认值只能放在被 git ignore 的根目录文件 `.chipmate-vsix-defaults.local.json`。`bun run vsix` 会在打包时临时把这些默认值注入 VSIX manifest，打包后恢复 `package.json` 源码默认值，并检查 tracked source 没有残留私有默认值。

本地文件 schema：

```json
{
  "provider": {
    "apiBaseUrl": "http://127.0.0.1:8000/v1",
    "chatModel": "qwen-coder"
  },
  "rag": {
    "embedding": {
      "endpoint": "http://127.0.0.1:8000/v1/embeddings",
      "model": "qwen3-embedding-8b"
    },
    "rerank": {
      "endpoint": "http://127.0.0.1:8000/rerank",
      "model": "qwen3-reranker-8b"
    },
    "allowedHosts": ["127.0.0.1"]
  }
}
```

如果 `.chipmate-vsix-defaults.local.json` 存在但没有被 git ignore，打包会 fail closed。不要把私有 endpoint、host 或 provider model 写进 tracked source、README、AGENTS、测试或文档。

## 排障入口

- 聊天、RAG、CodeGraph、Document RAG、Agent Terminal：优先看 `Output > ChipMate`。Code RAG paused、request budget 或 fetch failed 可回看上面的 `Code RAG embedding indexing 机制`。
- 扩展激活慢、pre-activate module load、top-level require：看 `Developer: Show Logs... > Extension Host`，因为 `Output > ChipMate` 只能覆盖 `activate()` 之后的日志。
- Qwen autocomplete：使用 `Show Qwen Autocomplete Logs` 或 `Export Qwen Autocomplete Diagnostics`。
- AI 注释：看 `Output > ChipMate Comment` 和 review panel 的生成进度。
- 真实安装态：用 VS Code 当前 profile / Remote SSH host 的已安装扩展、SecretStorage、globalStorage 和 Output 日志判断，不要用另一台机器或另一个 profile 的缓存推断。
- Chat stream 失败：先区分 provider/base URL 返回 HTML、非 SSE、无 done marker 等 transport 问题，和后台 CodeGraph/RAG indexing 状态。
- RAG/CodeGraph 升级：卸载扩展通常不会删除 `globalStorage`；版本不匹配或损坏的索引应走加载失败后的重建/恢复路径，而不是在 `deactivate()` 中隐式删除。

## 维护者文档

这些文档在源码仓库中用于 deep dive；VSIX 打包会排除 `docs/**`，所以 README 是主要分发入口。

- `docs/chat-qa-flow.md`：QA / Chat prompt、上下文、tools、permissions 和 evidence 流程。
- `docs/code-completion.md`：inline completion pipeline、路由、postprocess、telemetry 和调试信号。
- `docs/qwen-autocomplete-non-streaming-parity.md`：qwen-direct 与 Continue/kilocode 的非 streaming parity 边界。
- `docs/completion-qa-retrieval-alignment-report.md`：comment-guided completion 与 QA evidence retrieval 对齐报告。
- `docs/completion-p1-verification-report.md`：P1 completion fixture 验证报告。
- `docs/codex-word-parity-matrix.md`：Codex Word/Documents parity 开发计划和逐项打勾矩阵。
- `docs/windows-offline-ui-test.md`：Windows offline UI runner bundle 的构建、运行、覆盖和报告格式。

## Git 与发布备注

本仓库的用户可见插件身份保持为 ChipMate。推送 GitHub 远程时使用 SSH；如果 `git@github.com` 22 端口不可用，按项目说明使用 SSH-over-443。

README 更新本身不改变公共 API、配置 schema、工具 schema 或扩展身份。任何行为变更应在源码、manifest、测试和 README 中分别落地，并在交付前至少通过 `bun run package`。
