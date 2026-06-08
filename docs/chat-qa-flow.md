# QA 问答流程 README

这份文档说明当前 VS Code 插件中 QA/聊天问答的真实实现。它面向维护者和使用者，重点解释一次问题从 VS Code 侧边栏或快捷命令发起后，哪些本地上下文会被收集、怎样拼成 prompt、哪些 evidence 会进入模型，以及普通 QA 与 inline completion 在光标语义上的差异。

相关入口主要在这些文件中：

| 文件 | 主要职责 |
| --- | --- |
| `src/editor-context.ts` | 跟踪当前 `file` scheme 编辑器、选区和光标位置。 |
| `src/chat-view.ts` | 聊天 webview、快捷提问命令、上下文开关、agent/model 选择和发送流程。 |
| `src/context.ts` | 构造 QA prompt、本地文件上下文、diagnostics、git diff、code graph 和 analysis evidence。 |
| `src/remote-client.ts` | 把最终 prompt 作为 OpenCode `/prompt_async` 请求发送给远端服务。 |
| `src/local-agent.ts` | 在 local-only 模式下选择并校验远端 `vscode-local` agent。 |

## 总体链路

QA/聊天不是让远端 OpenCode 自己读取本机文件。插件在 VS Code extension host 中收集本地上下文，然后把整理后的纯文本 prompt 发给远端 OpenCode session：

```text
EditorContextTracker
  -> Chat webview / quick command
  -> contextOptions()
  -> RemoteChatViewProvider.sendMessage()
  -> buildChatPrompt()
  -> buildLocalContext()
  -> optional codeGraph.buildContext()
  -> optional retrieveChatAnalysisEvidence()
  -> sendPreparedMessage()
  -> RemoteOpenCodeClient.sendMessageAsync()
  -> POST /session/:id/prompt_async
```

发送前 `sendMessage()` 会做这些准备：

- 确认已经连接远端 OpenCode server。
- 加载并校验 agent 列表；local-only 模式下必须找到 `opencode.remote.localOnlyAgent`，默认是 `vscode-local`。
- 选择当前模型配置。
- 等待 code graph 到达可用于聊天的状态。
- 调用 `buildChatPrompt()` 生成最终 prompt。
- 通过 `sendMessageAsync()` 发送 `{ model?, agent?, parts: [{ type: "text", text }] }`。

## Prompt 组成

`buildChatPrompt()` 产出的最终文本按块拼接，核心结构如下：

```text
User question:
<用户输入的问题>

Local Context Contract:
<local-only 模式下的回答约束>

Local workspace context:
<workspace、file、diagnostics、git diff 等本地上下文>

Local code graph evidence:
<可选 code graph evidence>

Local analysis evidence pack:
<可选 query trace、answer policy、evidence pack、suggested answer plan>
```

其中只有 `User question` 一定存在。其他块取决于配置、上下文开关、当前 editor 状态和 code graph/RAG 是否可用。

最终发给远端的是一个 text part，而不是结构化的 VS Code editor 状态。`remote-client.ts` 的请求体形态是：

```json
{
  "model": "...",
  "agent": "...",
  "parts": [
    { "type": "text", "text": "<buildChatPrompt output>" }
  ]
}
```

## 本地上下文选择规则

聊天上下文由 `buildLocalContext()` 组装，默认 `Selection` 和 `Current file` 都开启，`Open files` 默认关闭，`Diagnostics` 和 `Git diff` 由设置决定。

同一次请求中，文件上下文按这个顺序加入：

1. 当前编辑器有非空选区，且 `Selection` 开启时，加入选区。
2. 当前编辑器文件尚未因选区加入，且 `Current file` 开启时，加入当前文件。
3. 加入聊天输入框里 `@` mention 的文件。
4. 加入 `Attach` 手动附加的文件。
5. `includeOpenFiles` 开启时，加入其他打开的 `file` scheme 文档。
6. `Diagnostics` 开启时，加入最多 60 条 workspace diagnostics。
7. `Git diff` 开启时，加入当前 workspace 的 `git diff --` 输出。

同一个文件在一次 prompt 中不会重复加入。例如当前文件有选区时，selection 已经代表这个文件，`Current file` 不会再把整文件追加一次。

每个文件上下文都会被格式化成 `<file>` 块：

```xml
<file path="src/example.ts" language="typescript" lines="10-20" source="selection">
...
</file>
```

常见 `source` 包括：

- `selection`：当前选区。
- `current file`：当前编辑器文件。
- `mentioned file`：聊天输入框 `@` 引用的文件。
- `attached file`：手动 Attach 的文件。
- `open file`：可选打开文件上下文。
- `skipped`：二进制、不可读或不支持的文件占位。

## 当前文件、选区与光标

这是 QA 流程里最容易误解的部分：普通 QA 会使用当前 editor 状态选择上下文，但不会把光标位置当成明确的模型语义发送。

选区行为：

