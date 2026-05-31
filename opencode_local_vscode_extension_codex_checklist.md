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

- [x] STATE-IDX-01：Local Analysis Daemon 输出统一状态：disabled/indexingFull/indexingIncremental/ready/degraded/paused/recovering/error。证据：`CodeGraphState` 扩展、`LocalCodeGraphService` 设置 `indexingFull/indexingIncremental/recovering/degraded/paused/rescanScheduled`；测试：`bun test`。
- [x] STATE-IDX-02：每个状态带进度、当前 shard、队列长度、错误数、最后更新时间。证据：`CodeGraphStatus.progress/currentShard/queueLength/errorCount/lastTransitionAt/transitions/metrics`；测试：`bun run package`。
- [x] STATE-IDX-03：百万级仓库 watcher 风暴时自动进入 `rescanScheduled` 而不是逐事件处理。证据：`opencode.remote.codeGraph.watcherRescanThreshold`、`LocalCodeGraphService.startWatcher()` 合并 rescan；测试：`bun test`。
- [x] STATE-IDX-04：索引可从 sharded manifest/snapshot 恢复，并持久化 active job checkpoint；证据：`loadShardedIndex()` lazy manifest 恢复、`checkpoint.json`、`saveJobCheckpoint()/readJobCheckpoint()`、`recoveryMs=58`；测试：`cmd /c npx -y bun@1.3.14 test`、`benchmark:codegraph -- --files=1000000`。
- [x] STATE-IDX-05：UI 展示索引状态、队列、暂停/恢复入口和最近状态切换列表；证据：Webview `Code Intelligence` 的 `Index States` section、`CodeGraphStatus.transitions`；测试：`test/codegraph-observability.test.ts`。

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

- [x] STATE-SM-01：状态机抽取器输出每个阶段耗时和候选数量。证据：`StateMachineMetric`、`bucket.metrics`、`test/state-machine-extractor.test.ts`。
- [x] STATE-SM-02：低置信度 transition 不进入默认图，只进入候选表。证据：`lowConfidence`、`primaryTransitions`/`candidateTransitions` 分离；测试：`test/state-machine-extractor.test.ts`。
- [x] STATE-SM-03：每条 transition 必须绑定 evidence range。证据：`StateMachineTransition.evidence`；测试：`test/state-machine-extractor.test.ts`。
- [ ] STATE-SM-04：状态机图支持从 UI 点击跳转源码。
- [x] STATE-SM-05：状态机查询结果可被 OpenCode Server 通过 custom tool 调用。证据：`getStateMachines/getStatePath` Analysis Tool 与 `opencode_local_analysis` custom tool；测试：`test/analysis-tool.test.ts`。

---

## 6. MVP：离线内网 OpenCode Server 版最小可行增强

- [ ] MVP-01：新增 `offlineMode = disabled | intranet-opencode | strict-airgap` 配置。
- [ ] MVP-02：新增 `opencode.remote.allowedServerHosts`，只允许 localhost、私网 CIDR、显式内网域名。
- [ ] MVP-03：新增 OpenCode Server capability probe：health、version、OpenAPI doc、SSE event、session、message、provider/model、agent。
- [x] MVP-04：新增 OpenCode Server tool permission 检查提示，要求禁用 `webfetch/websearch` 或在离线策略下 hard block。证据：`DEFAULT_ANALYSIS_TOOL_POLICY`、`createOpenCodeLocalAgentPolicyTemplate()`；测试：`test/analysis-tool.test.ts`。
- [x] MVP-05：新增 `LocalAnalysisDaemon v0`，把现有 C/C++ code graph 从扩展进程迁移到 worker。证据：`LocalAnalysisServiceProtocol`、`CodeGraphWorkerPool`；测试：`test/codegraph-worker-host.test.ts`。
- [ ] MVP-06：新增 SQLite + FTS 索引存储；先迁移 files、symbols、edges、postings、modules。
- [x] MVP-07：新增 Analysis Tool Bridge v0，让 OpenCode Server 可通过内网 custom tool 查询本地索引。证据：`analysis-bridge.ts`、`.opencode/tools/opencode_local_analysis.ts` 生成器；测试：`test/analysis-tool.test.ts`。
- [x] MVP-08：新增 `StateMachineExtractor v0`，支持 C/C++ `enum` + `switch(state)` + `state = X` + `if guard`。证据：`state-machine-extractor.ts`；测试：`test/state-machine-extractor.test.ts`。
- [x] MVP-09：Webview 新增 `Code Intelligence` 面板：索引状态、模块树、符号搜索、状态机列表、证据跳转。证据：`chat-html.ts` Code Intelligence/Index States/evidence Open；测试：`test/chat-html.test.ts`。
- [ ] MVP-10：新增禁公网 E2E：断互联网，但保留本机/内网 OpenCode Server，chat/completion/analysis 能工作。
- [x] MVP-11：新增 synthetic repo benchmark：10k、100k、250k 文件；MVP 阶段可先不要求 1M 完整通过。证据：`benchmark:codegraph -- --files=10000/100000/250000/1000000`；测试：`test/codegraph-benchmark.test.ts`。
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

