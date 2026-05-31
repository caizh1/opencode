# OpenCode local-vscode-extension 离线内网版百万级整仓理解开发任务清单

> 分析对象：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension>  
> 修订版本：v2，修正“纯离线”定义。  
> 目标：**不允许访问互联网/公网**，但离线环境中允许访问**本机或内网 OpenCode Server**；结合 OpenCode Server 的会话、模型、agent、工具和流式能力，实现百万级整仓代码理解、模块/子模块/功能级工作逻辑分析、状态机切换路径/条件/流程分析。  
> 使用方式：Codex 每完成一项任务，将 `- [ ]` 改为 `- [x]`，并在同一行或下一行补充 PR/commit/test/benchmark 证据。

---

## 0. 这次修订的关键定义

### 0.1 “纯离线”的准确含义

本计划中的“纯离线”不是“不使用任何服务”，而是：

```text
允许：VS Code 扩展 <-> 本机/内网 OpenCode Server <-> 内网模型服务/内网工具服务/本地索引服务
禁止：任何互联网/公网访问、公共 Web Search、公共 Web Fetch、公共模型 API、未知外部主机、未知代理出口
```

### 0.2 允许的核心后端

```text
VS Code Extension
  ├─ Local Analysis Daemon：百万级索引、语义图、状态机、证据检索
  ├─ Local Index DB：SQLite/FTS/Graph/Vector/StateMachine
  └─ OpenCode Server Adapter：连接本机或内网 opencode serve
        ├─ chat/session/message/event
        ├─ model/provider/agent 选择
        ├─ SSE/streaming
        ├─ custom tools 或 MCP tools 调用 Local Analysis Daemon
        └─ 权限策略：禁止公网工具，允许内网分析工具
```

### 0.3 OpenCode Server 的角色

OpenCode Server 不再被视为“违反离线”的远端依赖，而是离线环境中的**受控推理与 agent 编排后端**。VS Code 扩展负责本地代码索引、证据检索、路径跳转和 UI；OpenCode Server 负责模型推理、会话管理、agent/tool 调度和流式响应。

### 0.4 两种离线工作模式

| 模式 | 说明 | 适用场景 | 默认建议 |
|---|---|---|---|
| `context-only` | OpenCode Server 不直接读取工作区，只接收 VS Code/Local Analysis Daemon 提供的 evidence pack | 服务器不挂载源码、代码不得离开编辑机文件系统 | 默认 |
| `shared-workspace` | OpenCode Server 可访问同一份只读源码镜像，并可通过受控 read/grep/lsp/analysis tools 查询 | 服务器在同一内网构建机/分析机，仓库镜像已脱敏或授权 | 可选 |

---

## 1. 任务勾选规则

- [ ] RULE-01：勾选时只把 `- [ ]` 改成 `- [x]`，不要删除任务原文。
- [ ] RULE-02：每个完成项后补充证据：PR 编号、commit hash、测试命令、截图、日志或 benchmark 报告路径。
- [ ] RULE-03：没有证据的任务不要勾选；只能标注为 `blocked:`、`partial:` 或 `needs-review:`。
- [ ] RULE-04：涉及行为变更的任务必须至少执行相关 `bun test`。
- [ ] RULE-05：发布或打包前必须执行 `bun run package`。
- [ ] RULE-06：涉及离线能力的任务必须在禁公网环境下验证，允许连接配置好的本机/内网 OpenCode Server。
- [ ] RULE-07：涉及 OpenCode Server 的任务必须记录 server URL、网络策略、agent 名称、工具权限和 health probe 结果。
- [ ] RULE-08：涉及状态机抽取的任务必须给出 `states / transitions / guards / actions / evidence file:line`。
- [ ] RULE-09：涉及百万级能力的任务必须给出文件数、LOC、索引耗时、峰值内存、索引体积、查询 P50/P95/P99、增量更新时间。
- [ ] RULE-10：涉及模型回答的任务必须给出 evidence 引用策略和无证据拒答策略。

---

## 2. 当前结论，按“离线内网 OpenCode Server”重新校准

当前分支可定位为：**VS Code 本地上下文 + 内网/远端 OpenCode Server 对话 + 本地 C/C++ 轻量 code graph 辅助检索**。

它已经具备：

- VS Code 扩展入口、命令、状态栏、SecretStorage、Webview Chat、inline completion provider。
- OpenCode Server 连接、health probe、Basic Auth、session/message、SSE/event stream 相关能力。
- 本地上下文采集：当前文件、选区、打开文件、手动附加文件、`@mention` 文件、诊断、Git diff。
- local-only prompt contract 与 strict local-only agent 选择机制。
- C/C++ 轻量 code graph：include、macro、function、call、type/global/tokens、Tree-sitter AST 摘要、倒排检索、模块统计、增量 watcher。
- inline completion：debounce、cache、pending 复用、取消、响应清洗、缩进和格式化。

按新定义，当前没有问题的部分：

- 连接本机或内网 OpenCode Server 是允许的。
- 聊天和补全依赖 OpenCode Server 是允许的，只要该 server 不访问公网。
- OpenCode Server 可作为模型/agent/tool 编排中心。

尚未达到目标的部分：

- 缺少“禁公网但允许本机/内网 OpenCode Server”的明确策略、配置、allowlist 和审计。
- 缺少 OpenCode Server 能力探测：版本、OpenAPI schema、SSE、session/message、provider/model、agent、tool 权限、custom tools/MCP tools。
- 缺少将 Local Analysis Daemon 暴露给 OpenCode Server 的工具层，使 OpenCode 能主动查询百万级索引、状态机、调用图和 evidence。
- 百万级整仓能力仍未达到：当前索引仍偏扩展进程内轻量实现，缺持久 DB、独立 daemon、分片、增量恢复和百万级压测。
- 多语言语义图仍不足：当前重点是 C/C++ 轻量解析，semantic mode 仍需真正接入 clangd/SCIP/LSIF/LSP。
- 业务状态机抽取仍不足：已有 AST if/switch/case 摘要，但缺面向目标仓库的 `state / transition / guard / action / path` 抽取器。
- 模块/子模块/功能级稳定理解仍不足：缺分层摘要、功能地图、跨语言依赖图、状态机图、证据钻取 UI 和答案校验。

---

## 3. 修订后的目标架构

