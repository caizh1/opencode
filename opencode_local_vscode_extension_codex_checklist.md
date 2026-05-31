# OpenCode local-vscode-extension 代码分析与 Codex 开发任务清单

> 分析对象：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension>  
> 目标：离线环境、百万级整仓代码理解、模块/子模块/功能级工作逻辑、状态机切换路径/条件/流程分析。  
> 使用方式：Codex 每完成一项任务，将 `- [ ]` 改为 `- [x]`，并在同一行或下一行补充 PR/commit/test 证据。

---

## 0. 任务勾选规则

- [ ] 勾选时只把 `- [ ]` 改成 `- [x]`，不要删除任务原文。
- [ ] 每个完成项后补充证据：PR 编号、commit hash、测试命令、截图或基准报告路径。
- [ ] 没有证据的任务不要勾选；只能标注为 `blocked:`、`partial:` 或 `needs-review:`。
- [ ] 涉及行为变更的任务必须至少执行相关 `bun test`。
- [ ] 发布或打包前必须执行 `bun run package`。
- [ ] 涉及离线能力的任务必须在断网/禁网 mock 环境下验证。
- [ ] 涉及状态机抽取的任务必须给出 `states / transitions / guards / actions / evidence file:line`。
- [ ] 涉及百万级能力的任务必须给出索引耗时、峰值内存、DB/索引体积、查询 P50/P95、增量更新时间。

---

## 1. 当前结论

当前分支可定位为：**VS Code 本地上下文 + 远端 OpenCode 对话 + 本地 C/C++ 轻量 code graph 辅助检索**。

它已经具备：

- VS Code 扩展入口、命令、状态栏、SecretStorage、Webview Chat、inline completion provider。
- 远端 `opencode serve` 连接、health probe、Basic Auth、session/message/prompt_async、SSE event stream。
- 本地上下文采集：当前文件、选区、打开文件、手动附加文件、`@mention` 文件、诊断、Git diff。
- local-only prompt contract 与 strict local-only agent 选择机制。
- C/C++ 轻量 code graph：include、macro、function、call、type/global/tokens、Tree-sitter AST 摘要、倒排检索、模块统计、增量 watcher。
- inline completion：debounce、cache、pending 复用、取消、响应清洗、缩进和格式化。

尚未达到：

- 真离线：问答/补全仍依赖远端 OpenCode 或远端模型服务，没有完整本地模型/embedding/rerank/provider 链路。
- 百万级整仓：当前 `codeGraph.maxFiles` 默认 50,000，配置上限 250,000，且主索引仍偏扩展进程内对象，不适合作为百万级主索引核心。
- 多语言语义图：当前重点是 C/C++ 轻量解析，semantic mode 仍需真正接入 clangd/SCIP/LSIF 等语义来源。
- 业务状态机抽取：扩展自身连接、索引、聊天、补全状态机较清晰，但对被分析仓库的业务代码尚未抽取 `state / transition / guard / action / path`。
- 模块/子模块/功能级稳定理解：当前主要是即时 evidence 拼接，尚无分层摘要、功能地图、跨语言依赖图、状态机图和证据钻取 UI。

---

## 2. 当前能力矩阵

| 目标要求 | 当前达到程度 | 判断 |
|---|---|---|
| 离线环境 | 部分达到 | 本地上下文与 code graph 索引在 VS Code 侧；但聊天和补全仍依赖远端 OpenCode/model。 |
| 百万级整仓理解 | 未达到 | 当前文件上限与架构不适合百万级主索引；缺持久 DB、独立 daemon、百万级压测。 |
| 模块/子模块/功能逻辑理解 | 部分达到 | 可按文件、目录、符号、调用关系抽取 evidence；缺分层摘要、功能地图、跨语言语义切片。 |
| 状态机路径/条件/流程 | 产品自身状态机清晰；目标代码状态机未达到 | 只有 AST if/switch/case 摘要，没有业务 state transition 抽取器。 |
| 离线安全/本地只读 | 部分达到 | 有 prompt contract 和 strict agent；缺系统级 no-network、工具权限、敏感文件过滤和审计。 |

---

## 3. 模块与工作逻辑摘要

### 3.1 扩展入口与连接编排

`extension.ts` 负责 activation、OutputChannel、LocalContextStore、EditorContextTracker、状态栏、RemoteOpenCodeClient、LocalCodeGraphService、RemoteChatViewProvider、inline completion provider 和命令注册。

连接状态主路径：