- [x] M2-01：定义 `LocalAnalysisService` 协议：status、index、query、stateMachine、graph、summary、cancel、metrics。证据：`LocalAnalysisServiceProtocol`、`CodeGraphContextProvider` cancel/pause/resume/metrics、Analysis Tool API；测试：`test/local-analysis-service.test.ts`。
- [x] M2-02：实现 Local Analysis Daemon v0 worker host：启动、健康检查、worker 数、日志、任务指标和 checkpoint 恢复。证据：`CodeGraphWorkerPool.health()`、`serviceMode=worker-thread-pool`、`[codegraph-worker]` 日志、`checkpoint.json`；测试：`test/codegraph-worker-host.test.ts`、`test/codegraph-observability.test.ts`。
- [x] M2-03：实现 workspace crawler：优先 `git ls-files -z`、ignore 规则、大小限制、二进制过滤、默认 excludes 与敏感文件过滤。证据：`discoverWorkspaceSourceFiles()`、`gitTrackedSourceFiles()`、`isSensitivePath()`、`looksBinary()`；测试：`cmd /c npx -y bun@1.3.14 test`。
- [x] M2-04：实现 snapshot metadata：path/size/mtime/sha256/language/module/shard。证据：`sha256` hash、`workspaceFileStat()`、`snapshotRowForFile()`、`CodeGraphFile.sha256/mtime/module/shard`；测试：`test/codegraph-storage-schema.test.ts`。
- [x] M2-05：实现全量索引 job queue。证据：`LocalAnalysisJobQueue.enqueue/startNext`、`indexWorkspace()` full-index job；测试：`test/local-analysis-service.test.ts`。
- [x] M2-06：实现增量索引 job queue。证据：`applyPendingChanges()` incremental-index job；测试：`test/local-analysis-service.test.ts`。
- [x] M2-07：实现 job cancel/pause/resume。证据：`cancelIndexing()`、`pauseIndexing()`、`resumeIndexing()`、命令和 UI action；测试：`test/chat-html.test.ts`、`test/manifest.test.ts`。
- [x] M2-08：实现 crash recovery。证据：`loadShardedIndex()`/legacy migration、`metrics.lastRecoveryElapsedMs`、benchmark `recoveryMs`；测试：`bun run benchmark:codegraph -- --files=100000`。
- [x] M2-09：实现 SQLite schema：files、symbols、edges、postings、modules、state_machines、summaries、snapshots、schema_version。证据：`CODEGRAPH_SQLITE_SCHEMA`、`createCodeGraphStorageManifest()`；测试：`test/codegraph-storage-schema.test.ts`。
- [ ] M2-10：实现 FTS/BM25 检索。
- [x] M2-11：实现 edge materializer：call/include/import/type/reference/state-transition edge kind、type/reference runtime edge、状态机 transition edge。证据：`CodeGraphStorageEdgeKind`、`createCodeGraphStorageEdges()`、`edgeKinds` manifest；测试：`test/codegraph-storage-schema.test.ts`。
- [x] M2-12：实现 schema migration。证据：`CODEGRAPH_STORAGE_SCHEMA_VERSION`、manifest `schema`、v2/v3 stored index compatibility/migration；测试：`test/codegraph-index.test.ts`、`test/codegraph-storage-schema.test.ts`。
- [x] M2-13：实现扩展端 client 边界：UI/命令通过 `CodeGraphContextProvider` 调服务协议，重解析与 hydrate 走 worker host，百万级恢复默认 lazy manifest。证据：`LocalAnalysisServiceProtocol`、`CodeGraphWorkerPool`、`activeIndexForQuestion()`、`loadShardFiles()`；测试：`cmd /c npx -y bun@1.3.14 run compile`。
- [x] M2-14：100k/250k/1M synthetic benchmark 通过并返回 file:line evidence，百万级查询走 streaming-sharded/lazy shard 路径。证据：`benchmark:codegraph -- --files=1000000`（files=1000000, P95=13ms, peakHeapBytes=68768088, indexBytes=466444450）；测试：`cmd /c npx -y bun@1.3.14 test`。

### M3：OpenCode Server 与本地索引的工具桥接

- [x] M3-01：定义 Analysis Tool API：search、getFileSlice、getSymbol、getCallers、getCallees、getCallChain、getModuleMap、getStateMachines、getStatePath、queryEvidence。证据：`src/codegraph-analysis.ts`、`src/analysis-types.ts`；测试：`cmd /c npx -y bun@1.3.14 test`（188 pass）；package/vsix：`opencode-remote-0.0.41.vsix`。
- [x] M3-02：实现 VS Code 侧 direct evidence pack 模式：扩展先查 daemon，再把 evidence 放进 prompt。证据：`src/context.ts` 注入 `<local-analysis-pack>` 与 answer policy/query trace；测试：`cmd /c npx -y bun@1.3.14 test`（188 pass）。
- [x] M3-03：实现 OpenCode custom tool 模式：OpenCode Server 通过 `.opencode/tools/` 调用 Local Analysis Daemon。证据：`src/analysis-bridge.ts` 启动 localhost token bridge，`src/analysis-tool-template.ts` 生成 `.opencode/tools/opencode_local_analysis.ts`；测试：`cmd /c npx -y bun@1.3.14 test`（188 pass）。
- [ ] M3-04：实现 OpenCode MCP tool 模式：Local Analysis Daemon 暴露 MCP server，OpenCode Server 调用。
- [x] M3-05：实现工具调用权限策略：只允许 analysis tools，默认禁用 webfetch/websearch，edit/bash 视模式决定。证据：`DEFAULT_ANALYSIS_TOOL_POLICY` 与 `createOpenCodeLocalAgentPolicyTemplate()`；测试：`test/analysis-tool.test.ts` 覆盖 blocked policy 和 deny webfetch/websearch/edit/bash。
- [x] M3-06：实现工具调用审计：tool name、args 摘要、返回 evidence 数、耗时、是否被阻断。证据：`AnalysisToolAuditEntry`、`LocalCodeGraphService.runAnalysisTool()` 输出 `[analysis-tool]` 审计日志；测试：`test/analysis-tool.test.ts`。
- [x] M3-07：实现工具返回预算控制：最大片段数、最大字节数、最大路径数、最大图边数。证据：`AnalysisBudget`、`packEvidenceRefs()`、`opencode.remote.analysis.*` 配置；测试：`test/analysis-tool.test.ts` budget case。
- [x] M3-08：实现 query trace：用户问题 -> intent -> 检索工具 -> evidence -> prompt -> 回答 -> verifier。证据：`AnalysisQueryTrace`、`queryEvidence()`、`<local-analysis-pack>`；测试：`test/analysis-tool.test.ts` trace case。
- [x] M3-09：验收：OpenCode Server 能主动查询本地索引回答“谁调用了 X”“模块 A 到 B 的调用链”“状态 A 到 B 的切换条件”。证据：`opencode_local_analysis` custom tool 调用 `search/getCallChain/getStatePath/queryEvidence`；测试：`test/analysis-tool.test.ts` 覆盖 callers/call-chain/state path；package/vsix：`opencode-remote-0.0.41.vsix`。

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