```text
┌───────────────────────────────────────────────────────────────────┐
│ VS Code Extension                                                  │
│  ├─ Webview Chat / Code Intelligence UI                            │
│  ├─ Inline Completion Provider                                     │
│  ├─ Context Builder / Evidence Packer                              │
│  ├─ OpenCode Server Adapter                                        │
│  ├─ Offline Network Policy                                         │
│  └─ Local Analysis Client                                          │
└───────────────────────────────────────────────────────────────────┘
              │                                  │
              │ local IPC/HTTP                   │ HTTP/SSE, only allowlist host
              ▼                                  ▼
┌─────────────────────────────┐       ┌─────────────────────────────┐
│ Local Analysis Daemon        │       │ OpenCode Server              │
│  ├─ repo crawler             │       │  ├─ session/message/event     │
│  ├─ parser workers           │       │  ├─ model/provider/agent      │
│  ├─ semantic graph builder   │       │  ├─ custom tools/MCP tools    │
│  ├─ state machine extractor  │◄──────┤  └─ no public web tools       │
│  ├─ retrieval planner        │       └─────────────────────────────┘
│  └─ query/evidence API       │                     │
└─────────────────────────────┘                     │ only intranet/local
              │                                      ▼
              ▼                         ┌─────────────────────────────┐
┌─────────────────────────────┐          │ Intranet Model Services      │
│ Local Index Store            │          │  ├─ LLM                     │
│  ├─ files/snapshots          │          │  ├─ embedding optional       │
│  ├─ symbols/edges/modules    │          │  ├─ rerank optional          │
│  ├─ FTS/BM25/vector          │          │  └─ provider gateway optional│
│  └─ state machines/evidence  │          └─────────────────────────────┘
└─────────────────────────────┘
```

---

## 4. 能力矩阵，按新定义重评

| 目标要求 | 当前达到程度 | 修订判断 |
|---|---|---|
| 禁公网离线环境 | 部分达到 | 能连接 OpenCode Server，但还没有明确区分 `public remote`、`intranet server`、`localhost server`，也没有完整 allowlist、工具权限和审计。 |
| 结合 OpenCode Server | 部分达到 | 已有 server 连接和 chat/completion 基础；还缺 OpenAPI schema 探测、能力注册、agent 权限校验、custom tools/MCP 工具桥接。 |
| 百万级整仓理解 | 未达到 | 需要独立 Local Analysis Daemon、持久化分片索引、百万级 benchmark、查询 cost model。 |
| 模块/子模块/功能逻辑理解 | 部分达到 | 可拼接文件/符号 evidence；缺分层摘要、模块职责图、功能流程图、跨模块调用路径。 |
| 状态机路径/条件/流程 | 产品自身状态机较清晰；目标代码状态机未达到 | 需要专门 StateMachineExtractor 和 UI。 |
| 安全边界 | 部分达到 | 有 local-only prompt；还需要 OpenCode Server tool permission、webfetch/websearch 禁用、egress 审计、敏感文件策略。 |

---

## 5. 产品内部状态机，需保留并增强

### 5.1 OpenCode Server 连接状态机

```text
[unconfigured]
  -> set serverUrl
[configured]
  -> connect/test
[connecting]
  -> health ok + auth ok + capability probe ok -> [connected]
  -> auth error                         -> [authFailed]
  -> not allowlisted                    -> [blockedByOfflinePolicy]
  -> timeout/network/unhealthy          -> [error]
[connected]
  -> SSE open                           -> [streamReady]
  -> SSE fail                           -> [connectedWithPollingFallback]
  -> disconnect/dispose                 -> [disconnected]
```

- [ ] STATE-CONN-01：在代码中显式建模 `blockedByOfflinePolicy` 状态。
- [ ] STATE-CONN-02：连接前校验 server URL 是否为本机、私网网段或用户配置的内网域名。
- [ ] STATE-CONN-03：连接成功后执行 health probe、OpenAPI schema probe、SSE probe、session/message probe。
- [ ] STATE-CONN-04：连接成功后显示 server 类型：`localhost`、`private-lan`、`approved-intranet-domain`。
- [ ] STATE-CONN-05：连接失败时区分 auth、network、policy、schema、version、SSE、server unhealthy。

### 5.2 聊天状态机

```text
UI idle
  -> user send
  -> build evidence from Local Analysis Daemon
  -> no evidence for local-code question -> local refusal or clarification
  -> ensure OpenCode session
  -> prompt_async/message send
  -> streaming
  -> finalizing
  -> indexed answer/evidence trace stored
```

- [ ] STATE-CHAT-01：聊天发送前必须经过 evidence planner。
- [ ] STATE-CHAT-02：聊天发送前必须经过 offline network policy。
- [ ] STATE-CHAT-03：OpenCode Server 无 SSE 时允许 blocking fallback，但必须在 UI 显示降级。
- [ ] STATE-CHAT-04：模型回答后执行 evidence verifier，检查 file:line 是否存在。
- [ ] STATE-CHAT-05：回答无证据或证据不足时标注 low confidence，不允许强结论。

### 5.3 索引状态机

```text
[disabled]
  -> enable analysis
[indexingFull]
  -> success -> [ready]
  -> cancel  -> [paused]
  -> crash   -> [recovering]
[ready]
  -> watcher events -> [indexingIncremental]
  -> huge changes   -> [rescanScheduled]
[indexingIncremental]
  -> success -> [ready]
  -> error   -> [degraded]
```

- [ ] STATE-IDX-01：Local Analysis Daemon 输出统一状态：disabled/indexingFull/indexingIncremental/ready/degraded/paused/recovering/error。
- [ ] STATE-IDX-02：每个状态带进度、当前 shard、队列长度、错误数、最后更新时间。
- [ ] STATE-IDX-03：百万级仓库 watcher 风暴时自动进入 `rescanScheduled` 而不是逐事件处理。
- [ ] STATE-IDX-04：索引 crash 后可从 snapshot 和 job checkpoint 恢复。
- [ ] STATE-IDX-05：UI 中展示索引状态机和最近状态切换记录。

### 5.4 目标代码状态机抽取状态

```text
[scanCandidates]
  -> detect state variables
[extractTransitions]
  -> derive guards/actions/events
[linkCrossFunction]
  -> build graph/path
[verifyEvidence]
  -> render JSON/Mermaid/UI
```

- [ ] STATE-SM-01：状态机抽取器输出每个阶段耗时和候选数量。
- [ ] STATE-SM-02：低置信度 transition 不进入默认图，只进入候选表。
- [ ] STATE-SM-03：每条 transition 必须绑定 evidence range。
- [ ] STATE-SM-04：状态机图支持从 UI 点击跳转源码。
- [ ] STATE-SM-05：状态机查询结果可被 OpenCode Server 通过 custom tool/MCP tool 调用。

---

## 6. MVP：离线内网 OpenCode Server 版最小可行增强