```text
[disconnected]
  -> connect/test/saved settings probe
[connecting]
  -> health ok                 -> [connected]
  -> auth error                -> [authFailed]
  -> timeout/network/unhealthy -> [error]
[connected]
  -> disconnect/dispose        -> [disconnected]
```

### 3.2 本地上下文与 local-only guard

`context.ts` 的核心职责是把问题、当前文件、选区、打开文件、`@mention`、手动添加文件、诊断、Git diff、可选 code graph evidence 组织成 prompt。

```text
buildChatPrompt(question):
  1. buildLocalContext(question, mentionedFiles)
  2. if codeGraph enabled: codeGraph.buildContext(question, relatedPaths)
  3. if localOnlyMode: append Local Context Contract
  4. if looksLikeLocalFileQuestion && no evidence: MissingLocalContextError
  5. append <files>, <diagnostics>, <git-diff>, <codegraph>
  6. send final prompt to backend
```

### 3.3 Webview Chat 与 SSE 流

`chat-view.ts` 维护 session、messages、model/agent、发送状态、mention 索引、event subscription、乐观消息、server tool warning。`chat-stream.ts` 负责把 OpenCode 的增量事件归一化为本地稳定消息列表。

聊天状态主路径：

```text
UI idle
  -> user send
  -> optimistic user message
  -> build local context / codegraph evidence
  -> MissingLocalContextError -> local error, stop
  -> get/create plugin chat session
  -> ensure event subscription
  -> stream ready -> prompt_async -> streaming
  -> stream failed/timeout -> blocking sendMessage -> refresh messages

streaming
  -> message.part.updated / message.updated -> merge render
  -> session.status=idle or message.time.completed -> finalizing
  -> session.error -> local error + finalizing
  -> event loss -> refresh
```

### 3.4 C/C++ code graph

当前 code graph 主要由 `codegraph-service.ts`、`codegraph-c-parser.ts`、`codegraph-ast.ts`、`codegraph-index.ts`、`codegraph-query.ts` 构成。它能建立 C/C++ 粗粒度调用、包含、符号、倒排和模块统计证据。

索引状态主路径：

```text
[disabled]
  -> config enabled / user enables
[indexing]
  -> success -> [ready]
  -> error   -> [error]
[ready]
  -> file create/change/delete watcher -> [stale]
[stale]
  -> debounce/applyPendingChanges -> [indexing]
```

### 3.5 inline completion

`completion.ts` + `completion-request-coordinator.ts` 负责 VS Code InlineCompletion 生命周期。

```text
triggered
  -> scheduled(debounce)
  -> request
  -> sent
  -> received
  -> filtered-or-no-visible-text | edit-rejected | edit-ready
  -> returned(source=remote/cache/local-fallback)

取消路径：
  new key arrives -> cancel pending(reason=stale-key)
  VS Code CancellationToken -> cancelled(reason=vscode-token)
  clear/disconnect -> cancel pending(reason=clear)
```

---

## 4. MVP：最小可行增强版本

- [ ] MVP-01：把现有 `LocalCodeGraphService` 的索引结果迁移到 SQLite + FTS；先不改检索逻辑，只替换存储和增量扫描基础设施。
- [ ] MVP-02：新增 `StateMachineExtractor v0`，只支持 C/C++ `enum` + `switch(state)` + `state = X` + `if guard`，输出 transition table 和 Mermaid。
- [ ] MVP-03：在 Webview 中新增 `Code Graph / State Machines` 面板，展示索引状态、模块树、符号搜索、状态机列表、证据跳转。
- [ ] MVP-04：新增 local backend 配置，允许 chat/completion 指向本机 OpenCode 或本机模型服务。
- [ ] MVP-05：新增 offline/no-network 开关，开启后禁止远端请求，或在 UI 中明确阻断并提示。
- [ ] MVP-06：建立 golden fixtures：调用图、include 图、状态机、宏条件编译、函数指针、重名符号、百万级 synthetic repo。
- [ ] MVP-07：每个 MVP 输出必须包含测试命令、截图或日志、基准数据和已知限制。

---

## 5. 里程碑开发计划

### M0：基线固化

