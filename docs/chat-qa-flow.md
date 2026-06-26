# ChipMate QA / Chat Flow README

这份文档说明 ChipMate 聊天问答的真实实现。它面向维护者和使用者，重点解释一次问题从 VS Code 侧边栏或快捷命令发起后，哪些 workspace-host 上下文会被收集、怎样拼成 prompt、哪些 evidence 会进入模型，以及普通 QA 与 inline completion 在光标语义上的差异。

## 关键入口

| 文件 | 主要职责 |
| --- | --- |
| `src/editor-context.ts` | 跟踪当前 `file` scheme 编辑器、选区和光标位置。 |
| `src/chat-view.ts` | 聊天 webview、快捷提问命令、上下文开关、model/permission/skills 状态和发送流程。 |
| `src/context.ts` | 构造 QA prompt、本地文件上下文、diagnostics、git diff、code graph 和 analysis evidence。 |
| `src/direct-agent-client.ts` | 本地 agent loop、OpenAI-compatible SSE streaming、工具熔断、session JSONL。 |
| `src/tool-runtime.ts` | workspace-host file/command/network 工具执行、审批和审计。 |
| `src/skills.ts` | 发现 `.agents/skills/*/SKILL.md` 并按需把 enabled skills 注入 prompt。 |

## 总体链路

QA/聊天运行在 VS Code `workspace` extension host，不依赖外部 session server。Remote SSH 时，模型请求、文件读写、命令、RAG、code graph、sessions 和 audit 都跟随远端 Linux extension host。

```text
EditorContextTracker
  -> Chat webview / quick command
  -> contextOptions()
  -> buildChatPrompt()
  -> buildLocalContext()
  -> optional codeGraph.buildContext()
  -> optional retrieveChatAnalysisEvidence()
  -> DirectAgentClient.sendMessageAsync()
  -> OpenAI-compatible /chat/completions SSE
  -> optional serial tool loop when chipmate.tools.enabled=true
  -> globalStorage/sessions/*.jsonl
  -> globalStorage/audit/*.jsonl
```

发送前 `sendMessage()` 会做这些准备：

- 读取 `chipmate.provider.*` 和 SecretStorage 中的 provider API key；同一个 key 也供 inline completion、RAG embedding 和 RAG rerank 使用。
- 选择当前聊天模型。
- 等待 code graph 到达可用于聊天的状态。
- 收集当前 selection、current file、mentions、attachments、diagnostics、git diff 和 repository evidence。
- 加载 workspace `.agents/skills/*/SKILL.md` 中已启用的 skills。
- 使用 `chipmate.tools.enabled` 决定是否向模型暴露 workspace tools；工具开启后再用当前 `chipmate.permissions.mode` 决定是否需要逐次审批。

## Prompt 组成

`buildChatPrompt()` 产出的最终文本按块拼接，核心结构如下：

```text
User question:
<用户输入的问题>

Local Context Contract:
<workspace-host 回答约束>

Local workspace context:
<workspace、file、diagnostics、git diff 等上下文>

Local code graph evidence:
<可选 code graph evidence>

Local analysis evidence pack:
<可选 query trace、answer policy、evidence pack、suggested answer plan>

Enabled ChipMate skills:
<可选 skill frontmatter 与已加载正文>
```

只有 `User question` 一定存在。其他块取决于配置、上下文开关、当前 editor 状态、skills 启用状态和 code graph/RAG 是否可用。

## Skills

ChipMate 自动发现 workspace 内的 `.agents/skills/*/SKILL.md` 和兼容 `.claude/skills/*/SKILL.md`，并沿 workspace 父目录向上寻找 `.agents/skills`。用户级 `~/.agents/skills` 默认开启；在 `chipmate.skills.scanClaudeSkills=true` 时也会扫描 `~/.claude/skills`，可用 `chipmate.skills.scanUserSkills=false` 关闭用户级扫描。解析范围覆盖 Agent Skills、Codex skills 与 Claude Code skills 的核心交集：

- `name` / `description` frontmatter。
- `allowed-tools` 在 `chipmate.tools.enabled=true` 时作为提示、active skill policy 和审计信息，不绕过用户权限模式；direct chat 渲染 prompt 时还会按本轮实际暴露工具过滤。
- 渐进加载：初始 catalog 只展示元信息；显式 `$skill`/`/skill` 调用或隐式匹配后，才把该 skill 正文注入 prompt。
- 保留并索引 `scripts/`、`references/`、`assets/` 目录结构；active skill 资源通过 `chipmate_read_skill_resource` 读取，脚本不会自动执行。
- 动态 `!command` 只作为 skill 文本中的运行提示，实际执行仍进入 command tool 权限判断。
- Skills 设置页可通过 `Import Skill...` 或导入区拖拽导入 skill 目录、父目录或 `SKILL.md`；导入前会校验当前支持的 `SKILL.md` 格式，有效项统一落到用户级 `~/.agents/skills/<commandName>`。

## Tools 与权限

QA 默认 evidence 先行：首轮请求仍由 `buildChatPrompt()` 发送本地上下文、code graph evidence 和 analysis evidence pack。工具只用于模型发现证据不完整时补充读取 workspace 文件。

当前 direct chat 会向模型暴露受限工具面：