- [ ] MVP-01：新增 `offlineMode = disabled | intranet-opencode | strict-airgap` 配置。
- [ ] MVP-02：新增 `opencode.remote.allowedServerHosts`，只允许 localhost、私网 CIDR、显式内网域名。
- [ ] MVP-03：新增 OpenCode Server capability probe：health、version、OpenAPI doc、SSE event、session、message、provider/model、agent。
- [ ] MVP-04：新增 OpenCode Server tool permission 检查提示，要求禁用 `webfetch/websearch` 或在离线策略下 hard block。
- [ ] MVP-05：新增 `LocalAnalysisDaemon v0`，把现有 C/C++ code graph 从扩展进程迁移到独立进程或 worker。
- [ ] MVP-06：新增 SQLite + FTS 索引存储；先迁移 files、symbols、edges、postings、modules。
- [ ] MVP-07：新增 Analysis Tool Bridge v0，让 OpenCode Server 可通过内网 custom tool/MCP tool 查询本地索引。
- [ ] MVP-08：新增 `StateMachineExtractor v0`，支持 C/C++ `enum` + `switch(state)` + `state = X` + `if guard`。
- [ ] MVP-09：Webview 新增 `Code Intelligence` 面板：索引状态、模块树、符号搜索、状态机列表、证据跳转。
- [ ] MVP-10：新增禁公网 E2E：断互联网，但保留本机/内网 OpenCode Server，chat/completion/analysis 能工作。
- [ ] MVP-11：新增 synthetic repo benchmark：10k、100k、250k 文件；MVP 阶段可先不要求 1M 完整通过。
- [ ] MVP-12：MVP 验收必须输出：测试命令、OpenCode Server 配置、网络策略、索引报告、状态机 JSON/Mermaid、截图或日志。

---

## 7. 里程碑开发计划

### M0：边界定义与基线固化

- [ ] M0-01：更新 README，明确“离线 = 禁公网 + 允许本机/内网 OpenCode Server”。
- [ ] M0-02：更新配置说明，区分 `public remote`、`localhost opencode`、`intranet opencode`、`strict airgap`。
- [ ] M0-03：新增 ADR：为什么推理层使用 OpenCode Server，索引层使用 Local Analysis Daemon。
- [ ] M0-04：新增 ADR：`context-only` 与 `shared-workspace` 两种模式的安全边界。
- [x] M0-05：建立现有功能 smoke test：连接、聊天、SSE fallback、上下文构建、code graph 索引、inline completion。证据：commit `0e61e0304`；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] M0-06：记录当前性能基线：中型 C/C++ 仓库索引时间、峰值内存、查询延迟、索引体积。
- [ ] M0-07：统一日志结构：connect、server-probe、network-policy、chat、context、analysis、codegraph、state-machine、completion、security、benchmark。
- [ ] M0-08：CI 执行 `bun test`。
- [ ] M0-09：CI 执行 `bun run package`。
- [ ] M0-10：验收：当前能力不退化，文档清楚说明离线内网 OpenCode Server 的部署边界。

### M1：OpenCode Server 离线内网适配

- [ ] M1-01：把现有 `RemoteOpenCodeClient` 抽象为 `OpenCodeServerAdapter`。
- [ ] M1-02：实现 server URL policy：localhost、私网 CIDR、内网域名 allowlist、公网 hard fail。
- [x] M1-03：实现 OpenCode health/version probe。证据：`src/remote-client.ts` 已实现 `/global/health`；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] M1-04：实现 OpenAPI schema 拉取与本地缓存，用于接口兼容性检查。
- [ ] M1-05：实现 SSE event probe，失败时标注是否启用 blocking fallback。
- [ ] M1-06：实现 session/message capability probe。
- [x] M1-07：实现 provider/model/agent 列表加载与缓存。证据：`RemoteOpenCodeClient.listModels/listAgents` 与 Webview refresh flow；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] M1-08：实现 agent 权限配置提示，提醒禁用公网工具。
- [x] M1-09：实现 Basic Auth/SecretStorage 与连接测试流程。证据：`RemoteOpenCodeClient` Basic Auth、`settings.ts` SecretStorage、连接测试命令；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] M1-10：实现连接诊断报告导出：URL 分类、auth、health、schema、SSE、agent、tool policy。
- [ ] M1-11：验收：禁公网环境下可连接本机/内网 OpenCode Server，聊天与补全基础链路可用。

### M2：Local Analysis Daemon 与持久化索引

- [ ] M2-01：定义 `LocalAnalysisService` 协议：status、index、query、stateMachine、graph、summary、cancel、metrics。
- [ ] M2-02：实现 daemon/worker 进程启动、停止、健康检查、版本检查。
- [ ] M2-03：实现 workspace crawler：git ls-files、ignore 规则、大小限制、二进制过滤、敏感文件过滤。
- [ ] M2-04：实现 hash snapshot：path、size、mtime、sha256、language、module、shard。
- [ ] M2-05：实现全量索引 job queue。
- [ ] M2-06：实现增量索引 job queue。
- [ ] M2-07：实现 job cancel/pause/resume。
- [ ] M2-08：实现 crash recovery。
- [ ] M2-09：实现 SQLite schema：files、symbols、edges、postings、modules、state_machines、summaries、snapshots、schema_version。
- [ ] M2-10：实现 FTS/BM25 检索。
- [ ] M2-11：实现 graph edge 存储：call/include/import/type/reference/state-transition。
- [ ] M2-12：实现 schema migration。
- [ ] M2-13：扩展端只通过 client 查询 daemon，不在 extension host 内承载百万级主索引。
- [ ] M2-14：验收：10 万级文件索引时 VS Code UI 不明显卡顿，daemon 可恢复，查询能返回 file:line evidence。

### M3：OpenCode Server 与本地索引的工具桥接

- [ ] M3-01：定义 Analysis Tool API：search、getFileSlice、getSymbol、getCallers、getCallees、getCallChain、getModuleMap、getStateMachines、getStatePath、queryEvidence。
- [ ] M3-02：实现 VS Code 侧 direct evidence pack 模式：扩展先查 daemon，再把 evidence 放进 prompt。
- [ ] M3-03：实现 OpenCode custom tool 模式：OpenCode Server 通过 `.opencode/tools/` 调用 Local Analysis Daemon。
- [ ] M3-04：实现 OpenCode MCP tool 模式：Local Analysis Daemon 暴露 MCP server，OpenCode Server 调用。
- [ ] M3-05：实现工具调用权限策略：只允许 analysis tools，默认禁用 webfetch/websearch，edit/bash 视模式决定。
- [ ] M3-06：实现工具调用审计：tool name、args 摘要、返回 evidence 数、耗时、是否被阻断。
- [ ] M3-07：实现工具返回预算控制：最大片段数、最大字节数、最大路径数、最大图边数。
- [ ] M3-08：实现 query trace：用户问题 -> intent -> 检索工具 -> evidence -> prompt -> 回答 -> verifier。
- [ ] M3-09：验收：OpenCode Server 能主动查询本地索引回答“谁调用了 X”“模块 A 到 B 的调用链”“状态 A 到 B 的切换条件”。

### M4：语义图增强

- [ ] M4-01：接入 `compile_commands.json`，解析 include path、defines、compiler args、build target。
- [ ] M4-02：新增 `SemanticProvider` 接口，支持 clangd、SCIP/LSIF、ctags fallback。
- [ ] M4-03：C/C++ semantic mode 不再静默降级；降级必须记录原因、能力缺失和 confidence。
- [ ] M4-04：把函数调用从 name-level 提升到 symbolId-level，记录 callee、callsite range、confidence。
- [ ] M4-05：补齐 include/import graph、symbol graph、call graph、module graph 的统一边模型。
- [ ] M4-06：支持宏、条件编译、命名空间、重载、函数指针的置信度标注。
- [ ] M4-07：扩展 Tree-sitter 多语言基础解析，至少支持 C/C++、TypeScript/JavaScript、Python、Go。
- [ ] M4-08：支持 LSP call hierarchy/definition/references 作为可选增强。
- [ ] M4-09：验收：golden 仓库 callers/callees/call-chain 达到可量化 precision/recall；C/C++ + 至少一种脚本语言通过。