- [ ] M0-01：补齐 README 与配置说明，明确当前 remote/local/local-only/offline 能力边界。
- [ ] M0-02：统一日志结构，区分 connect、chat、context、codegraph、completion、security、benchmark。
- [ ] M0-03：建立现有功能 smoke test：连接、聊天、SSE fallback、上下文构建、code graph 索引、inline completion。
- [ ] M0-04：CI 执行 `bun test`。
- [ ] M0-05：CI 执行 `bun run package`。
- [ ] M0-06：记录当前性能基线：中型 C/C++ 仓库索引时间、峰值内存、查询延迟、索引体积。
- [ ] M0-07：为 `chat-view.ts`、`context.ts`、`codegraph-query.ts`、`completion-request-coordinator.ts` 增加关键路径单测或集成测试。
- [ ] M0-08：验收：现有测试通过，VSIX 可打包，中型 C/C++ 仓库索引与聊天/补全流程可重复验证。

### M1：索引服务化

- [ ] M1-01：定义 `LocalAnalysisService` 协议，包含 `status / index / query / stateMachine / cancel / metrics`。
- [ ] M1-02：实现本地 crawler，支持 `git ls-files`、ignore 规则、hash snapshot、删除检测。
- [ ] M1-03：实现 job queue，支持全量索引、增量索引、取消、恢复、进度事件。
- [ ] M1-04：把重 IO/CPU 的扫描、读取、解析从 VS Code 扩展宿主迁移到本地 daemon 或 worker 进程。
- [ ] M1-05：实现 SQLite/FTS 存储：files、symbols、edges、postings、modules、snapshots、schema_version。
- [ ] M1-06：扩展端通过 API 查询索引状态和 evidence，不再直接承载百万级内存索引。
- [ ] M1-07：保留原 `codegraph-query.ts` 查询接口，内部逐步切换到持久化存储。
- [ ] M1-08：验收：扩展 UI 不因索引卡顿，索引可断点恢复，10 万级文件索引内存稳定，查询返回 line-range evidence。

### M2：语义图增强

- [ ] M2-01：接入 `compile_commands.json`，解析 include path、defines、compiler args、build target。
- [ ] M2-02：新增 `SemanticProvider` 接口，支持 clangd、SCIP/LSIF、ctags fallback。
- [ ] M2-03：C/C++ semantic mode 不再静默降级；降级时必须记录原因、能力缺失和 confidence。
- [ ] M2-04：把函数调用从 name-level 提升到 symbolId-level，记录 callee、callsite range、confidence。
- [ ] M2-05：补齐 include/import graph、symbol graph、call graph、module graph 的统一边模型。
- [ ] M2-06：支持宏、条件编译、命名空间、重载、函数指针的置信度标注。
- [ ] M2-07：扩展 Tree-sitter 多语言基础解析，至少支持 C/C++ + 一种脚本语言。
- [ ] M2-08：验收：golden 仓库 callers/callees/call-chain 达到可量化 precision/recall；支持 C/C++ + 至少一种脚本语言。

### M3：状态机抽取

- [ ] M3-01：实现 `StateMachineExtractor` 子系统。
- [ ] M3-02：识别候选状态变量：`state/status/mode/phase/stage/event` 命名、enum、macro、typedef、结构体字段、函数参数。
- [ ] M3-03：识别状态集合：enum 成员、宏常量、字符串常量、有限整型常量。
- [ ] M3-04：识别转移语句：`state = X`、字段写入、`set_state/update_state/transition_to`、返回值驱动状态变化。
- [ ] M3-05：提取事件与 guard：上层 `if/else`、`switch case`、循环条件、错误码、消息类型、函数入参、调用上下文。
- [ ] M3-06：提取 action：转移前后调用函数、日志、资源操作、队列/消息发送、锁操作。
- [ ] M3-07：支持跨函数传播：从入口函数、handler、callback、任务循环沿调用图传播状态变量。
- [ ] M3-08：实现路径合成：`source state -> event/guard/action -> target state` directed graph。
- [ ] M3-09：支持 reachability、dead state、cycle、error path 查询。
- [ ] M3-10：为每条 transition 记录 `file:start_line-end_line` evidence。
- [ ] M3-11：为状态机、状态、转移、路径标注 confidence：semantic AST 高、regex 中、模型推断低。
- [ ] M3-12：输出 JSON transition table。
- [ ] M3-13：输出 Mermaid 图。
- [ ] M3-14：输出 DOT/Graphviz 图。
- [ ] M3-15：验收：对测试夹具和真实模块输出状态表、转移表、路径、guard/action 和证据；错误/未知路径明确标注。

### M4：分层理解与离线 RAG