- 如果存在非空选区并且 `Selection` 开启，prompt 中加入选区文本。
- `<file>` 属性会写入选区行号范围，例如 `lines="120-145"`。
- 模型可以据此知道用户给的是这一段代码。

当前文件行为：

- 如果当前文件大小不超过 `opencode.remote.context.maxFileBytes`，prompt 中加入整文件，行号范围是 `lines="1-N"`。
- 如果当前文件太大，插件以当前光标行为中心截取前后约 80 行，并可附带文件头部信息，`<file>` 会标记 `truncated="true"`。
- 大文件截窗使用光标行只是为了控制上下文体积；prompt 里不会额外写 `cursorLine` 或 `cursorCharacter`。

普通 QA 不会发送：

- `<cursor>` 标记。
- `cursorLine` 字段。
- `cursorCharacter` 字段。
- “光标停在这里”这类隐藏说明。

因此，如果同一个可见上下文里有两个未完成区域，只把光标停在其中一个位置再问“这个地方应该怎么写”，模型不能可靠知道你指的是哪一个。它只能根据问题、选区、文件片段、行号范围和检索 evidence 推断。

更可靠的提问方式：

- 选中目标未完成区域后提问。
- 在问题里写明函数名、行号或附近代码。
- 使用 `@` 明确引用文件，再用自然语言描述具体位置。
- 如果要让模型围绕某个代码洞回答，不要只依赖光标停留位置。

## Code Graph 与 RAG evidence

当 `opencode.remote.codeGraph.enabled` 开启时，QA prompt 还会尝试加入两类本地分析上下文。

第一类是 `Local code graph evidence`。`buildChatPrompt()` 会把用户问题、已加入的相关文件路径、最大 evidence 字节数、图深度和 fanout 传给 `codeGraph.buildContext()`。这条路径用于注入符号定义、调用者、被调用者、include 关系、状态机线索和少量代码片段。

第二类是 `Local analysis evidence pack`。`retrieveChatAnalysisEvidence()` 会以 `mode: "qa"` 调用 `retrieveRepositoryEvidenceForIntent()`，优先复用 repository evidence orchestration。可用时，它会进入 code graph/RAG 查询，产出 answer policy、query trace、module summaries、state machines、evidence pack 和 suggested grounded answer plan。

启用离线 RAG embedding/rerank 后，analysis evidence 可能来自 hybrid retrieval：exact/path/symbol、BM25/postings、graph evidence、vector candidates 和 rerank trace。不可用时会回退到本地 graph/BM25 等非向量 evidence。

这些 evidence 只作为 prompt 中的本地证据文本发送给远端模型。远端模型仍然不应该读取 server filesystem；local-only contract 会要求它基于随请求提供的本地上下文回答。

## Local-only guard 与 agent

默认 local-only 模式开启。它有两个作用：

- 在 prompt 中加入 `Local Context Contract`，要求回答只基于 `<file>`、`<diagnostics>`、`<git-diff>`、`<local-code-graph>` 和 `<local-analysis-pack>`。
- 当问题明显是在问本地文件，但没有任何可用本地上下文、code graph 或 analysis evidence 时，阻止发送并提示用户打开文件或用 `@file` 引用。

local-only 模式下，发送前还必须校验远端 OpenCode server 存在配置好的 `vscode-local` agent。找不到 agent、agent 列表还没加载、agent 被禁用或校验失败时，聊天请求会 fail closed，不会回退到远端默认 agent。

## 与 Inline Completion 的差异

QA/聊天和 inline completion 使用不同的 prompt 语义。

inline completion 是 cursor-aware 的代码生成流程，补全 prompt 会围绕当前 `linePrefix`、`lineSuffix`、current word、FIM prefix/suffix、插入 range 和 postprocess/edit contract 工作。它必须返回可插入的 ghost text。

普通 QA 是问答流程。它面向解释、分析和建议，发送的是用户问题加本地 evidence 文本。它不会默认构造 FIM hole，也不会要求模型只返回可插入文本。即使 QA 和 completion 在某些路径上共享 repository evidence retrieval core，二者最终 prompt 和输出约束仍然不同。

## 调试入口

排查 QA 上下文问题时，优先看这些信号：

- Output channel 中的 `[context] sent ...`，确认本次发送了 selection、current file、mentioned file 还是 attached file。
- Output channel 中的 `[agent] ...` 和 `[model] ...`，确认 local-only agent 与模型选择。
- 聊天视图的 auto context 状态，确认当前文件和 selection 是否被插件捕获。
- code graph/RAG 日志中的 query trace、vector/rerank/fallback 信息。

如果模型回答像是没看到目标代码，先确认：

- 当前编辑器是否是本地 `file` scheme。
- `Selection` 或 `Current file` 是否开启。
- 目标文件是否太大导致只截取了光标附近窗口。
- 是否只有光标停留而没有选中目标区域。
- 是否缺少 `@` mention 或 Attach 的相关文件。
- local-only guard 是否因为没有本地上下文而阻止了请求。