### M5：业务状态机抽取

- [ ] M5-01：实现 `StateMachineExtractor` 子系统。
- [ ] M5-02：识别候选状态变量：`state/status/mode/phase/stage/event` 命名、enum、macro、typedef、结构体字段、函数参数。
- [ ] M5-03：识别状态集合：enum 成员、宏常量、字符串常量、有限整型常量。
- [ ] M5-04：识别转移语句：`state = X`、字段写入、`set_state/update_state/transition_to`、返回值驱动状态变化。
- [ ] M5-05：提取事件与 guard：上层 `if/else`、`switch case`、循环条件、错误码、消息类型、函数入参、调用上下文。
- [ ] M5-06：提取 action：转移前后调用函数、日志、资源操作、队列/消息发送、锁操作。
- [ ] M5-07：支持跨函数传播：从入口函数、handler、callback、任务循环沿调用图传播状态变量。
- [ ] M5-08：实现路径合成：`source state -> event/guard/action -> target state` directed graph。
- [ ] M5-09：支持 reachability、dead state、cycle、error path 查询。
- [ ] M5-10：每条 transition 记录 `file:start_line-end_line` evidence。
- [ ] M5-11：为状态机、状态、转移、路径标注 confidence。
- [ ] M5-12：输出 JSON transition table。
- [ ] M5-13：输出 Mermaid state diagram。
- [ ] M5-14：输出 DOT/Graphviz 图。
- [ ] M5-15：将状态机查询暴露给 VS Code UI 和 OpenCode Analysis Tool。
- [ ] M5-16：验收：真实模块可输出状态表、转移表、路径、guard/action 和证据；未知路径明确标注。

### M6：分层理解与离线 RAG

- [ ] M6-01：建立函数级摘要，摘要必须关联 source evidence。
- [ ] M6-02：建立文件级摘要，包含核心符号、输入输出、依赖、状态机、风险点。
- [ ] M6-03：建立目录/模块级摘要，支持模块职责、子模块划分、关键流程、调用入口。
- [ ] M6-04：建立子系统级摘要，支持跨模块流程说明。
- [ ] M6-05：实现 hybrid retrieval：exact path + symbol table + BM25 + vector optional + graph expansion + state-machine index。
- [ ] M6-06：实现 evidence packer：dedupe、line range、confidence、byte/token budget、missing evidence notes。
- [ ] M6-07：实现 answer policy：只基于 evidence 回答，必须引用 file:line，无证据时拒答或提示缺失。
- [ ] M6-08：embedding/rerank 优先通过内网 OpenCode Server 或内网模型服务提供；VS Code 扩展不直接访问公网。
- [ ] M6-09：支持无 embedding 的纯 BM25 + graph + state-machine fallback。
- [ ] M6-10：验收：用户可问“某模块某功能流程”，答案包含结构化流程、调用链、状态机和证据行。

### M7：百万级规模化

- [ ] M7-01：实现分片倒排索引，支持按语言、目录、模块、shard 懒加载。
- [ ] M7-02：实现批量 IO 和并行解析 worker pool。
- [ ] M7-03：实现 watcher 降级策略：大量变更时从 file watcher 切换为周期扫描/快照对比。
- [ ] M7-04：实现冷热缓存策略：热模块、热符号、热查询结果、摘要缓存。
- [ ] M7-05：实现内存水位线和自动降级策略。
- [ ] M7-06：实现 synthetic repo generator，覆盖 10k / 100k / 250k / 1M 文件规模。
- [ ] M7-07：实现 benchmark 命令，输出索引时间、吞吐、峰值内存、DB 体积、查询 P50/P95/P99、增量更新时间。
- [ ] M7-08：实现 crash recovery，索引中断后可恢复。
- [ ] M7-09：实现 schema migration 和索引版本兼容策略。
- [ ] M7-10：验收：构造或真实百万级仓库基准通过，查询延迟、内存峰值、索引时间和增量更新有报告。

### M8：产品化、安全和交付

- [ ] M8-01：新增模块树 UI，可从 workspace drill down 到目录、模块、文件、函数。
- [ ] M8-02：新增状态机浏览器，支持状态列表、转移表、路径查询、图形导出、证据跳转。
- [ ] M8-03：新增调用图/依赖图视图，支持 callers、callees、call-chain、impact。
- [ ] M8-04：新增 evidence panel，展示证据片段、line range、confidence、query trace。
- [ ] M8-05：新增索引健康仪表盘：进度、队列、错误、stale 文件、DB 体积、性能指标。
- [ ] M8-06：新增审计日志：模型请求、外发内容、工具调用、被拦截请求、敏感文件过滤结果。
- [ ] M8-07：新增敏感文件策略：`.env`、secret、key、证书、私钥、凭据文件默认不进入 prompt/index summary。
- [ ] M8-08：新增 OpenCode Server 离线权限模板，禁用公网工具，按模式限制 read/grep/bash/edit。
- [ ] M8-09：新增 workspace trust 与权限提示，用户明确授权后才索引大型仓库或敏感目录。
- [ ] M8-10：新增离线安装包说明：VSIX、OpenCode Server、Local Analysis Daemon、模型/embedding/rerank 服务、依赖包。
- [ ] M8-11：验收：离线内网模式无公网访问，用户能在 UI 中钻取模块、函数、状态机和证据，安全策略可配置可审计。

---

## 8. P0 必须先做的详细 Backlog

### P0-01：离线内网 OpenCode Server 配置与策略

- [ ] P0-01a：新增配置 `opencode.remote.offlineMode = disabled | intranet-opencode | strict-airgap`。
- [ ] P0-01b：新增配置 `opencode.remote.serverTrustLevel = public | intranet | localhost`。
- [ ] P0-01c：新增配置 `opencode.remote.allowedServerHosts`。
- [ ] P0-01d：新增配置 `opencode.remote.allowedCidrs = [127.0.0.1/32, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16]`，允许用户收紧。
- [ ] P0-01e：新增配置 `opencode.remote.blockPublicNetwork = true`。
- [ ] P0-01f：新增 server URL 分类函数：localhost/private-cidr/intranet-domain/public-ip/public-domain/invalid。
- [ ] P0-01g：连接 OpenCode Server 前先执行 policy check，失败不发起 fetch。
- [ ] P0-01h：所有 fetch/SSE 请求统一走 `NetworkPolicyGuard`。
- [ ] P0-01i：UI 中显示当前 offline policy 和 server 分类。
- [ ] P0-01j：审计日志记录所有被拦截请求。