- [ ] M4-01：建立函数级摘要，摘要必须关联 source evidence。
- [ ] M4-02：建立文件级摘要，包含核心符号、输入输出、依赖、状态机、风险点。
- [ ] M4-03：建立目录/模块级摘要，支持模块职责、子模块划分、关键流程、调用入口。
- [ ] M4-04：建立子系统级摘要，支持跨模块流程说明。
- [ ] M4-05：实现 hybrid retrieval：exact path + symbol table + BM25 + vector + graph expansion + state-machine index。
- [ ] M4-06：实现 evidence packer：dedupe、line range、confidence、byte/token budget、missing evidence notes。
- [ ] M4-07：实现 answer policy：只基于 evidence 回答，必须引用 file:line，无证据时拒答或提示缺失。
- [ ] M4-08：实现本地 embedding provider。
- [ ] M4-09：实现本地 reranker provider。
- [ ] M4-10：实现本地/offline chat provider。
- [ ] M4-11：验收：用户可问“某模块某功能流程”，答案包含结构化流程、调用链、状态机和证据行。

### M5：百万级规模化

- [ ] M5-01：实现分片倒排索引，支持按语言、目录、模块、shard 懒加载。
- [ ] M5-02：实现批量 IO 和并行解析 worker pool。
- [ ] M5-03：实现 watcher 降级策略：大量变更时从 file watcher 切换为周期扫描/快照对比。
- [ ] M5-04：实现冷热缓存策略：热模块、热符号、热查询结果、摘要缓存。
- [ ] M5-05：实现内存水位线和自动降级策略。
- [ ] M5-06：实现 synthetic repo 生成器，覆盖 10k / 100k / 250k / 1M 文件规模。
- [ ] M5-07：实现 benchmark 命令，输出索引时间、吞吐、峰值内存、DB 体积、查询 P50/P95、增量更新时间。
- [ ] M5-08：实现 crash recovery，索引中断后可恢复。
- [ ] M5-09：实现 schema migration 和索引版本兼容策略。
- [ ] M5-10：验收：构造或真实百万级仓库基准通过，查询延迟、内存峰值、索引时间和增量更新有报告。

### M6：产品化与安全

- [ ] M6-01：新增模块树 UI，可从 workspace drill down 到目录、模块、文件、函数。
- [ ] M6-02：新增状态机浏览器，支持状态列表、转移表、路径查询、图形导出、证据跳转。
- [ ] M6-03：新增调用图/依赖图视图，支持 callers、callees、call-chain、impact。
- [ ] M6-04：新增 evidence panel，展示证据片段、line range、confidence、query trace。
- [ ] M6-05：新增索引健康仪表盘：进度、队列、错误、stale 文件、DB 体积、性能指标。
- [ ] M6-06：新增审计日志：模型请求、外发内容、工具调用、被拦截请求、敏感文件过滤结果。
- [ ] M6-07：新增敏感文件策略：`.env`、secret、key、证书、私钥、凭据文件默认不进入 prompt/index summary。
- [ ] M6-08：新增 no-network policy，offline 模式下所有 remote backend 请求 hard fail。
- [ ] M6-09：新增 workspace trust 与权限提示，用户明确授权后才索引大型仓库或敏感目录。
- [ ] M6-10：验收：离线模式无外联，用户能在 UI 中钻取模块、函数、状态机和证据，安全策略可配置可审计。

---

## 6. 详细 Backlog

### P0：必须先做

- [ ] P0-01：新增 `LocalAnalysisService` 接口。
  - [ ] P0-01a：定义 `status()` API。
  - [ ] P0-01b：定义 `index(workspace, options)` API。
  - [ ] P0-01c：定义 `query(query, scope, budget)` API。
  - [ ] P0-01d：定义 `stateMachine(scope, query)` API。
  - [ ] P0-01e：定义 `cancel(jobId)` API。
  - [ ] P0-01f：定义 `metrics()` API。
  - [ ] P0-01g：在 `extension.ts` 中通过 gateway 调用，不直接跑重索引。

- [ ] P0-02：新增持久化索引库。
  - [ ] P0-02a：设计 schema：files、symbols、edges、postings、modules、state_machines、snapshots、schema_version。
  - [ ] P0-02b：实现文件快照表：path、size、mtime、sha256、language、module、shard。
  - [ ] P0-02c：实现符号表：symbol_id、kind、name、fq_name、file、range、signature、confidence。
  - [ ] P0-02d：实现调用/依赖边表：src、dst、edge_kind、range、confidence、build_config。
  - [ ] P0-02e：实现 FTS postings：term、doc_id、field、weight。
  - [ ] P0-02f：实现 moduleStats 与 directoryStats 持久化。
  - [ ] P0-02g：实现 schema version 与 migration。

