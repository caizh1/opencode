# ChipMate

ChipMate 是一个运行在 VS Code `workspace` extension host 内的直连 OpenAI-compatible 编码助手。聊天、inline completion、skills、工具调用、RAG 和 code graph 都跟随当前 workspace host 运行。使用 Remote SSH 时，这些能力运行在远端 Linux extension host 上。

## 核心能力

- OpenAI-compatible provider：聊天、inline completion、RAG embedding 和 RAG rerank 共享 `chipmate.provider.apiBaseUrl` 和 SecretStorage 中的 provider API key；API key 只需要在 Provider/Chat 设置里填写一次。聊天使用 `chipmate.provider.chatModel`，补全可单独设置 `chipmate.completion.model`。
- Direct chat runtime：使用 `/chat/completions` SSE streaming，支持停止生成、recent chat history、Mermaid fenced diagram 本地渲染、JSONL session 落盘，以及在 `chipmate.tools.enabled=true` 时启用标准 `tool_calls` 和串行工具循环。
- Workspace sessions：聊天历史写入 VS Code global storage 的 `sessions/*.jsonl`，工具审计写入 `audit/*.jsonl`。
- Skills：只发现当前 workspace 下 `.agents/skills/*/SKILL.md`，支持 `name`、`description`、`allowed-tools` 等核心 frontmatter、渐进加载、`scripts/`、`references/`、`assets/` 和动态 `!command` 指令说明。
- Tools：direct chat 默认不向模型暴露工具 schema；开启后当前只暴露 `chipmate_read`，用于读取 workspace host 上的 UTF-8 文本文件。
- Permissions：composer 附近提供工具总开关，以及 `请求批准`、`替我审批`、`完全访问权限` 三档模式；默认工具关闭，权限模式默认 `请求批准`。
- Codegraph/RAG：保留本地 C/C++ code graph 和内网 RAG pipeline，composer 可查看 CodeGraph/RAG 状态；code graph 使用有界分片落盘适配大仓库，索引版本变更时会从 0 重建。
- MCP：设置面板中预留 Coming Soon 区块；当前版本不启动 MCP server、不安装 artifact、不暴露 MCP 工具。

## Provider

最小配置：

```json
{
  "chipmate.provider.apiBaseUrl": "http://127.0.0.1:8000/v1",
  "chipmate.provider.chatModel": "qwen-coder",
  "chipmate.completion.enabled": true,
  "chipmate.completion.profile": "qwen-coder-fim",
  "chipmate.completion.model": "qwen-coder-30b0"
}
```

Provider API key 通过命令 `ChipMate: Set ChipMate Provider API Key` 或 Provider 设置面板保存到 VS Code SecretStorage，不写入 `settings.json`。同一个 key 会用于 chat、inline completion、RAG embedding 和 RAG rerank。`/models` 发现失败时，ChipMate 会继续使用手填的 chat/completion model。

## Context

聊天请求默认会带上少量 recent chat history，便于连续问答。可用 `chipmate.context.maxHistoryTurns` 控制最近轮数，默认 `3`；用 `chipmate.context.maxHistoryBytes` 控制历史上下文上限，默认 `12000` bytes。设置为 `0` 可以关闭对应 history 注入。

## Permissions

`chipmate.tools.enabled` 是模型工具调用总开关，默认 `false`。关闭时，direct chat runtime 不会在 `/chat/completions` 请求中发送 `tools` 或 `tool_choice`；如果 provider 仍返回 `tool_calls`，ChipMate 会忽略并且不会执行任何 workspace tool。

开启后，当前 direct chat 只向模型暴露 `chipmate_read`。写文件、命令执行和 HTTP 请求的 runtime 实现不作为 chat tool definition 发给模型；如果 provider 返回未暴露的工具调用，ChipMate 会返回 blocked tool result，不进入真实执行。

`chipmate.permissions.mode` 支持三档：

| Mode | 行为 |
| --- | --- |
| `ask` | 当前暴露的低风险 workspace 读文件自动放行；未暴露的写文件、命令、网络不会从 direct chat 真实执行。 |
| `auto` | 自动放行已暴露的低风险工具；高风险工具即使未来暴露也仍需策略判断。 |
| `full-access` | 不拦截已暴露的工具操作，只记录审计 JSONL。 |

权限模式只在 `chipmate.tools.enabled=true` 时生效。

`allowed-tools` 只在工具开启时作为 skill 提示和审计信息，不能越过当前 permission mode；direct chat 会按本轮实际暴露工具过滤，目前只会保留 `chipmate_read`。

## Skills

ChipMate 只扫描当前 workspace：

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
  - chipmate_read
---

Read changed files first. If evidence is missing, use `chipmate_read` when tools are enabled; otherwise ask the user to open or @mention the file.
```

## Inline Completion

Inline completion 继续保留原有产品级 pipeline：planner、symbol resolver、context retriever、packer、router、postprocessor、inline edit builder、eval fixtures 和 structured telemetry。普通代码补全默认使用 Qwen FIM profile，range 保持单行，并继续避免 echoed prefix、重复注释、空输出和 suffix duplicated output。

## Codegraph And RAG

Codegraph 和 RAG 配置前缀均为 `chipmate.*`：

```json
{
  "chipmate.codeGraph.enabled": true,
  "chipmate.codeGraph.indexTests": false,
  "chipmate.rag.embedding.endpoint": "http://127.0.0.1:8000/v1/embeddings",
  "chipmate.rag.embedding.model": "qwen3-embedding-8b",
  "chipmate.rag.indexTests": false,
  "chipmate.rag.rerank.endpoint": "http://127.0.0.1:8000/rerank",
  "chipmate.rag.rerank.model": "qwen3-rerank-8b"
}
```

默认情况下，Codegraph 和 RAG 都不会索引路径 segment 精确为 `test` 或 `tests` 的目录，大小写不敏感，例如 `test/foo.c`、`src/tests/foo.c`、`a/Test/b.cpp` 会被跳过；`contest/foo.c`、`testdata/foo.c`、`unit_test/foo.c` 不会被跳过。需要测试代码进入本地 code graph 时，设置 `chipmate.codeGraph.indexTests=true` 并重建 code graph。

`chipmate.rag.indexTests=true` 只有在 `chipmate.codeGraph.indexTests=true` 且 code graph 已包含测试文件时才会为测试路径生成 RAG chunks。切换 Codegraph test 索引策略会触发 code graph 从 0 重建；切换 RAG test 索引策略后，旧 RAG manifest 会因为内容策略不匹配而不被复用。

本地 code graph 使用有界 JSON 分片和 derived sidecar 落盘，避免大仓库保存阶段生成无限增长的单个 JSON。保存阶段会输出 shard planning、large file splitting、part saved 和 manifest saved 进度日志；如果安装新版后索引版本不匹配，会丢弃旧索引并从 0 重建。

RAG endpoint 默认只允许 localhost、私网 IP、内网域名和 `chipmate.rag.allowedHosts` 中显式列出的 host。

## Workspace Agent Guard

`chipmate-local` 是 ChipMate 直连 runtime 暴露的 workspace-host guard agent。`chipmate.context.strictLocalOnlyAgent` 保留为兼容 guard 开关；当前版本的 agent、tools、skills 和 codegraph 都在 VS Code workspace extension host 内运行。`chipmate.tools.enabled=false` 只关闭模型主动工具调用入口，不关闭手动附件、`@mention` 文件、codegraph/RAG evidence 或 inline completion。

## Development

```bash
bun install
bun test
bun run lint
bun run compile
bun run package
```

本地打包：

```bash
bun run vsix
```