### P0-02：OpenCode Server 能力探测

- [x] P0-02a：实现 `/global/health` 探测。证据：`RemoteOpenCodeClient.health()`；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] P0-02b：实现 `/doc` OpenAPI schema 探测和本地缓存。
- [ ] P0-02c：实现 `/global/event` SSE 探测。
- [ ] P0-02d：实现 `/session` 列表/创建能力探测。
- [ ] P0-02e：实现 `/session/status` 能力探测。
- [ ] P0-02f：实现 message send/stream 能力探测。
- [x] P0-02g：实现 provider/model 列表探测。证据：`RemoteOpenCodeClient.listModels()` 支持 config providers 与 provider fallback；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [x] P0-02h：实现 agent 列表探测。证据：`RemoteOpenCodeClient.listAgents()` 与 local-only agent normalization；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] P0-02i：实现 capability report 输出到 OutputChannel。
- [ ] P0-02j：server schema 不兼容时给出可操作错误，而不是静默失败。

### P0-03：OpenCode agent/tool 权限模板

- [ ] P0-03a：新增 `opencode.offline.contextOnlyAgentName = vscode-local-analysis`。
- [ ] P0-03b：生成 context-only agent 示例配置：禁止 read/grep/glob/list/bash/edit/webfetch/websearch，只允许 question 和 analysis tools。
- [ ] P0-03c：生成 shared-workspace agent 示例配置：允许 read/grep/lsp/analysis tools，禁止 webfetch/websearch，bash/edit 默认 ask 或 deny。
- [ ] P0-03d：新增工具权限检查文档，说明 OpenCode Server 端必须禁用公网工具。
- [ ] P0-03e：在连接诊断中提示当前 agent 是否符合离线建议。
- [ ] P0-03f：提供 `.opencode/tools/local_analysis.ts` 示例。
- [ ] P0-03g：提供 MCP server 配置示例。
- [ ] P0-03h：提供 `OPENCODE_SERVER_PASSWORD` 配置说明。
- [ ] P0-03i：审计 tool call：工具名、参数摘要、耗时、返回 evidence 数量。
- [ ] P0-03j：公网工具被调用时 hard fail，并记录 audit event。

### P0-04：Local Analysis Service 接口

- [ ] P0-04a：定义 `status()` API。
- [ ] P0-04b：定义 `index(workspace, options)` API。
- [ ] P0-04c：定义 `query(query, scope, budget)` API。
- [ ] P0-04d：定义 `getFileSlice(path, range)` API。
- [ ] P0-04e：定义 `getSymbol(symbolId)` API。
- [ ] P0-04f：定义 `getCallers(symbolId|name)` API。
- [ ] P0-04g：定义 `getCallees(symbolId|name)` API。
- [ ] P0-04h：定义 `getCallChain(from, to, constraints)` API。
- [ ] P0-04i：定义 `stateMachine(scope, query)` API。
- [ ] P0-04j：定义 `metrics()` API。
- [ ] P0-04k：在 `extension.ts` 中通过 gateway 调用，不直接跑重索引。

### P0-05：持久化索引库

- [ ] P0-05a：设计 schema：files、symbols、edges、postings、modules、state_machines、summaries、snapshots、schema_version。
- [ ] P0-05b：实现文件快照表：path、size、mtime、sha256、language、module、shard。
- [ ] P0-05c：实现符号表：symbol_id、kind、name、fq_name、file、range、signature、confidence。
- [ ] P0-05d：实现调用/依赖边表：src、dst、edge_kind、range、confidence、build_config。
- [ ] P0-05e：实现 FTS postings：term、doc_id、field、weight。
- [ ] P0-05f：实现 moduleStats 与 directoryStats 持久化。
- [ ] P0-05g：实现 state_machines、states、transitions、evidence_refs 表。
- [ ] P0-05h：实现 schema version 与 migration。

### P0-06：状态机抽取 v0

- [ ] P0-06a：支持 C/C++ enum 状态集合。
- [ ] P0-06b：支持 macro 常量状态集合。
- [ ] P0-06c：支持 `switch(state)`。
- [ ] P0-06d：支持 `if (state == X)` guard。
- [ ] P0-06e：支持 `state = Y` assignment transition。
- [ ] P0-06f：支持 action 函数调用提取。
- [ ] P0-06g：输出 JSON。
- [ ] P0-06h：输出 Mermaid。
- [ ] P0-06i：每条 transition 带 evidence。
- [ ] P0-06j：状态机结果可被 OpenCode Analysis Tool 查询。

### P0-07：评测框架

- [ ] P0-07a：新增 codegraph recall fixtures。
- [ ] P0-07b：新增状态机 golden fixtures。
- [ ] P0-07c：新增 OpenCode Server mock fixtures。
- [ ] P0-07d：新增禁公网/允许内网 server E2E fixture。
- [ ] P0-07e：新增性能基准。
- [ ] P0-07f：新增离线安全基准。
- [ ] P0-07g：新增回归报告输出。
- [ ] P0-07h：CI 中至少运行小型 fixture。

---

## 9. P1 增强准确性与体验

### P1-01：多语言与语义能力

- [ ] P1-01a：解析 `compile_commands.json`。
- [ ] P1-01b：探测 clangd 路径与版本。
- [ ] P1-01c：探测 scip-clang 路径与版本。
- [ ] P1-01d：把 semantic call edge 映射到统一 edge schema。
- [ ] P1-01e：semantic 不可用时输出降级原因。
- [ ] P1-01f：支持 TypeScript/JavaScript 符号、import、函数调用。
- [ ] P1-01g：支持 Python 符号、import、函数调用。
- [ ] P1-01h：支持 Go 符号、import、函数调用。
- [ ] P1-01i：支持 Rust 符号、use、函数调用。
- [ ] P1-01j：支持 Java 类、方法、import。

### P1-02：分层摘要

- [ ] P1-02a：函数摘要。
- [ ] P1-02b：文件摘要。
- [ ] P1-02c：目录摘要。
- [ ] P1-02d：模块摘要。
- [ ] P1-02e：子系统摘要。
- [ ] P1-02f：摘要必须绑定 evidence_refs。
- [ ] P1-02g：摘要支持增量更新。
- [ ] P1-02h：摘要可由 OpenCode Server 生成，但必须由 verifier 校验 evidence。
- [ ] P1-02i：摘要生成任务支持队列、取消、重试。
- [ ] P1-02j：摘要过期时标记 stale，不直接用于强结论。

### P1-03：混合检索/RAG planner

- [ ] P1-03a：intent classifier 支持 overview、module logic、submodule logic、callers、callees、call-chain、impact、state-machine、code search。
- [ ] P1-03b：path/symbol extraction。
- [ ] P1-03c：module scope inference。
- [ ] P1-03d：BM25 检索。
- [ ] P1-03e：向量检索 optional，来源必须是内网模型服务或 OpenCode Server，不允许公网。
- [ ] P1-03f：图扩展。
- [ ] P1-03g：状态机索引扩展。
- [ ] P1-03h：rerank optional，来源必须是内网服务。
- [ ] P1-03i：evidence pack。
- [ ] P1-03j：query trace UI。