- [ ] P0-03：新增增量构建与任务队列。
  - [ ] P0-03a：实现文件 hash 检测。
  - [ ] P0-03b：实现删除检测。
  - [ ] P0-03c：实现批处理队列。
  - [ ] P0-03d：实现可取消任务。
  - [ ] P0-03e：实现崩溃恢复。
  - [ ] P0-03f：实现进度事件。
  - [ ] P0-03g：实现 watcher 事件压缩和 debounce。

- [ ] P0-04：实现状态机抽取 v0。
  - [ ] P0-04a：支持 C/C++ enum 状态集合。
  - [ ] P0-04b：支持 macro 常量状态集合。
  - [ ] P0-04c：支持 `switch(state)`。
  - [ ] P0-04d：支持 `if (state == X)` guard。
  - [ ] P0-04e：支持 `state = Y` assignment transition。
  - [ ] P0-04f：支持 action 函数调用提取。
  - [ ] P0-04g：输出 JSON。
  - [ ] P0-04h：输出 Mermaid。
  - [ ] P0-04i：每条 transition 带 evidence。

- [ ] P0-05：新增离线后端适配。
  - [ ] P0-05a：抽象 `RemoteOpenCodeClient` 为 `BackendAdapter`。
  - [ ] P0-05b：实现 remote backend。
  - [ ] P0-05c：实现 local OpenCode backend。
  - [ ] P0-05d：实现 local model service backend。
  - [ ] P0-05e：实现 offline mode 禁外联。
  - [ ] P0-05f：实现后端能力探测：chat、completion、embedding、rerank、tools。

- [ ] P0-06：建立评测框架。
  - [ ] P0-06a：新增 codegraph recall fixtures。
  - [ ] P0-06b：新增状态机 golden fixtures。
  - [ ] P0-06c：新增性能基准。
  - [ ] P0-06d：新增离线安全基准。
  - [ ] P0-06e：新增回归报告输出。
  - [ ] P0-06f：CI 中至少运行小型 fixture。

### P1：增强准确性与体验

- [ ] P1-01：接入 clangd/SCIP 语义能力。
  - [ ] P1-01a：解析 `compile_commands.json`。
  - [ ] P1-01b：探测 clangd 路径与版本。
  - [ ] P1-01c：探测 scip-clang 路径与版本。
  - [ ] P1-01d：把 semantic call edge 映射到统一 edge schema。
  - [ ] P1-01e：semantic 不可用时输出降级原因。

- [ ] P1-02：新增多语言 Tree-sitter。
  - [ ] P1-02a：定义 language adapter 接口。
  - [ ] P1-02b：支持 TypeScript/JavaScript 符号、import、函数调用。
  - [ ] P1-02c：支持 Python 符号、import、函数调用。
  - [ ] P1-02d：支持 Go 符号、import、函数调用。
  - [ ] P1-02e：支持 Rust 符号、use、函数调用。
  - [ ] P1-02f：支持 Java 类、方法、import。
  - [ ] P1-02g：每种语言都有小型 fixture。

- [ ] P1-03：实现分层摘要。
  - [ ] P1-03a：函数摘要。
  - [ ] P1-03b：文件摘要。
  - [ ] P1-03c：目录摘要。
  - [ ] P1-03d：模块摘要。
  - [ ] P1-03e：子系统摘要。
  - [ ] P1-03f：摘要必须绑定 evidence_refs。
  - [ ] P1-03g：摘要支持增量更新。

- [ ] P1-04：实现混合检索/RAG planner。
  - [ ] P1-04a：intent classifier 支持 overview、module logic、callers、callees、call-chain、impact、state-machine、code search。
  - [ ] P1-04b：path/symbol extraction。
  - [ ] P1-04c：module scope inference。
  - [ ] P1-04d：BM25 检索。
  - [ ] P1-04e：向量检索。
  - [ ] P1-04f：图扩展。
  - [ ] P1-04g：状态机索引扩展。
  - [ ] P1-04h：rerank 与 evidence pack。

- [ ] P1-05：新增图谱和状态机 UI。
  - [ ] P1-05a：模块树。
  - [ ] P1-05b：符号搜索。
  - [ ] P1-05c：调用图。
  - [ ] P1-05d：状态机图。
  - [ ] P1-05e：证据表。
  - [ ] P1-05f：点击跳转源码。
  - [ ] P1-05g：Mermaid/DOT/SVG 导出。

