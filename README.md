# ChipMate

ChipMate 是一个运行在 VS Code `workspace` extension host 内的直连 OpenAI-compatible 编码助手。聊天、inline completion、skills、工具调用、RAG 和 code graph 都跟随当前 workspace host 运行。使用 Remote SSH 时，这些能力运行在远端 Linux extension host 上。

## 核心能力

- OpenAI-compatible provider：共享 `chipmate.provider.apiBaseUrl` 和 SecretStorage 中的 provider API key，聊天使用 `chipmate.provider.chatModel`，补全可单独设置 `chipmate.completion.model`。
- Direct chat runtime：使用 `/chat/completions` SSE streaming，支持停止生成、JSONL session 落盘，以及在 `chipmate.tools.enabled=true` 时启用标准 `tool_calls` 和串行工具循环。
- Workspace sessions：聊天历史写入 VS Code global storage 的 `sessions/*.jsonl`，工具审计写入 `audit/*.jsonl`。
- Skills：只发现当前 workspace 下 `.agents/skills/*/SKILL.md`，支持 `name`、`description`、`allowed-tools` 等核心 frontmatter、渐进加载、`scripts/`、`references/`、`assets/` 和动态 `!command` 指令说明。
- Tools：v1 提供 file、command、network 三类工具；默认不向模型暴露工具 schema，开启后统一经过 ChipMate permission mode 判断和审计。
- Permissions：composer 附近提供工具总开关，以及 `请求批准`、`替我审批`、`完全访问权限` 三档模式；默认工具关闭，权限模式默认 `请求批准`。
- Codegraph/RAG：保留本地 C/C++ code graph 和内网 RAG pipeline，但新扩展身份下不迁移旧索引。
- MCP：设置面板中预留 Coming Soon 区块；当前版本不启动 MCP server、不安装 artifact、不暴露 MCP 工具。

## Provider

最小配置：

```json
{
  "chipmate.provider.apiBaseUrl": "http://127.0.0.1:8000/v1",
  "chipmate.provider.chatModel": "qwen-coder",
  "chipmate.completion.enabled": true,
  "chipmate.completion.profile": "qwen-coder-fim",
  "chipmate.completion.model": "qwen-coder-fim"
}
```

Provider API key 通过命令 `ChipMate: Set ChipMate Provider API Key` 或设置面板保存到 VS Code SecretStorage，不写入 `settings.json`。`/models` 发现失败时，ChipMate 会继续使用手填的 chat/completion model。

## Permissions

`chipmate.tools.enabled` 是模型工具调用总开关，默认 `false`。关闭时，direct chat runtime 不会在 `/chat/completions` 请求中发送 `tools` 或 `tool_choice`；如果 provider 仍返回 `tool_calls`，ChipMate 会忽略并且不会执行任何 workspace tool。

`chipmate.permissions.mode` 支持三档：

| Mode | 行为 |
| --- | --- |
| `ask` | 读 workspace 文件自动放行；写文件、命令、网络请求需要审批或被阻断。 |
| `auto` | 自动放行低风险操作，高风险操作仍需要审批或被阻断。 |
| `full-access` | 不拦截工具操作，只记录审计 JSONL。 |

权限模式只在 `chipmate.tools.enabled=true` 时生效。

`allowed-tools` 只作为 skill 提示和审计信息，不能越过当前 permission mode。

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
  - chipmate_run_command
---

Read changed files first. Use `!bun test` only when the active permission mode allows command execution.
```

## Inline Completion

Inline completion 继续保留原有产品级 pipeline：planner、symbol resolver、context retriever、packer、router、postprocessor、inline edit builder、eval fixtures 和 structured telemetry。普通代码补全默认使用 Qwen FIM profile，range 保持单行，并继续避免 echoed prefix、重复注释、空输出和 suffix duplicated output。

## Codegraph And RAG

Codegraph 和 RAG 配置前缀均为 `chipmate.*`：

```json
{
  "chipmate.codeGraph.enabled": true,
  "chipmate.rag.embedding.endpoint": "http://127.0.0.1:8000/v1/embeddings",
  "chipmate.rag.embedding.model": "local-embedding-model",
  "chipmate.rag.rerank.endpoint": "http://127.0.0.1:8000/rerank",
  "chipmate.rag.rerank.model": "local-rerank-model"
}
```

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