### P1-04：图谱和状态机 UI

- [ ] P1-04a：模块树。
- [ ] P1-04b：符号搜索。
- [ ] P1-04c：调用图。
- [ ] P1-04d：状态机图。
- [ ] P1-04e：证据表。
- [ ] P1-04f：点击跳转源码。
- [ ] P1-04g：Mermaid/DOT/SVG 导出。
- [ ] P1-04h：显示 confidence。
- [ ] P1-04i：显示 query trace。
- [ ] P1-04j：显示 OpenCode Server 工具调用结果。

---

## 10. P2 高级能力

- [ ] P2-01：按 build target 存储符号/边。
- [ ] P2-02：按宏配置区分 include/call/state transition。
- [ ] P2-03：查询时允许选择 build config。
- [ ] P2-04：支持团队共享只读索引 artifact。
- [ ] P2-05：支持只共享摘要/图谱，不共享源码片段。
- [ ] P2-06：支持索引 artifact 加密。
- [ ] P2-07：支持跨仓依赖图。
- [ ] P2-08：支持 OpenCode Server 多 agent 协作：planner、retriever、state-machine、verifier。
- [ ] P2-09：支持长任务后台队列和 UI 进度恢复。
- [ ] P2-10：支持答案差异比较：索引版本 A vs B 的模块流程变化。

---

## 11. 离线内网能力任务清单

- [ ] OFF-01：明确离线模式含义：禁公网，允许本机/内网 OpenCode Server。
- [ ] OFF-02：新增网络 allowlist，不允许默认访问任意 URL。
- [ ] OFF-03：所有 HTTP/SSE 请求统一走 `NetworkPolicyGuard`。
- [ ] OFF-04：禁用或阻断 `webfetch`。
- [ ] OFF-05：禁用或阻断 `websearch`。
- [ ] OFF-06：OpenCode Server agent 配置中默认 `edit = deny`，除非进入明确修改模式。
- [ ] OFF-07：OpenCode Server agent 配置中默认 `bash = deny/ask`，不得默认 allow。
- [ ] OFF-08：context-only 模式下 `read/grep/glob/list` 默认 deny，由 Local Analysis Tool 提供受控 evidence。
- [ ] OFF-09：shared-workspace 模式下 `read/grep/lsp` 可 allow，但必须记录审计。
- [x] OFF-10：支持 OpenCode Server Basic Auth。证据：`RemoteOpenCodeClient.headers()` 发送 Basic Auth，密码保存于 VS Code SecretStorage；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] OFF-11：支持 OpenCode Server 证书/自签证书策略说明。
- [ ] OFF-12：UI 显示当前 server URL、server 分类、agent、model、tool policy。
- [ ] OFF-13：新增审计日志，记录被拦截公网请求。
- [ ] OFF-14：新增审计日志，记录发给 OpenCode Server 的 prompt 摘要和 evidence 文件列表。
- [ ] OFF-15：新增断互联网但保留内网 OpenCode Server 的 E2E smoke test。
- [ ] OFF-16：新增敏感文件默认排除规则。
- [ ] OFF-17：新增外发 prompt 预览与审计导出。
- [ ] OFF-18：OpenCode Server 不可用时给出可操作诊断：server 未启动、auth 错误、网络被策略阻断、schema 不兼容。
- [ ] OFF-19：支持本机 OpenCode Server：`http://127.0.0.1:4096`。
- [ ] OFF-20：支持内网 OpenCode Server：私网 IP 或 allowlist 域名。
- [ ] OFF-21：禁止默认使用公共模型 API；模型入口应由 OpenCode Server 或内网模型网关管理。
- [ ] OFF-22：禁公网测试使用 OS 防火墙或测试代理验证，扩展层同时做 hard fail。

---

## 12. 状态机抽取任务清单

### 12.1 数据模型

- [ ] SM-Model-01：定义 `StateMachine`：`id, name, module, root_symbols, state_var, language, confidence`。
- [ ] SM-Model-02：定义 `State`：`machine_id, state_id, name, value, definition_range, comment`。
- [ ] SM-Model-03：定义 `Transition`：`from_state, to_state, event, guard, action, range, function_id, confidence`。
- [ ] SM-Model-04：定义 `Path`：`machine_id, start_state, end_state, transitions[], conditions`。
- [ ] SM-Model-05：定义 `EvidenceRef`：`file, start_line, end_line, snippet_hash, parser_kind`。
- [ ] SM-Model-06：设计未知状态：`unknown/source_missing/target_missing`。
- [ ] SM-Model-07：设计低置信度状态和转移的展示规则。
- [ ] SM-Model-08：设计 transition 去重规则。
- [ ] SM-Model-09：设计跨函数 path 的 path compression 规则。
- [ ] SM-Model-10：设计 Mermaid/DOT/SVG cache 字段。

### 12.2 算法 v0

- [ ] SM-Alg0-01：扫描 enum/typedef/宏，找候选状态集合。
- [ ] SM-Alg0-02：扫描变量/字段/参数名，找候选状态变量。
- [ ] SM-Alg0-03：扫描 `switch(state)`，提取 case 状态。
- [ ] SM-Alg0-04：扫描 `if (state == X)` / `if (X == state)`，提取 guard。
- [ ] SM-Alg0-05：扫描 `state = Y`，提取 transition。
- [ ] SM-Alg0-06：提取 transition 前后的函数调用作为 action。
- [ ] SM-Alg0-07：提取错误码/消息类型/事件类型作为 event。
- [ ] SM-Alg0-08：构建 `from -> to` 有向图。
- [ ] SM-Alg0-09：输出 transition table。
- [ ] SM-Alg0-10：输出 Mermaid state diagram。
- [ ] SM-Alg0-11：将状态机结果注册到 Analysis Tool API。

### 12.3 算法 v1

- [ ] SM-Alg1-01：接入 CFG，支持基本块与条件边。
- [ ] SM-Alg1-02：支持跨函数传播。
- [ ] SM-Alg1-03：支持 handler/callback/task loop 入口识别。
- [ ] SM-Alg1-04：支持封装函数：`set_state`、`update_state`、`transition_to`。
- [ ] SM-Alg1-05：支持结构体字段状态：`ctx->state`、`obj.state`。
- [ ] SM-Alg1-06：支持返回值驱动状态变化。
- [ ] SM-Alg1-07：支持多状态变量 disambiguation。
- [ ] SM-Alg1-08：支持 reachability 查询。
- [ ] SM-Alg1-09：支持 dead state 检测。
- [ ] SM-Alg1-10：支持 cycle 和 error path 检测。

### 12.4 UI 与查询