### P2：高级能力

- [ ] P2-01：支持构建配置维度。
  - [ ] P2-01a：按 build target 存储符号/边。
  - [ ] P2-01b：按宏配置区分 include/call/state transition。
  - [ ] P2-01c：查询时允许选择 build config。

- [ ] P2-02：实现模型输出验证器。
  - [ ] P2-02a：答案必须引用 evidence。
  - [ ] P2-02b：检查 file:line 引用是否真实存在。
  - [ ] P2-02c：检查 answer 中是否出现无证据结论。
  - [ ] P2-02d：无证据时拒答或提示缺失。

- [ ] P2-03：支持团队共享缓存。
  - [ ] P2-03a：设计可导入/导出的索引 artifact。
  - [ ] P2-03b：加入权限与隐私策略。
  - [ ] P2-03c：支持只共享摘要/图谱，不共享源码片段。

---

## 7. 状态机抽取任务清单

### 7.1 数据模型

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

### 7.2 算法 v0

- [ ] SM-Alg-01：扫描 enum/typedef/宏，找候选状态集合。
- [ ] SM-Alg-02：扫描变量/字段/参数名，找候选状态变量。
- [ ] SM-Alg-03：扫描 `switch(state)`，提取 case 状态。
- [ ] SM-Alg-04：扫描 `if (state == X)` / `if (X == state)`，提取 guard。
- [ ] SM-Alg-05：扫描 `state = Y`，提取 transition。
- [ ] SM-Alg-06：提取 transition 前后的函数调用作为 action。
- [ ] SM-Alg-07：提取错误码/消息类型/事件类型作为 event。
- [ ] SM-Alg-08：构建 `from -> to` 有向图。
- [ ] SM-Alg-09：输出 transition table。
- [ ] SM-Alg-10：输出 Mermaid state diagram。

### 7.3 算法 v1

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

### 7.4 UI 与查询

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

---

## 8. 离线能力任务清单

- [ ] OFF-01：新增 `opencode.remote.backendMode = remote | local | offline`。
- [ ] OFF-02：新增 `opencode.remote.offline.noNetwork = true`。
- [ ] OFF-03：新增 `LocalChatBackend`。
- [ ] OFF-04：新增 `LocalCompletionBackend`。
- [ ] OFF-05：新增 `LocalEmbeddingBackend`。
- [ ] OFF-06：新增 `LocalRerankBackend`。
- [ ] OFF-07：支持 Ollama endpoint。
- [ ] OFF-08：支持 llama.cpp server endpoint。
- [ ] OFF-09：支持 vLLM local endpoint。
- [ ] OFF-10：支持本地 OpenCode endpoint。
- [ ] OFF-11：offline 模式下 remote client hard fail。
- [ ] OFF-12：offline 模式下任何 `fetch` 外联都必须被 policy 拦截。
- [ ] OFF-13：offline 模式 UI 显示当前后端与网络策略。
- [ ] OFF-14：新增审计日志，记录被拦截外联。
- [ ] OFF-15：新增断网 E2E smoke test。
- [ ] OFF-16：新增敏感文件默认排除规则。
- [ ] OFF-17：新增外发 prompt 预览与审计导出。
- [ ] OFF-18：新增本地模型缺失时的可操作错误提示。

---

## 9. 百万级整仓任务清单

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

---

## 10. 测试与验收清单

### 10.1 单元测试

- [ ] TEST-Unit-01：parser 边界测试。
- [ ] TEST-Unit-02：index hydrate 测试。
- [ ] TEST-Unit-03：query mode classifier 测试。
- [ ] TEST-Unit-04：state-machine extractor v0 测试。
- [ ] TEST-Unit-05：completion edit/format/indent 测试。
- [ ] TEST-Unit-06：context guard 测试。
- [ ] TEST-Unit-07：offline policy 测试。
- [ ] TEST-Unit-08：schema migration 测试。

### 10.2 集成测试

- [ ] TEST-Integration-01：VS Code extension host + local daemon。
- [ ] TEST-Integration-02：连接/断开。
- [ ] TEST-Integration-03：SSE 事件流。
- [ ] TEST-Integration-04：blocking fallback。
- [ ] TEST-Integration-05：index status。
- [ ] TEST-Integration-06：UI command。
- [ ] TEST-Integration-07：state-machine query。
- [ ] TEST-Integration-08：local backend chat/completion。

### 10.3 语义准确性测试