- [x] M5-01：实现 `StateMachineExtractor` 子系统。证据：`src/state-machine-extractor.ts`；测试：`test/state-machine-extractor.test.ts`，`cmd /c npx -y bun@1.3.14 test`（188 pass）。
- [x] M5-02：识别候选状态变量：`state/status/mode/phase/stage/event` 命名、enum、macro、typedef、结构体字段、函数参数。证据：`variableCandidates()` 与 transition var 扫描；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-03：识别状态集合：enum 成员、宏常量、字符串常量、有限整型常量。证据：`scanTypes()`、`scanMacros()`、`stringStateLiterals()`、assignment/case 状态收集；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-04：识别转移语句：`state = X`、字段写入、`set_state/update_state/transition_to`、返回值驱动状态变化。证据：`transitionAssignment()`、`transitionMutator()`；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-05：提取事件与 guard：上层 `if/else`、`switch case`、循环条件、错误码、消息类型、函数入参、调用上下文。证据：`eventFromText()`、guard/case/switch 提取；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-06：提取 action：转移前后调用函数、日志、资源操作、队列/消息发送、锁操作。证据：`actionAround()` 与跨函数 `calls ...` action；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-07：支持跨函数传播：从入口函数、handler、callback、任务循环沿调用图传播状态变量。证据：`expandCrossFunctionTransitions()`；测试：`test/state-machine-extractor.test.ts` 覆盖 `boot_handler -> boot_step`。
- [x] M5-08：实现路径合成：`source state -> event/guard/action -> target state` directed graph。证据：`findStatePath()`、`pathFromTransitions()`；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-09：支持 reachability、dead state、cycle、error path 查询。证据：`buildQueries()`、`findCycles()`；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-10：每条 transition 记录 `file:start_line-end_line` evidence。证据：`StateMachineTransition.evidence`；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-11：为状态机、状态、转移、路径标注 confidence。证据：`machineConfidence()`、`transitionConfidence()`、path confidence；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-12：输出 JSON transition table。证据：`stateMachineToTransitionTable()`；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-13：输出 Mermaid state diagram。证据：`toMermaid()`；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-14：输出 DOT/Graphviz 图。证据：`toDot()`；测试：`test/state-machine-extractor.test.ts`。
- [x] M5-15：将状态机查询暴露给 VS Code UI 和 OpenCode Analysis Tool。证据：Webview `Code Intelligence`/evidence 跳转、`getStateMachines/getStatePath` analysis tool；测试：`test/chat-html.test.ts`、`test/analysis-tool.test.ts`。
- [x] M5-16：验收：真实模块可输出状态表、转移表、路径、guard/action 和证据；未知路径明确标注。证据：`test/state-machine-extractor.test.ts` 输出 states/transitions/guards/actions/evidence/Mermaid/DOT；`getStatePath` 未命中返回明确错误；测试：`cmd /c npx -y bun@1.3.14 test`（188 pass）。

### M6：分层理解与离线 RAG

- [x] M6-01：建立函数级摘要，摘要必须关联 source evidence。证据：`FunctionSummary`、`functionSummary()`；测试：`test/analysis-tool.test.ts`。
- [x] M6-02：建立文件级摘要，包含核心符号、输入输出、依赖、状态机、风险点。证据：`FileSummary`、`fileSummary()`；测试：`test/analysis-tool.test.ts`。
- [x] M6-03：建立目录/模块级摘要，支持模块职责、子模块划分、关键流程、调用入口。证据：`ModuleSummary`、`moduleSummaries()`；测试：`test/analysis-tool.test.ts`。
- [x] M6-04：建立子系统级摘要，支持跨模块流程说明。证据：`SubsystemSummary`、`subsystemSummaries()`；测试：`test/analysis-tool.test.ts`。
- [ ] M6-05：实现 hybrid retrieval：exact path + symbol table + BM25 + vector optional + graph expansion + state-machine index。
- [x] M6-06：实现 evidence packer：dedupe、line range、confidence、byte/token budget、missing evidence notes。证据：`packEvidenceRefs()`、`EvidencePack`；测试：`test/analysis-tool.test.ts`。
- [x] M6-07：实现 answer policy：只基于 evidence 回答，必须引用 file:line，无证据时拒答或提示缺失。证据：`evaluateAnswerPolicy()`、`buildSuggestedAnswer()`、`Local Context Contract`；测试：`test/analysis-tool.test.ts`。
- [ ] M6-08：embedding/rerank 优先通过内网 OpenCode Server 或内网模型服务提供；VS Code 扩展不直接访问公网。
- [ ] M6-09：支持无 embedding 的纯 BM25 + graph + state-machine fallback。
- [x] M6-10：验收：用户可问“某模块某功能流程”，答案包含结构化流程、调用链、状态机和证据行。证据：`queryEvidence()` 输出 module summaries/call-chain retrieval/stateMachines/evidencePack/suggested grounded answer plan；测试：`test/analysis-tool.test.ts`；package/vsix：`opencode-remote-0.0.41.vsix`。

### M7：百万级规模化

