# ChipMate

ChipMate 是一个面向嵌入式与本地工程开发的 VS Code coding agent 插件。它不依赖外部代理服务，直接连接 OpenAI-compatible 模型接口，并在 VS Code workspace extension host 中提供聊天、代码问答、inline completion、本地 code graph、RAG evidence、skills、工作区文件工具和 shell 工具。

## 核心能力

- OpenAI-compatible 直连模型：聊天 agent runtime 和 inline completion 都走直连 provider。
- Agent runtime：支持 OpenAI 标准 tool calls、多轮工具调用、工具事件和最大轮次保护。
- Skills 优先：从离线 HTTP catalog 下载 skill 包，安装到 VS Code global storage，并按 `SKILL.md` 暴露激活、资源读取和脚本工具。
- 工作区工具：内置文件搜索、读取、写入和 shell 执行工具。
- MCP stdio：已安装的 MCP 包可通过 `mcp.json` 暴露 stdio `tools/list` 与 `tools/call`。
- 权限配置：支持 `readOnly`、`askApproval`、`trustedWorkspace`、`fullAccess`，覆盖写文件、shell、skill scripts 和 MCP tools。`askApproval` 会在 VS Code 中弹出确认，可选择允许一次、总是允许同类请求或拒绝。
- 本地 code graph 与 RAG：保留现有 QA evidence、符号检索、向量检索和 fallback 编排能力。
- Inline completion：保留原有 completion planner、symbol resolver、retriever、packer、router、postprocessor、inline edit builder、eval fixtures 和 telemetry。
- 离线 catalog：skills 和 MCP 包不预置在 VSIX 内，由内网 HTTP 服务公开 catalog 与 zip 包，用户在插件 UI 中选择下载和安装。

## 使用方式

1. 安装 ChipMate VSIX。
2. 打开 VS Code Activity Bar 中的 ChipMate。
3. 在 Chat 设置里填写 OpenAI-compatible `baseUrl`、模型名和 API key。
4. 在 Skills 设置里填写离线 HTTP catalog URL。
5. 刷新 catalog，选择需要的 skills 或 MCP 包并安装。
6. 在聊天中提问，ChipMate 会按当前权限配置使用已安装 skills、工作区工具和本地 evidence。

API key 会保存在 VS Code SecretStorage。技能包、MCP 包、聊天历史、索引和 catalog 缓存保存在 VS Code global storage，不写入代码仓库。

## OpenAI-compatible 配置示例

```json
{
  "chipmate.chat.apiBaseUrl": "http://127.0.0.1:8000/v1",
  "chipmate.chat.model": "local-chat-model",
  "chipmate.completion.enabled": true,
  "chipmate.completion.apiBaseUrl": "http://127.0.0.1:8000/v1",
  "chipmate.completion.model": "local-coder-model",
  "chipmate.skills.catalogUrl": "http://intranet.example/chipmate/catalog.json",
  "chipmate.permissions.profile": "askApproval"
}
```

补全模型可以和聊天模型分开配置；当补全 base URL 或模型为空时，会回退到聊天配置。

## Catalog 格式

离线 HTTP catalog 返回 JSON：

```json
{
  "version": 1,
  "packages": [
    {
      "id": "embedded-c-review",
      "kind": "skill",
      "name": "Embedded C Review",
      "version": "0.1.0",
      "description": "Review firmware C changes with project conventions.",
      "archiveUrl": "http://intranet.example/chipmate/skills/embedded-c-review.zip",
      "sha256": "optional-sha256",
      "sizeBytes": 12345,
      "entry": "SKILL.md"
    }
  ]
}
```

Skill zip 包里应包含 `SKILL.md`，可选包含 `references/`、`assets/`、`templates/`、`scripts/`。依赖声明保持 optional；没有 dependencies 的 skill 也可以安装和使用。

可以用仓库内置的静态 HTTP 服务直接暴露离线目录：

```bash
bun run catalog:serve -- --root /path/to/chipmate-catalog --host 0.0.0.0 --port 8765
```

目录里放 `catalog.json`、`skills/*.zip`、`mcps/*.zip` 即可。插件设置里的 catalog URL 填 `http://<server-ip>:8765/catalog.json`。

## 开发

```bash
bun install
bun test
bun run package
bun run catalog:serve -- --root ./catalog
bun run vsix
```

`bun run package` 会执行 type check、lint 和 TypeScript 编译。`bun run vsix` 会先执行 package，再生成本地 VS Code 插件包。