- [ ] TEST-Accuracy-01：callers precision/recall/F1。
- [ ] TEST-Accuracy-02：callees precision/recall/F1。
- [ ] TEST-Accuracy-03：call-chain precision/recall/F1。
- [ ] TEST-Accuracy-04：symbol binding accuracy。
- [ ] TEST-Accuracy-05：state transition accuracy。
- [ ] TEST-Accuracy-06：guard extraction accuracy。
- [ ] TEST-Accuracy-07：action extraction accuracy。
- [ ] TEST-Accuracy-08：path query accuracy。

### 10.4 性能测试

- [ ] TEST-Perf-01：10k 文件索引。
- [ ] TEST-Perf-02：100k 文件索引。
- [ ] TEST-Perf-03：250k 文件索引。
- [ ] TEST-Perf-04：1M 文件索引。
- [ ] TEST-Perf-05：查询 P50/P95/P99。
- [ ] TEST-Perf-06：增量更新 latency。
- [ ] TEST-Perf-07：DB 体积。
- [ ] TEST-Perf-08：恢复时间。

### 10.5 离线安全测试

- [ ] TEST-Security-01：禁网环境下 chat 可走本地 backend。
- [ ] TEST-Security-02：禁网环境下 completion 可走本地 backend。
- [ ] TEST-Security-03：禁网环境下索引可运行。
- [ ] TEST-Security-04：offline 模式无外联。
- [ ] TEST-Security-05：敏感文件不进入 prompt。
- [ ] TEST-Security-06：敏感文件不进入摘要。
- [ ] TEST-Security-07：审计日志可追踪。
- [ ] TEST-Security-08：server tools 被禁用或 hard fail。

### 10.6 E2E 用户任务

- [ ] TEST-E2E-01：解释某模块功能。
- [ ] TEST-E2E-02：解释某子模块某功能工作流程。
- [ ] TEST-E2E-03：找某状态机所有状态。
- [ ] TEST-E2E-04：找某状态机从 A 到 B 的路径。
- [ ] TEST-E2E-05：解释某 transition 的切换条件和动作。
- [ ] TEST-E2E-06：做改动影响分析。
- [ ] TEST-E2E-07：做 callers/callees/call-chain 查询。
- [ ] TEST-E2E-08：使用本地模型完成问答。
- [ ] TEST-E2E-09：使用本地模型完成补全。
- [ ] TEST-E2E-10：UI 中从答案 evidence 跳转源码。

---

## 11. 建议下一步落地顺序

- [ ] NEXT-01：新增 ADR，明确目标架构从 VS Code 扩展内索引升级为 Local Analysis Daemon。
- [ ] NEXT-02：在 ADR 中确定 DB/FTS/graph/vector 技术选型。
- [ ] NEXT-03：抽象 `RemoteOpenCodeClient` 为 `BackendAdapter`，避免离线模型和远端模型继续耦合。
- [ ] NEXT-04：把现有 codegraph index 映射到数据库 schema，保留 query 接口不变。
- [ ] NEXT-05：实现 `StateMachineExtractor v0`，用小型 C/C++ fixture 证明能输出 states/transitions/guards/actions。
- [ ] NEXT-06：给 Webview 加最小 Code Intelligence 面板：索引状态、符号搜索、状态机列表、证据跳转。
- [ ] NEXT-07：建立 benchmark 命令：生成 synthetic repo，跑索引、查询、增量、内存和 DB 体积报告。
- [ ] NEXT-08：执行 `bun test`。
- [ ] NEXT-09：执行 `bun run package`。
- [ ] NEXT-10：把完成证据更新回本 Markdown 清单。

---

## 12. Definition of Done

### 单个任务 DoD

- [ ] DoD-Task-01：代码已提交到对应分支。
- [ ] DoD-Task-02：有最小单元测试或集成测试。
- [ ] DoD-Task-03：测试命令已记录。
- [ ] DoD-Task-04：涉及 UI 的任务有截图或录屏。
- [ ] DoD-Task-05：涉及索引/性能的任务有 benchmark 输出。
- [ ] DoD-Task-06：涉及状态机的任务有 JSON + Mermaid + evidence。
- [ ] DoD-Task-07：涉及离线的任务有禁网验证。
- [ ] DoD-Task-08：文档已更新。

### 里程碑 DoD