- [x] M7-01：实现按目录/shard 懒加载查询：大索引恢复只读 manifest，查询按 symbol/posting/path 规划 shard 并加载目标 shard。证据：`LARGE_INDEX_LAZY_FILE_THRESHOLD`、`activeIndexForQuestion()`、`loadShardFiles()`、`planShardKeysForQuery()`；测试：`test/codegraph-shard-planner.test.ts`、`test/codegraph-observability.test.ts`。
- [x] M7-02：实现并行解析 worker pool：全量索引按 `workerConcurrency` 并发读取/解析，worker pool 提供 health/parse/hydrate fallback。证据：`runIndex()` concurrent parse loop、`CodeGraphWorkerPool.parseFile()`；测试：`test/codegraph-worker-host.test.ts`、`bun run compile`。
- [x] M7-03：实现 watcher 降级策略：大量变更时从 file watcher 切换为周期扫描/快照对比。证据：`watcherRescanThreshold`、`rescanScheduled`、`recordWatcherStorm()`；测试：`bun run package`。
- [x] M7-04：实现 module hotSymbols、shard cache 与热查询上下文缓存。证据：`CodeGraphHotCache`、`queryCache`、`shardCache`、`moduleStats.hotSymbols`；测试：`test/codegraph-shard-planner.test.ts`。
- [x] M7-05：实现内存预算配置与自动降级：超过 `memoryLimitMb` 清理热查询缓存并标记 degraded。证据：`opencode.remote.codeGraph.memoryLimitMb`、`enforceMemoryBudget()`、`CodeGraphServiceMetrics.memoryDegraded`；测试：`test/manifest.test.ts`、`bun run compile`。
- [x] M7-06：实现 synthetic repo generator，覆盖 10k / 100k / 250k / 1M 文件规模。证据：`generateSyntheticCodeGraphFiles(count)`、`benchmark:codegraph -- --files=N`；实测：10k/100k/250k。
- [x] M7-07：实现 benchmark 命令，输出索引时间、吞吐、峰值内存、DB 体积、查询 P50/P95/P99、增量更新时间。证据：`bun run benchmark:codegraph -- --files=1000000` 输出 parse/index/filesPerSec/peakHeapBytes/indexBytes/queryP*/incrementalMs/recoveryMs。
- [x] M7-08：实现 crash recovery，索引中断后可恢复。证据：`loadShardedIndex()`、schema manifest、benchmark `recoveryMs`；测试：`test/codegraph-storage-schema.test.ts`。
- [x] M7-09：实现 schema migration 和索引版本兼容策略。证据：`CURRENT_CODE_GRAPH_INDEX_VERSION=3`、stored v2/v3 兼容、`CODEGRAPH_STORAGE_SCHEMA_VERSION=1`；测试：`test/codegraph-index.test.ts`。
- [x] M7-10：1M synthetic 基准通过。证据：`benchmark:codegraph -- --files=1000000`（files=1000000, mode=streaming-sharded, parseMs=55374, queryP50/P95/P99=2/13/13ms, peakHeapBytes=68768088）。

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
- [x] P0-03b：生成 context-only agent 示例配置：禁止 read/grep/glob/list/bash/edit/webfetch/websearch，只允许 question 和 analysis tools。证据：`createOpenCodeLocalAgentPolicyTemplate()`；测试：`test/analysis-tool.test.ts`。
- [ ] P0-03c：生成 shared-workspace agent 示例配置：允许 read/grep/lsp/analysis tools，禁止 webfetch/websearch，bash/edit 默认 ask 或 deny。
- [x] P0-03d：新增工具权限检查文档，说明 OpenCode Server 端必须禁用公网工具。证据：`README.md` vscode-local agent policy 与 webfetch/websearch deny 说明。
- [ ] P0-03e：在连接诊断中提示当前 agent 是否符合离线建议。
- [x] P0-03f：提供 `.opencode/tools/local_analysis.ts` 示例。证据：`createOpenCodeLocalAnalysisTool()` 生成 `.opencode/tools/opencode_local_analysis.ts`；测试：`test/analysis-tool.test.ts`。
- [ ] P0-03g：提供 MCP server 配置示例。
- [ ] P0-03h：提供 `OPENCODE_SERVER_PASSWORD` 配置说明。
- [x] P0-03i：审计 tool call：工具名、参数摘要、耗时、返回 evidence 数量。证据：`AnalysisToolAuditEntry`、`LocalCodeGraphService.runAnalysisTool()` `[analysis-tool]` 日志；测试：`test/analysis-tool.test.ts`。
- [ ] P0-03j：公网工具被调用时 hard fail，并记录 audit event。

### P0-04：Local Analysis Service 接口

- [x] P0-04a：定义 `status()` API。证据：`LocalAnalysisServiceProtocol.status()`、`CodeGraphContextProvider.status()`；测试：`test/local-analysis-service.test.ts`。
- [x] P0-04b：定义 `index(workspace, options)` API。证据：`indexWorkspace(force)`、full-index job queue；测试：`test/local-analysis-service.test.ts`。
- [x] P0-04c：定义 `query(query, scope, budget)` API。证据：`buildContext()`、`queryEvidence()`、`runAnalysisTool()` budget；测试：`test/analysis-tool.test.ts`。
- [x] P0-04d：定义 `getFileSlice(path, range)` API。证据：`AnalysisToolName.getFileSlice`、`runAnalysisTool()`；测试：`test/analysis-tool.test.ts`。
- [x] P0-04e：定义 `getSymbol(symbolId)` API。证据：`AnalysisToolName.getSymbol`、`getSymbols()`；测试：`test/analysis-tool.test.ts`。
- [x] P0-04f：定义 `getCallers(symbolId|name)` API。证据：`AnalysisToolName.getCallers`；测试：`test/analysis-tool.test.ts`。
- [x] P0-04g：定义 `getCallees(symbolId|name)` API。证据：`AnalysisToolName.getCallees`；测试：`test/analysis-tool.test.ts`。
- [x] P0-04h：定义 `getCallChain(from, to, constraints)` API。证据：`AnalysisToolName.getCallChain`；测试：`test/analysis-tool.test.ts`。
- [x] P0-04i：定义 `stateMachine(scope, query)` API。证据：`getStateMachines/getStatePath`；测试：`test/analysis-tool.test.ts`。
- [x] P0-04j：定义 `metrics()` API。证据：`LocalAnalysisServiceProtocol.metrics()`、`CodeGraphServiceMetrics`；测试：`test/local-analysis-service.test.ts`。
- [ ] P0-04k：在 `extension.ts` 中通过 gateway 调用，不直接跑重索引。

### P0-05：持久化索引库

- [x] P0-05a：设计 schema：files、symbols、edges、postings、modules、state_machines、summaries、snapshots、schema_version。证据：`CODEGRAPH_SQLITE_SCHEMA`；测试：`test/codegraph-storage-schema.test.ts`。
- [x] P0-05b：实现文件快照表：path、size、mtime、sha256、language、module、shard。证据：`snapshotRowForFile()`；测试：`test/codegraph-storage-schema.test.ts`。
- [x] P0-05c：实现符号表：symbol_id、kind、name、fq_name、file、range、signature、confidence。证据：`CODEGRAPH_SQLITE_SCHEMA` symbols table 与 `symbolsByPath` manifest count；测试：`test/codegraph-storage-schema.test.ts`。
- [x] P0-05d：实现调用/依赖边表：src、dst、edge_kind、range、confidence、build_config。证据：`createCodeGraphStorageEdges()` call/include/import/type/reference/state-transition；测试：`test/codegraph-storage-schema.test.ts`。
- [ ] P0-05e：实现 FTS postings：term、doc_id、field、weight。
- [x] P0-05f：实现 moduleStats 与 directoryStats 持久化。证据：`CodeGraphDerivedIndex.moduleStats/directoryStats` 写入 sharded manifest；测试：`test/codegraph-index.test.ts`。
- [ ] P0-05g：实现 state_machines、states、transitions、evidence_refs 表。
- [x] P0-05h：实现 schema version 与 migration。证据：`CODEGRAPH_STORAGE_SCHEMA_VERSION`、v2/v3 stored index compatibility；测试：`test/codegraph-index.test.ts`、`test/codegraph-storage-schema.test.ts`。