- Workspace/evidence：`chipmate_search_text`、`chipmate_search_code`、`chipmate_read_evidence`、`chipmate_read`、`chipmate_read_skill_resource`。
- CodeGraph：`chipmate_graph_inspect_symbol`、`chipmate_graph_find_references`、`chipmate_graph_callers`、`chipmate_graph_callees`、`chipmate_graph_trace_call_chain`、`chipmate_graph_analyze_impact`、`chipmate_graph_map_module`、`chipmate_graph_find_state_machines`、`chipmate_graph_trace_state_path`。
- Document/Word：`chipmate_search_documents`、`read_docx`、`create_word_document`。
- Workspace 创建/编辑：`chipmate_create_directory`、`chipmate_create_file`、`chipmate_edit_file`。

任意全文件覆盖、删除、重命名、移动、shell 命令和 HTTP 请求不会作为 chat tool definition 发给模型。`chipmate.tools.enabled` 默认 `false`。关闭时，模型请求不包含 `tools` 和 `tool_choice`，即使 provider 返回 `tool_calls` 也不会执行、不会追加 `role: "tool"` 消息、不会进入下一轮工具循环。如果 provider 返回未暴露的工具调用，direct chat 会返回 blocked tool result，不进入真实执行。

权限模式：

- `请求批准`：当前暴露的低风险 workspace 读文件自动放行；未暴露的写文件、命令、网络不会从 direct chat 进入真实执行。
- `替我审批`：低风险操作自动放行，高风险操作仍逐次审批。
- `完全访问权限`：不拦截、不询问，只写审计日志。

所有工具结果都会写入 `globalStorage/audit/*.jsonl`，聊天消息写入 `globalStorage/sessions/*.jsonl`。

## 本地上下文选择规则

聊天上下文由 `buildLocalContext()` 组装，默认 `Selection` 和 `Current file` 开启，`Open files` 默认关闭，`Diagnostics` 和 `Git diff` 由设置决定。

同一次请求中，文件上下文按这个顺序加入：

1. 当前编辑器有非空选区，且 `Selection` 开启时，加入选区。
2. 当前编辑器文件尚未因选区加入，且 `Current file` 开启时，加入当前文件。
3. 加入聊天输入框里 `@` mention 的文件。
4. 加入 `Attach` 手动附加的文件。
5. `includeOpenFiles` 开启时，加入其他打开的 `file` scheme 文档。
6. `Diagnostics` 开启时，加入最多 60 条 workspace diagnostics。
7. `Git diff` 开启时，加入当前 workspace 的 `git diff --` 输出。

`@mention` 和 `Attach` 的文件会先按受支持文档格式解析：`.docx` 提取正文文本；`.xlsx` / `.xlsm` 按工作表输出名称、范围、表头、行列、公式和值；`.pdf` 只提取已有文本层。`.xlsm` 不执行宏；图片型或扫描型 PDF 不做 OCR，会明确提示没有可提取文本层。解析后的内容仍受 `chipmate.context.maxFileBytes` 和 `chipmate.context.maxFiles` 限制。非支持二进制文件继续跳过。

文档解析运行在 VS Code workspace extension host 内，使用随扩展编译进 VSIX 的 TypeScript/JavaScript 代码，不依赖目标机器安装 Poppler、Python 包、Office、外部命令或运行时 npm 下载。打包后可用：

```bash
bun run verify:document-runtime -- chipmate-<version>.vsix
```

确认 VSIX 包含 `extension/dist/document-parser.js`，且没有把整个 `node_modules` 打进去。

普通 QA 会使用当前 editor 状态选择上下文，但不会把光标位置当成明确模型语义发送。如果用户要让模型围绕某个代码洞回答，最好选中目标区域、写明函数名或行号，或者用 `@file` 明确引用。

## Code Graph 与 RAG Evidence

当 `chipmate.codeGraph.enabled` 开启时，QA prompt 会尝试加入 `Local code graph evidence`。当 RAG embedding/rerank 可用时，analysis evidence 还可能来自 exact/path/symbol、BM25/postings、graph evidence、vector candidates 和 rerank trace。

QA analysis evidence 使用用户原始问题和本次本地上下文里的 related paths 发起检索，不套用 inline completion 的 `body-statement`、comment-guided 或 symbol-prefix 查询语义。模块级、文件级和状态机问题应按 QA 的问题类型检索证据，而不是按“当前光标要插入什么代码”检索。

这些 evidence 只作为 prompt 中的本地证据文本发送给模型。模型不应绕过工具权限读取文件；如果工具关闭且证据不足，应说明缺失内容并要求用户打开、附加或 `@mention` 文件。工具开启后，模型应优先通过 evidence/codegraph/document 工具补证据，通过 `chipmate_read_skill_resource` 读取 active skill 资源，通过 `chipmate_read` 补读明确 workspace 文件；需要未暴露的命令、网络、删除、重命名或移动时，应说明需要用户或后续模式提供额外能力。

## 与 Inline Completion 的差异

QA/聊天和 inline completion 使用不同的 prompt 语义。

inline completion 是 cursor-aware 的代码生成流程，补全 prompt 会围绕当前 `linePrefix`、`lineSuffix`、current word、FIM prefix/suffix、插入 range 和 postprocess/edit contract 工作。它必须返回可插入的 ghost text。

普通 QA 面向解释、分析、修改建议和工具调用，发送的是用户问题加本地 evidence 文本。它不会默认构造 FIM hole，也不会要求模型只返回可插入文本。

## 调试入口

排查 QA 上下文问题时，优先看这些信号：

- Output channel 中的 `[context] sent ...`，确认本次发送了 selection、current file、mentioned file 还是 attached file。
- Output channel 中的 `[model] ...`，确认聊天模型选择。
- 聊天视图的 auto context、permissions、skills 状态芯片。
- code graph/RAG 日志中的 query trace、vector/rerank/fallback 信息。
- `globalStorage/audit/*.jsonl` 中的工具审批和执行记录。