- [ ] DoD-Milestone-01：里程碑下所有 P0/P1 必需项完成。
- [ ] DoD-Milestone-02：`bun test` 通过。
- [ ] DoD-Milestone-03：`bun run package` 通过。
- [ ] DoD-Milestone-04：性能/准确性/离线安全指标有报告。
- [ ] DoD-Milestone-05：已知限制已记录。
- [ ] DoD-Milestone-06：回滚方案已记录。

---

## 13. 风险与缓解任务

- [ ] RISK-01：百万级索引拖垮 VS Code；缓解：索引 daemon 化、进程隔离、任务限流、批处理、取消、watcher 降级。
- [ ] RISK-02：语义误判导致错误状态机；缓解：semantic provider、置信度、evidence、低置信度不做强结论、golden 测试。
- [ ] RISK-03：离线模式名义化；缓解：统一 BackendAdapter、no-network policy、连接前检查、审计日志、默认本地。
- [ ] RISK-04：索引体积过大；缓解：分片、压缩、冷热分层、摘要缓存、按语言/目录选择性索引。
- [ ] RISK-05：答案幻觉；缓解：回答策略强制 evidence 引用，缺证据提示，结果校验器检查 file:line 引用。
- [ ] RISK-06：UI 信息过载；缓解：默认折叠模块，按 query 展开，支持过滤、跳转和导出。
- [ ] RISK-07：敏感信息泄露；缓解：敏感文件默认排除、prompt 预览、审计、workspace trust、可选加密。

---

## 14. 资料来源

- GitHub 分支根目录：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension>
- README：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension#readme>
- src 目录：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension/src>
- test 目录：<https://github.com/caizh1/opencode/tree/codex/local-vscode-extension/test>
- package.json：<https://raw.githubusercontent.com/caizh1/opencode/codex/local-vscode-extension/package.json>
- AGENTS.md：<https://raw.githubusercontent.com/caizh1/opencode/codex/local-vscode-extension/AGENTS.md>
- VS Code API Reference：<https://code.visualstudio.com/api/references/vscode-api>
- VS Code Built-in Commands：<https://code.visualstudio.com/api/references/commands>

---

## 15. Codex 完成记录

> 每完成一批任务，在这里追加记录。

- [x] RECORD-01：批次编号：`2026-05-31-01`；完成任务：功能增强收尾验证（usage 显示、chat/history 加载稳定性、code graph 自动索引与发送前 readiness）；commit/PR：working tree 未提交；测试：`cmd /c npx -y bun@1.3.14 test`（164 pass）、`cmd /c npx -y bun@1.3.14 run compile`、`cmd /c npx -y bun@1.3.14 run package`；备注：当前环境 PATH 中没有 `bun`，使用临时 `npx bun@1.3.14` 执行同等 bun 命令；未运行 `bun run vsix`，因此未递增到 `0.0.33`。
- [x] RECORD-02：批次编号：`2026-05-31-02`；完成任务：本地 VSIX 打包为 `opencode-remote-0.0.33.vsix`；commit/PR：working tree 未提交；测试：`cmd /c npx -y bun@1.3.14 run vsix`（内含 `bun run package`，type check/lint/tsc 通过）；备注：打包前因仓库根目录已存在 `opencode-remote-*.vsix`，已按规则将 `package.json` patch version 从 `0.0.32` 递增到 `0.0.33`；vsce 提示缺少 LICENSE 文件，为非阻断警告。
- [x] RECORD-03：批次编号：`2026-05-31-03`；完成任务：解耦 connect/chat send 与 code graph index，发送聊天不再等待本地索引 ready，code graph 仅作为后台增强和可选 prompt evidence；commit/PR：working tree 未提交；测试：`cmd /c npx -y bun@1.3.14 test`（164 pass）、`cmd /c npx -y bun@1.3.14 run compile`、`cmd /c npx -y bun@1.3.14 run package`；备注：移除 chat send readiness gate、Webview waiting override 和 `CodeGraphContextProvider.waitForReady()`。
- [x] RECORD-04：批次编号：`2026-05-31-04`；完成任务：重新本地 VSIX 打包为 `opencode-remote-0.0.34.vsix`；commit/PR：working tree 未提交；测试：`cmd /c npx -y bun@1.3.14 run vsix`（内含 `bun run package`，type check/lint/tsc 通过）、`cmd /c npx -y bun@1.3.14 run package`；备注：打包前因仓库根目录已存在 `opencode-remote-*.vsix`，已按规则将 `package.json` patch version 从 `0.0.33` 递增到 `0.0.34`；vsce 提示缺少 LICENSE 文件，为非阻断警告。