### P0-06：状态机抽取 v0

- [x] P0-06a：支持 C/C++ enum 状态集合。证据：`scanTypes()`；测试：`test/state-machine-extractor.test.ts`。
- [x] P0-06b：支持 macro 常量状态集合。证据：`scanMacros()`；测试：`test/state-machine-extractor.test.ts`。
- [x] P0-06c：支持 `switch(state)`。证据：`switch/case` state extraction；测试：`test/state-machine-extractor.test.ts`。
- [x] P0-06d：支持 `if (state == X)` guard。证据：guard extraction；测试：`test/state-machine-extractor.test.ts`。
- [x] P0-06e：支持 `state = Y` assignment transition。证据：`transitionAssignment()`；测试：`test/state-machine-extractor.test.ts`。
- [x] P0-06f：支持 action 函数调用提取。证据：`actionAround()`；测试：`test/state-machine-extractor.test.ts`。
- [x] P0-06g：输出 JSON。证据：`stateMachineToTransitionTable()`；测试：`test/state-machine-extractor.test.ts`。
- [x] P0-06h：输出 Mermaid。证据：`toMermaid()`；测试：`test/state-machine-extractor.test.ts`。
- [x] P0-06i：每条 transition 带 evidence。证据：`StateMachineTransition.evidence`；测试：`test/state-machine-extractor.test.ts`。
- [x] P0-06j：状态机结果可被 OpenCode Analysis Tool 查询。证据：`getStateMachines/getStatePath`；测试：`test/analysis-tool.test.ts`。

### P0-07：评测框架

- [x] P0-07a：新增 codegraph recall fixtures。证据：`test/codegraph-recall-fixture.test.ts`。
- [x] P0-07b：新增状态机 golden fixtures。证据：`test/state-machine-extractor.test.ts`。
- [ ] P0-07c：新增 OpenCode Server mock fixtures。
- [ ] P0-07d：新增禁公网/允许内网 server E2E fixture。
- [x] P0-07e：新增性能基准。证据：`scripts/codegraph-benchmark.ts`、`benchmark:codegraph`；测试：`test/codegraph-benchmark.test.ts`。
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

- [x] P1-02a：函数摘要。证据：`FunctionSummary`、`functionSummary()`；测试：`test/analysis-tool.test.ts`。
- [x] P1-02b：文件摘要。证据：`FileSummary`、`fileSummary()`；测试：`test/analysis-tool.test.ts`。
- [x] P1-02c：目录摘要。证据：`ModuleSummary` 按目录/模块聚合；测试：`test/analysis-tool.test.ts`。
- [x] P1-02d：模块摘要。证据：`moduleSummaries()`；测试：`test/analysis-tool.test.ts`。
- [x] P1-02e：子系统摘要。证据：`SubsystemSummary`、`subsystemSummaries()`；测试：`test/analysis-tool.test.ts`。
- [x] P1-02f：摘要必须绑定 evidence_refs。证据：summary `evidence`/`EvidenceRef`；测试：`test/analysis-tool.test.ts`。
- [ ] P1-02g：摘要支持增量更新。
- [ ] P1-02h：摘要可由 OpenCode Server 生成，但必须由 verifier 校验 evidence。
- [ ] P1-02i：摘要生成任务支持队列、取消、重试。
- [ ] P1-02j：摘要过期时标记 stale，不直接用于强结论。

### P1-03：混合检索/RAG planner

- [ ] P1-03a：intent classifier 支持 overview、module logic、submodule logic、callers、callees、call-chain、impact、state-machine、code search。
- [x] P1-03b：path/symbol extraction。证据：`extractSymbols()`、`relatedPaths`、`planShardKeysForQuery()`；测试：`test/codegraph-query.test.ts`、`test/codegraph-shard-planner.test.ts`。
- [ ] P1-03c：module scope inference。
- [ ] P1-03d：BM25 检索。
- [ ] P1-03e：向量检索 optional，来源必须是内网模型服务或 OpenCode Server，不允许公网。
- [x] P1-03f：图扩展。证据：callers/callees/call-chain/impact retrieval；测试：`test/codegraph-recall-fixture.test.ts`。
- [x] P1-03g：状态机索引扩展。证据：`extractStateMachines()` 接入 `queryEvidence()`；测试：`test/analysis-tool.test.ts`。
- [ ] P1-03h：rerank optional，来源必须是内网服务。
- [x] P1-03i：evidence pack。证据：`packEvidenceRefs()`、`EvidencePack`；测试：`test/analysis-tool.test.ts`。
- [x] P1-03j：query trace UI。证据：`Code Intelligence` 的 `Query Trace` 渲染；测试：`test/chat-html.test.ts`。

### P1-04：图谱和状态机 UI

- [ ] P1-04a：模块树。
- [ ] P1-04b：符号搜索。
- [ ] P1-04c：调用图。
- [ ] P1-04d：状态机图。
- [x] P1-04e：证据表。证据：`Code Intelligence` 模块/状态机/transition evidence rows；测试：`test/chat-html.test.ts`。
- [x] P1-04f：点击跳转源码。证据：`codeIntelJump` evidence open action；测试：`test/chat-html.test.ts`。
- [ ] P1-04g：Mermaid/DOT/SVG 导出。
- [x] P1-04h：显示 confidence。证据：状态机 confidence UI meta；测试：`test/chat-html.test.ts`。
- [x] P1-04i：显示 query trace。证据：`Query Trace` section；测试：`test/chat-html.test.ts`。
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