- [ ] SM-UI-01：状态机列表。
- [ ] SM-UI-02：状态列表。
- [ ] SM-UI-03：切换表。
- [ ] SM-UI-04：路径查询。
- [ ] SM-UI-05：流程解释。
- [ ] SM-UI-06：Mermaid 预览。
- [ ] SM-UI-07：DOT/SVG 导出。
- [ ] SM-UI-08：点击 transition 跳转源码。
- [ ] SM-UI-09：显示 confidence。
- [ ] SM-UI-10：显示缺失证据和不确定性。
- [ ] SM-UI-11：允许把状态机 evidence 发送给 OpenCode Server 生成自然语言解释。
- [ ] SM-UI-12：自然语言解释必须通过 evidence verifier。

---

## 13. 百万级整仓任务清单

- [ ] SCALE-01：定义百万级 benchmark 规格：文件数、LOC、语言比例、平均文件大小、调用边数量、符号数量。
- [ ] SCALE-02：实现 synthetic repo generator。
- [ ] SCALE-03：实现 10k 文件基准。
- [ ] SCALE-04：实现 100k 文件基准。
- [ ] SCALE-05：实现 250k 文件基准。
- [ ] SCALE-06：实现 1M 文件基准。
- [ ] SCALE-07：记录索引吞吐：files/sec、MB/sec。
- [ ] SCALE-08：记录峰值内存。
- [ ] SCALE-09：记录 DB/索引体积。
- [ ] SCALE-10：记录查询 P50/P95/P99。
- [ ] SCALE-11：记录增量更新延迟。
- [ ] SCALE-12：记录恢复时间。
- [ ] SCALE-13：实现 shard lazy loading。
- [ ] SCALE-14：实现 postings 分片。
- [ ] SCALE-15：实现 graph edge 分片。
- [ ] SCALE-16：实现查询 cost model。
- [ ] SCALE-17：实现内存预算配置。
- [ ] SCALE-18：实现大仓 watcher 降级。
- [ ] SCALE-19：实现索引任务 pause/resume。
- [ ] SCALE-20：实现索引错误重试与隔离。
- [ ] SCALE-21：实现 top-N module pre-aggregation。
- [ ] SCALE-22：实现热门符号缓存。
- [ ] SCALE-23：实现 OpenCode prompt budget 与 evidence budget 联动。
- [ ] SCALE-24：实现百万级查询 explain plan。
- [ ] SCALE-25：百万级验收报告必须包含 OpenCode Server 推理耗时与 Local Analysis Daemon 检索耗时拆分。

---

## 14. 测试与验收清单

### 14.1 单元测试

- [ ] TEST-Unit-01：server URL policy 测试。
- [ ] TEST-Unit-02：NetworkPolicyGuard 测试。
- [ ] TEST-Unit-03：OpenCode capability probe parser 测试。
- [ ] TEST-Unit-04：parser 边界测试。
- [x] TEST-Unit-05：index hydrate 测试。证据：`test/codegraph-index.test.ts`；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [x] TEST-Unit-06：query mode classifier 测试。证据：`test/codegraph-query.test.ts`；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] TEST-Unit-07：state-machine extractor v0 测试。
- [x] TEST-Unit-08：completion edit/format/indent 测试。证据：`test/completion-edit.test.ts`、`test/completion-format.test.ts`、`test/completion-indent.test.ts`；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [x] TEST-Unit-09：context guard 测试。证据：`test/current-context.test.ts` 与 `test/strict-agent.test.ts`；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] TEST-Unit-10：schema migration 测试。
- [ ] TEST-Unit-11：evidence verifier 测试。
- [ ] TEST-Unit-12：tool audit log sanitizer 测试。

### 14.2 集成测试

- [ ] TEST-Integration-01：VS Code extension host + Local Analysis Daemon。
- [ ] TEST-Integration-02：连接/断开本机 OpenCode Server。
- [ ] TEST-Integration-03：连接/断开内网 OpenCode Server mock。
- [x] TEST-Integration-04：SSE 事件流。证据：`test/remote-client.test.ts` SSE chunk parsing 与 `test/chat-stream.test.ts` event merge；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [x] TEST-Integration-05：blocking fallback。证据：`test/chat-history.test.ts` 覆盖 streaming fallback 到 blocking send；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] TEST-Integration-06：index status。
- [ ] TEST-Integration-07：UI command。
- [ ] TEST-Integration-08：state-machine query。
- [ ] TEST-Integration-09：OpenCode custom tool 调用 Local Analysis Daemon。
- [ ] TEST-Integration-10：OpenCode MCP tool 调用 Local Analysis Daemon。

### 14.3 语义准确性测试

- [ ] TEST-Accuracy-01：callers precision/recall/F1。
- [ ] TEST-Accuracy-02：callees precision/recall/F1。
- [ ] TEST-Accuracy-03：call-chain precision/recall/F1。
- [ ] TEST-Accuracy-04：symbol binding accuracy。
- [ ] TEST-Accuracy-05：state transition accuracy。
- [ ] TEST-Accuracy-06：guard extraction accuracy。
- [ ] TEST-Accuracy-07：action extraction accuracy。
- [ ] TEST-Accuracy-08：path query accuracy。
- [ ] TEST-Accuracy-09：module summary factuality。
- [ ] TEST-Accuracy-10：OpenCode answer evidence correctness。

### 14.4 性能测试

- [ ] TEST-Perf-01：10k 文件索引。
- [ ] TEST-Perf-02：100k 文件索引。
- [ ] TEST-Perf-03：250k 文件索引。
- [ ] TEST-Perf-04：1M 文件索引。
- [ ] TEST-Perf-05：查询 P50/P95/P99。
- [ ] TEST-Perf-06：增量更新 latency。
- [ ] TEST-Perf-07：DB 体积。
- [ ] TEST-Perf-08：恢复时间。
- [ ] TEST-Perf-09：OpenCode Server 首 token latency。
- [ ] TEST-Perf-10：evidence pack 构造耗时。

### 14.5 离线安全测试

- [ ] TEST-Security-01：禁公网环境下 chat 可走本机 OpenCode Server。
- [ ] TEST-Security-02：禁公网环境下 chat 可走内网 OpenCode Server。
- [ ] TEST-Security-03：禁公网环境下 completion 可走 OpenCode Server。
- [ ] TEST-Security-04：禁公网环境下索引可运行。
- [ ] TEST-Security-05：public URL 被 NetworkPolicyGuard 阻断。
- [ ] TEST-Security-06：webfetch/websearch 工具被禁用或阻断。
- [ ] TEST-Security-07：敏感文件不进入 prompt。
- [ ] TEST-Security-08：敏感文件不进入摘要。
- [ ] TEST-Security-09：审计日志可追踪。
- [ ] TEST-Security-10：context-only 模式下 server 不需要源码文件系统访问。
- [ ] TEST-Security-11：shared-workspace 模式下 server 工具调用可审计。

### 14.6 E2E 用户任务