- [x] OFF-01：明确离线模式含义：禁公网，允许本机/内网 OpenCode Server。证据：README/清单离线定义与 Local Analysis Bridge 文档。
- [ ] OFF-02：新增网络 allowlist，不允许默认访问任意 URL。
- [ ] OFF-03：所有 HTTP/SSE 请求统一走 `NetworkPolicyGuard`。
- [x] OFF-04：禁用或阻断 `webfetch`。证据：`DEFAULT_ANALYSIS_TOOL_POLICY.blockedTools`、agent policy template；测试：`test/analysis-tool.test.ts`。
- [x] OFF-05：禁用或阻断 `websearch`。证据：`DEFAULT_ANALYSIS_TOOL_POLICY.blockedTools`、agent policy template；测试：`test/analysis-tool.test.ts`。
- [x] OFF-06：OpenCode Server agent 配置中默认 `edit = deny`，除非进入明确修改模式。证据：`createOpenCodeLocalAgentPolicyTemplate()`；测试：`test/analysis-tool.test.ts`。
- [x] OFF-07：OpenCode Server agent 配置中默认 `bash = deny/ask`，不得默认 allow。证据：`createOpenCodeLocalAgentPolicyTemplate()`；测试：`test/analysis-tool.test.ts`。
- [x] OFF-08：context-only 模式下 `read/grep/glob/list` 默认 deny，由 Local Analysis Tool 提供受控 evidence。证据：agent policy template 与 `<local-analysis-pack>`；测试：`test/analysis-tool.test.ts`。
- [ ] OFF-09：shared-workspace 模式下 `read/grep/lsp` 可 allow，但必须记录审计。
- [x] OFF-10：支持 OpenCode Server Basic Auth。证据：`RemoteOpenCodeClient.headers()` 发送 Basic Auth，密码保存于 VS Code SecretStorage；测试：`cmd /c npx -y bun@1.3.14 test`（181 pass）。
- [ ] OFF-11：支持 OpenCode Server 证书/自签证书策略说明。
- [ ] OFF-12：UI 显示当前 server URL、server 分类、agent、model、tool policy。
- [ ] OFF-13：新增审计日志，记录被拦截公网请求。
- [ ] OFF-14：新增审计日志，记录发给 OpenCode Server 的 prompt 摘要和 evidence 文件列表。
- [ ] OFF-15：新增断互联网但保留内网 OpenCode Server 的 E2E smoke test。
- [x] OFF-16：新增敏感文件默认排除规则。证据：`isSensitivePath()` 过滤 `.env`、keys、certs、credentials；测试：`bun run package`。
- [ ] OFF-17：新增外发 prompt 预览与审计导出。
- [ ] OFF-18：OpenCode Server 不可用时给出可操作诊断：server 未启动、auth 错误、网络被策略阻断、schema 不兼容。
- [x] OFF-19：支持本机 OpenCode Server：`http://127.0.0.1:4096`。证据：默认 `opencode.remote.serverUrl=http://localhost:4096` 与 Basic Auth client；测试：`test/remote-client.test.ts`。
- [ ] OFF-20：支持内网 OpenCode Server：私网 IP 或 allowlist 域名。
- [ ] OFF-21：禁止默认使用公共模型 API；模型入口应由 OpenCode Server 或内网模型网关管理。
- [ ] OFF-22：禁公网测试使用 OS 防火墙或测试代理验证，扩展层同时做 hard fail。

---

## 12. 状态机抽取任务清单

### 12.1 数据模型

- [x] SM-Model-01：定义 `StateMachine`：`id, name, module, root_symbols, state_var, language, confidence`。证据：`StateMachine` type；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Model-02：定义 `State`：`machine_id, state_id, name, value, definition_range, comment`。证据：`StateMachineState` type；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Model-03：定义 `Transition`：`from_state, to_state, event, guard, action, range, function_id, confidence`。证据：`StateMachineTransition` type；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Model-04：定义 `Path`：`machine_id, start_state, end_state, transitions[], conditions`。证据：`StateMachinePath` type；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Model-05：定义 `EvidenceRef`：`file, start_line, end_line, snippet_hash, parser_kind`。证据：`EvidenceRef` type；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Model-06：设计未知状态：`unknown/source_missing/target_missing`。证据：`unknown` fallback state 与 missing path handling；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Model-07：设计低置信度状态和转移的展示规则。证据：`lowConfidence` 与 `candidateTransitions`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Model-08：设计 transition 去重规则。证据：`dedupeTransitions()`；测试：`test/state-machine-extractor.test.ts`。
- [ ] SM-Model-09：设计跨函数 path 的 path compression 规则。
- [ ] SM-Model-10：设计 Mermaid/DOT/SVG cache 字段。

### 12.2 算法 v0

- [x] SM-Alg0-01：扫描 enum/typedef/宏，找候选状态集合。证据：`scanTypes()`、`scanMacros()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-02：扫描变量/字段/参数名，找候选状态变量。证据：`variableCandidates()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-03：扫描 `switch(state)`，提取 case 状态。证据：switch/case extraction；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-04：扫描 `if (state == X)` / `if (X == state)`，提取 guard。证据：guard extraction；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-05：扫描 `state = Y`，提取 transition。证据：`transitionAssignment()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-06：提取 transition 前后的函数调用作为 action。证据：`actionAround()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-07：提取错误码/消息类型/事件类型作为 event。证据：`eventFromText()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-08：构建 `from -> to` 有向图。证据：`buildQueries()`、`findStatePath()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-09：输出 transition table。证据：`stateMachineToTransitionTable()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-10：输出 Mermaid state diagram。证据：`toMermaid()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg0-11：将状态机结果注册到 Analysis Tool API。证据：`getStateMachines/getStatePath`；测试：`test/analysis-tool.test.ts`。

### 12.3 算法 v1

- [ ] SM-Alg1-01：接入 CFG，支持基本块与条件边。
- [x] SM-Alg1-02：支持跨函数传播。证据：`expandCrossFunctionTransitions()`；测试：`test/state-machine-extractor.test.ts`。
- [ ] SM-Alg1-03：支持 handler/callback/task loop 入口识别。
- [x] SM-Alg1-04：支持封装函数：`set_state`、`update_state`、`transition_to`。证据：`transitionMutator()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg1-05：支持结构体字段状态：`ctx->state`、`obj.state`。证据：transition var/field 扫描；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg1-06：支持返回值驱动状态变化。证据：return-state extraction；测试：`test/state-machine-extractor.test.ts`。
- [ ] SM-Alg1-07：支持多状态变量 disambiguation。
- [x] SM-Alg1-08：支持 reachability 查询。证据：`query.reachable`、`findStatePath()`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg1-09：支持 dead state 检测。证据：`query.deadStates`；测试：`test/state-machine-extractor.test.ts`。
- [x] SM-Alg1-10：支持 cycle 和 error path 检测。证据：`findCycles()`、`query.errorPaths`；测试：`test/state-machine-extractor.test.ts`。

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

- [x] SCALE-01：定义百万级 benchmark 规格：文件数、LOC、语言比例、平均文件大小、调用边数量、符号数量。证据：`CodeGraphBenchmarkSpec`、`formatCodeGraphBenchmarkReport()`。
- [x] SCALE-02：实现 synthetic repo generator。证据：`generateSyntheticCodeGraphFiles(count)`；测试：`test/codegraph-benchmark.test.ts`。
- [x] SCALE-03：实现 10k 文件基准。证据：`bun run benchmark:codegraph -- --files=10000`（files=10000, loc=30000, mode=full-index, queryP95Ms=94, peakHeapBytes=194039296）。
- [x] SCALE-04：实现 100k 文件基准。证据：`bun run benchmark:codegraph -- --files=100000`（files=100000, loc=300000, mode=full-index, queryP95Ms=1400, peakHeapBytes=1205975527）。
- [x] SCALE-05：实现 250k 文件基准。证据：`bun run benchmark:codegraph -- --files=250000`（files=250000, loc=750000, mode=streaming-sharded, queryP95Ms=5, peakHeapBytes=30594699）。
- [x] SCALE-06：实现 1M 文件基准。证据：`bun run benchmark:codegraph -- --files=1000000`（files=1000000, loc=3000000, mode=streaming-sharded, queryP95Ms=13, peakHeapBytes=68768088）。
- [x] SCALE-07：记录索引吞吐：files/sec、MB/sec。证据：1M report `filesPerSec=18040.1`, `mbPerSec=8`。
- [x] SCALE-08：记录峰值内存。证据：1M report `peakHeapBytes=68768088`。
- [x] SCALE-09：记录 DB/索引体积。证据：1M report `indexBytes=466444450`。
- [x] SCALE-10：记录查询 P50/P95/P99。证据：1M report `queryP50Ms=2`, `queryP95Ms=13`, `queryP99Ms=13`。
- [x] SCALE-11：记录增量更新延迟。证据：1M report `incrementalMs=58`。
- [x] SCALE-12：记录恢复时间。证据：1M report `recoveryMs=58`。
- [x] SCALE-13：实现 shard lazy loading。证据：`loadShardedIndex()` 大仓只加载 manifest、`activeIndexForQuestion()` 按查询加载 shard。
- [ ] SCALE-14：实现 postings 分片。
- [ ] SCALE-15：实现 graph edge 分片。
- [x] SCALE-16：实现查询 cost model。证据：`planShardKeysForQuery()` 按 related path/symbol/posting/module 评分选择 shard。
- [x] SCALE-17：实现内存预算配置。证据：`opencode.remote.codeGraph.memoryLimitMb`、`enforceMemoryBudget()`。
- [x] SCALE-18：实现大仓 watcher 降级。证据：`watcherRescanThreshold`、`rescanScheduled`、`recordWatcherStorm()`。
- [x] SCALE-19：实现索引任务 pause/resume。证据：`pauseIndexing()`、`resumeIndexing()`、UI actions。
- [ ] SCALE-20：实现索引错误重试与隔离。
- [x] SCALE-21：实现 top-N module pre-aggregation。证据：`moduleStats`、`buildCodeIntelligenceSnapshot()` 模块摘要。
- [x] SCALE-22：实现热门符号缓存。证据：`moduleStats.hotSymbols`、`CodeGraphHotCache`。
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

- [x] TEST-Perf-01：10k 文件索引。证据：`bun run benchmark:codegraph -- --files=10000`。
- [x] TEST-Perf-02：100k 文件索引。证据：`bun run benchmark:codegraph -- --files=100000`。
- [x] TEST-Perf-03：250k 文件索引。证据：`bun run benchmark:codegraph -- --files=250000`。
- [x] TEST-Perf-04：1M 文件索引。证据：`bun run benchmark:codegraph -- --files=1000000`。
- [x] TEST-Perf-05：查询 P50/P95/P99。证据：1M report `2/13/13 ms`。
- [x] TEST-Perf-06：增量更新 latency。证据：1M report `incrementalMs=58`。
- [x] TEST-Perf-07：DB 体积。证据：1M report `indexBytes=466444450`。
- [x] TEST-Perf-08：恢复时间。证据：1M report `recoveryMs=58`。
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
- [x] NEXT-04：生成 OpenCode offline agent/tool 权限模板，默认禁 webfetch/websearch。证据：`createOpenCodeLocalAgentPolicyTemplate()`；测试：`test/analysis-tool.test.ts`。
- [x] NEXT-05：抽象 Local Analysis Service API。证据：`LocalAnalysisServiceProtocol`、`CodeGraphContextProvider`；测试：`test/local-analysis-service.test.ts`。
- [x] NEXT-06：把现有 codegraph index 映射到 SQLite/FTS schema，保留 query 接口不变。证据：`CODEGRAPH_SQLITE_SCHEMA`、`CodeGraphStorageSchemaManifest`；测试：`test/codegraph-storage-schema.test.ts`。
- [x] NEXT-07：实现 Analysis Tool Bridge，让 OpenCode Server 可以查询本地索引。证据：`analysis-bridge.ts` 与 generated custom tool；测试：`test/analysis-tool.test.ts`。
- [x] NEXT-08：实现 `StateMachineExtractor v0`，用小型 C/C++ fixture 证明能输出 states/transitions/guards/actions。证据：`state-machine-extractor.ts`；测试：`test/state-machine-extractor.test.ts`。
- [x] NEXT-09：给 Webview 加最小 Code Intelligence 面板：索引状态、符号搜索、状态机列表、证据跳转。证据：`chat-html.ts`；测试：`test/chat-html.test.ts`。
- [x] NEXT-10：建立 benchmark 命令：生成 synthetic repo，跑索引、查询、增量、内存和 DB 体积报告。证据：`benchmark:codegraph`；测试：`test/codegraph-benchmark.test.ts`。
- [ ] NEXT-11：执行禁公网但允许本机/内网 OpenCode Server 的 E2E smoke test。
- [x] NEXT-12：执行 `bun test`。证据：`cmd /c npx -y bun@1.3.14 test`（198 pass）。
- [x] NEXT-13：执行 `bun run package`。证据：`cmd /c npx -y bun@1.3.14 run package`（pass）。
- [x] NEXT-14：把完成证据更新回本 Markdown 清单。证据：`RECORD-01/02` 与本次补勾。

---

## 16. Definition of Done

### 16.1 单个任务 DoD

- [ ] DoD-Task-01：代码已提交到对应分支。
- [x] DoD-Task-02：有最小单元测试或集成测试。证据：`test/analysis-tool.test.ts`、`test/state-machine-extractor.test.ts`、`test/codegraph-benchmark.test.ts` 等。
- [x] DoD-Task-03：测试命令已记录。证据：`RECORD-01/02` 记录 `bun test/package/vsix`。
- [ ] DoD-Task-04：涉及 UI 的任务有截图或录屏。
- [x] DoD-Task-05：涉及索引/性能的任务有 benchmark 输出。证据：`RECORD-02` 记录 10k/100k/250k/1M benchmark。
- [x] DoD-Task-06：涉及状态机的任务有 JSON + Mermaid + evidence。证据：`stateMachineToTransitionTable()`、`toMermaid()`、transition evidence；测试：`test/state-machine-extractor.test.ts`。
- [ ] DoD-Task-07：涉及离线的任务有禁公网验证，且允许的 OpenCode Server 连接已记录。
- [ ] DoD-Task-08：涉及 OpenCode Server 的任务有 capability report 和 tool policy report。
- [ ] DoD-Task-09：涉及模型回答的任务有 evidence verifier 结果。
- [x] DoD-Task-10：文档已更新。证据：`README.md` 与本 Markdown 清单已更新。

### 16.2 里程碑 DoD

- [ ] DoD-Milestone-01：里程碑下所有 P0/P1 必需项完成。
- [x] DoD-Milestone-02：`bun test` 通过。证据：`cmd /c npx -y bun@1.3.14 test`（198 pass）。
- [x] DoD-Milestone-03：`bun run package` 通过。证据：`cmd /c npx -y bun@1.3.14 run package`（pass）。
- [ ] DoD-Milestone-04：禁公网但允许 OpenCode Server 的 E2E 通过。
- [ ] DoD-Milestone-05：性能/准确性/离线安全指标有报告。
- [x] DoD-Milestone-06：已知限制已记录。证据：`RECORD-02` 备注记录 SQLite runtime/FTS/MCP/E2E 等后续限制。
- [ ] DoD-Milestone-07：回滚方案已记录。

---

## 17. 风险与缓解任务

- [x] RISK-01：把“离线”误实现为“不使用 OpenCode Server”；缓解：文档明确允许本机/内网 OpenCode Server 与 localhost Analysis Bridge。证据：`README.md`、清单 0.1/0.3。
- [x] RISK-02：OpenCode Server agent 默认工具过宽；缓解：生成权限模板，禁 webfetch/websearch，审计所有工具调用。证据：`createOpenCodeLocalAgentPolicyTemplate()`、`AnalysisToolAuditEntry`；测试：`test/analysis-tool.test.ts`。
- [ ] RISK-03：扩展层阻断不等于系统级断网；缓解：NetworkPolicyGuard + OS 防火墙/测试代理 E2E 双重验证。
- [x] RISK-04：百万级索引拖垮 VS Code；缓解：worker pool、任务限流、分片懒加载、取消/暂停、watcher 降级、streaming benchmark。证据：`CodeGraphWorkerPool`、`activeIndexForQuestion()`、1M benchmark。
- [ ] RISK-05：语义误判导致错误状态机；缓解：semantic provider、置信度、evidence、低置信度不做强结论、golden 测试。
- [x] RISK-06：索引体积过大；缓解：分片、冷热缓存、按目录/shard 查询、streaming-sharded benchmark。证据：`groupFilesByShard()`、`CodeGraphHotCache`、`loadShardFiles()`。
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

- [x] RECORD-01：批次编号：`2026-05-31-01`；完成任务：`M3-01/02/03/05/06/07/08/09, M5-01..16, M6-01/02/03/04/06/07/10`；commit/PR：`n/a local worktree`；测试：`cmd /c npx -y bun@1.3.14 test`（188 pass）、`cmd /c npx -y bun@1.3.14 run package`（pass）、`cmd /c npx -y bun@1.3.14 run vsix`（生成 `opencode-remote-0.0.41.vsix`）；OpenCode Server：`custom tool mode via localhost Analysis Bridge generated at .opencode/tools/opencode_local_analysis.ts`；网络策略：`127.0.0.1 token bridge, only analysis tools allowed, webfetch/websearch/edit/bash deny in generated vscode-local policy template`；备注：`M3-04/M6-05/M6-08/M6-09 未包含在本次用户点名范围内，保持未勾选。`
- [x] RECORD-02：批次编号：`2026-05-31-02`；完成任务：`STATE-IDX-01..05, M2-01..09/11/12/13/14, M7-01..10, SCALE-01..13/16/17/18/19/21/22, TEST-Perf-01..08`；commit/PR：`n/a local worktree`；测试：`cmd /c npx -y bun@1.3.14 test`（198 pass）、`cmd /c npx -y bun@1.3.14 run compile`（pass）、`cmd /c npx -y bun@1.3.14 run package`（pass）、`cmd /c npx -y bun@1.3.14 run vsix`（生成 `opencode-remote-0.0.44.vsix`）；benchmark：`bun run benchmark:codegraph -- --files=10000`（P95=94ms）、`--files=100000`（P95=1400ms）、`--files=250000`（mode=streaming-sharded, P95=5ms, peakHeapBytes=30594699）、`--files=1000000`（mode=streaming-sharded, P50/P95/P99=2/13/13ms, peakHeapBytes=68768088, indexBytes=466444450, recoveryMs=58）；OpenCode Server：`n/a，本批聚焦本地百万级 code graph 能力，未新增公网访问`；网络策略：`沿用 localhost Analysis Bridge 与 local-only 策略，未引入 embedding/vector/RAG 外部依赖`；备注：`严格 SQLite runtime/FTS-BM25、postings/graph edge 物理分片、OpenCode 首 token latency 与服务端主动 E2E 仍留给后续批次。`
- [ ] RECORD-03：批次编号：`YYYY-MM-DD-03`；完成任务：`...`；commit/PR：`...`；测试：`...`；OpenCode Server：`...`；网络策略：`...`；备注：`...`