- [ ] TEST-E2E-01：解释某模块功能。
- [ ] TEST-E2E-02：解释某子模块某功能工作流程。
- [ ] TEST-E2E-03：找某状态机所有状态。
- [ ] TEST-E2E-04：找某状态机从 A 到 B 的路径。
- [ ] TEST-E2E-05：解释某 transition 的切换条件和动作。
- [ ] TEST-E2E-06：做改动影响分析。
- [ ] TEST-E2E-07：做 callers/callees/call-chain 查询。
- [ ] TEST-E2E-08：通过 OpenCode Server 完成离线问答。
- [ ] TEST-E2E-09：通过 OpenCode Server 完成离线补全。
- [ ] TEST-E2E-10：UI 中从答案 evidence 跳转源码。
- [ ] TEST-E2E-11：OpenCode Server 主动调用 Analysis Tool 回答百万级代码问题。

---

## 15. 建议下一步落地顺序

- [ ] NEXT-01：新增 ADR，明确目标架构：VS Code Extension + Local Analysis Daemon + 内网 OpenCode Server。
- [ ] NEXT-02：先实现 `offlineMode`、server allowlist 和 `NetworkPolicyGuard`，避免“名义离线”。
- [ ] NEXT-03：实现 OpenCode Server capability probe，把当前远端连接升级为可诊断、可验收的 server adapter。
- [ ] NEXT-04：生成 OpenCode offline agent/tool 权限模板，默认禁 webfetch/websearch。
- [ ] NEXT-05：抽象 Local Analysis Service API。
- [ ] NEXT-06：把现有 codegraph index 映射到 SQLite/FTS schema，保留 query 接口不变。
- [ ] NEXT-07：实现 Analysis Tool Bridge，让 OpenCode Server 可以查询本地索引。
- [ ] NEXT-08：实现 `StateMachineExtractor v0`，用小型 C/C++ fixture 证明能输出 states/transitions/guards/actions。
- [ ] NEXT-09：给 Webview 加最小 Code Intelligence 面板：索引状态、符号搜索、状态机列表、证据跳转。
- [ ] NEXT-10：建立 benchmark 命令：生成 synthetic repo，跑索引、查询、增量、内存和 DB 体积报告。
- [ ] NEXT-11：执行禁公网但允许本机/内网 OpenCode Server 的 E2E smoke test。
- [ ] NEXT-12：执行 `bun test`。
- [ ] NEXT-13：执行 `bun run package`。
- [ ] NEXT-14：把完成证据更新回本 Markdown 清单。

---

## 16. Definition of Done

### 16.1 单个任务 DoD

- [ ] DoD-Task-01：代码已提交到对应分支。
- [ ] DoD-Task-02：有最小单元测试或集成测试。
- [ ] DoD-Task-03：测试命令已记录。
- [ ] DoD-Task-04：涉及 UI 的任务有截图或录屏。
- [ ] DoD-Task-05：涉及索引/性能的任务有 benchmark 输出。
- [ ] DoD-Task-06：涉及状态机的任务有 JSON + Mermaid + evidence。
- [ ] DoD-Task-07：涉及离线的任务有禁公网验证，且允许的 OpenCode Server 连接已记录。
- [ ] DoD-Task-08：涉及 OpenCode Server 的任务有 capability report 和 tool policy report。
- [ ] DoD-Task-09：涉及模型回答的任务有 evidence verifier 结果。
- [ ] DoD-Task-10：文档已更新。

### 16.2 里程碑 DoD

- [ ] DoD-Milestone-01：里程碑下所有 P0/P1 必需项完成。
- [ ] DoD-Milestone-02：`bun test` 通过。
- [ ] DoD-Milestone-03：`bun run package` 通过。
- [ ] DoD-Milestone-04：禁公网但允许 OpenCode Server 的 E2E 通过。
- [ ] DoD-Milestone-05：性能/准确性/离线安全指标有报告。
- [ ] DoD-Milestone-06：已知限制已记录。
- [ ] DoD-Milestone-07：回滚方案已记录。

---

## 17. 风险与缓解任务

- [ ] RISK-01：把“离线”误实现为“不使用 OpenCode Server”；缓解：文档和配置明确 `intranet-opencode` 是主要模式。
- [ ] RISK-02：OpenCode Server agent 默认工具过宽；缓解：生成权限模板，禁 webfetch/websearch，审计所有工具调用。
- [ ] RISK-03：扩展层阻断不等于系统级断网；缓解：NetworkPolicyGuard + OS 防火墙/测试代理 E2E 双重验证。
- [ ] RISK-04：百万级索引拖垮 VS Code；缓解：索引 daemon 化、进程隔离、任务限流、批处理、取消、watcher 降级。
- [ ] RISK-05：语义误判导致错误状态机；缓解：semantic provider、置信度、evidence、低置信度不做强结论、golden 测试。
- [ ] RISK-06：索引体积过大；缓解：分片、压缩、冷热分层、摘要缓存、按语言/目录选择性索引。
- [ ] RISK-07：答案幻觉；缓解：回答策略强制 evidence 引用，缺证据提示，结果校验器检查 file:line 引用。
- [ ] RISK-08：UI 信息过载；缓解：默认折叠模块，按 query 展开，支持过滤、跳转和导出。
- [ ] RISK-09：敏感信息泄露到 OpenCode Server；缓解：敏感文件默认排除、prompt 预览、审计、workspace trust、可选加密。
- [ ] RISK-10：OpenCode Server 与 Local Analysis Daemon 版本不兼容；缓解：capability probe、schema version、降级路径、诊断报告。

---

## 18. 资料来源

- GitHub 分支根目录：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension>
- README：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension#readme>
- src 目录：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension/src>
- test 目录：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension/test>
- package.json：<https://raw.githubusercontent.com/caizh1/opencode/codex/local-vscode-extension/package.json>
- AGENTS.md：<https://raw.githubusercontent.com/caizh1/opencode/codex/local-vscode-extension/AGENTS.md>
- OpenCode Server 文档：<https://open-code.ai/en/docs/server>
- OpenCode Tools 文档：<https://opencode.ai/docs/tools/>
- OpenCode Custom Tools 文档：<https://opencode.ai/docs/custom-tools/>
- VS Code Webview API：<https://code.visualstudio.com/api/extension-guides/webview>
- VS Code Workspace Trust：<https://code.visualstudio.com/api/extension-guides/workspace-trust>

---

## 19. Codex 完成记录

> 每完成一批任务，在这里追加记录。

- [ ] RECORD-01：批次编号：`YYYY-MM-DD-01`；完成任务：`...`；commit/PR：`...`；测试：`...`；OpenCode Server：`...`；网络策略：`...`；备注：`...`
- [ ] RECORD-02：批次编号：`YYYY-MM-DD-02`；完成任务：`...`；commit/PR：`...`；测试：`...`；OpenCode Server：`...`；网络策略：`...`；备注：`...`
- [ ] RECORD-03：批次编号：`YYYY-MM-DD-03`；完成任务：`...`；commit/PR：`...`；测试：`...`；OpenCode Server：`...`；网络策略：`...`；备注：`...`
