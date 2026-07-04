# ChipMate Codex Context Parity Development Plan

## 背景与目标

本文档基于 `chipmate-codex-context-parity-matrix.md`，把 ChipMate 的同一对话上下文管理能力拆成从 v0 到最终 parity 的开发路线。

这里的“100% 对齐”采用仓库内 parity matrix 的定义：对公开可见的 Codex 上下文行为实现用户体感和工程能力等价。最终状态必须稳定支持 persistent history transcript、token/window accounting、Codex-style compaction、replacement history、initial context reinjection、rollback、任务状态、工具/文件/验证/失败状态和用户可见 context summary。无法复制的 Codex 私有宿主机制必须明确标为 out-of-scope，并提供体感等价替代方案。

## 当前基线

ChipMate 当前已经具备这些上下文基础：

- 最近 raw history 与 session-local rolling summary。
- 本地文件、选择区、CodeGraph、Document RAG 和 analysis evidence。
- evidence ledger、tool history、visual evidence 和 goal runtime。
- 本地 JSONL session events 与部分跨 session durability。

当前主要缺口已经在矩阵中同步：没有 persistent model-visible transcript、没有 chat-side model context window 来源、没有最终 request-stage token gate、没有 Codex-style replacement-history compaction、没有 rollback/initial context reinjection 语义，也没有统一 `TaskState` / `FileState` / `VerificationState` / `FailureState` / `EvidenceState`。

## 当前未开发内容审计

基于当前源码和本文档要求，以下内容仍属于未开发或未落地状态。它们是后续开发的真实 backlog，而不是文档补充项：

| Area | 当前证据 | 未开发内容 | 首个落地阶段 |
| --- | --- | --- | --- |
| Chat context state | 源码中尚无 `ConversationContextState`、`HistoryTranscriptState`、`ContextWindowState`、`CompactionState`、`WorldStateBaseline`。 | 定义 versioned context state、只读聚合器、snapshot 测试和 migration guard。 | v1a |
| Persistent model-visible transcript | 当前发送链路仍由 system prompt、history messages 和 current user content 重建。 | 将 JSONL events、memory、evidence、tool、visual history 映射为内部 transcript item，并保留 rewrite/version 审计。 | v1a |
| Task / turn recap loop | 当前 goal runtime、最近历史和摘要分散存在。 | 每轮生成 `TurnRecap`，汇总 `TaskState`、用户纠偏、FailureState 和 next actions，并优先注入。 | v1b |
| Chat context window resolver | 当前只有 `chipmate.completion.contextLength`；chat provider 没有独立 input window 设置。 | 新增 `chipmate.provider.contextLength`，实现手动值、provider metadata、内置表、`262144` fallback 和用户可见提示。 | v2 |
| Request-stage token gate | 当前主要依赖 history/file/evidence bytes 和 turn 数局部限制。 | 在发送 provider 请求前按完整 `ContextPack` 做 token/window 级最终保护。 | v2 |
| ContextPack / budget report | 当前没有统一上下文分区和 included/truncated/omitted 报告。 | 按固定优先级组包，并输出可审计 budget report。 | v2 |
| Codex-style compaction | 当前 rolling summary 是 sidecar memory，不替换模型可见 transcript。 | 实现 auto/manual compact、replacement history、compact metadata、initial context reinjection。 | v2.5 |
| Transcript normalization | tool/evidence 多以文本摘要注入，缺少统一 call/output 和 modality 检查。 | 发送前保证 tool call/output 成对，处理 orphan output、超大输出、图片 fallback。 | v3 |
| File / verification / failure state | 文件读写、测试命令、失败原因不是一等状态。 | 建立 `FileState`、`VerificationState`、`FailureState`，防止未验证事实被当成 verified。 | v3 |
| Plan / resume / rollback | 计划、checkpoint、rollback 主要依赖普通历史或外部 runtime。 | `PlanState` 与 goal runtime 合流；rollback 清理 transcript、tool/file/state diff 并 full reinject。 | v4 |
| Evidence freshness / world baseline | evidence ledger 已有，但 freshness、索引状态和 world diff 联动不足。 | `EvidenceState` 与 `WorldStateBaseline` 支持 current/stale/unknown、diff inject、baseline invalidation。 | v5 |
| User-visible Context Summary | 当前用户难以检查模型实际带了哪些上下文和哪些被截断。 | 增加只读 Liquid Glass Context Summary UI，展示 budget、freshness、compact、fallback、rollback。 | v6 |
| Parity eval | 当前没有覆盖长 session、compact、rollback、resume、stale evidence 的统一验收集。 | 增加 parity eval fixtures、ContextPack snapshot、30+ 轮端到端模拟和最终矩阵回填。 | vFinal |

## Codex 参考锚点

后续开发以当前可见的公开 Codex 源码行为为参考，而不是臆测私有实现：

- `codex-rs/core/src/context_manager/history.rs`: `ContextManager` 维护 ordered `ResponseItem` history、`history_version`、token info、world state baseline，并在 `for_prompt()` 前做 history normalization。
- `codex-rs/core/src/session/context_window.rs`: `context_window_token_status()` 基于 active context tokens、auto compact scope、full context window 计算 `tokens_until_compaction` 和 `token_limit_reached`。
- `codex-rs/core/src/compact.rs`: compaction 生成 replacement history，保留近期 user messages 和 summary，并按场景决定是否 reinject initial context。
- `codex-rs/core/src/client.rs`: 每个 turn 创建新的 `ModelClientSession`，请求由 formatted input、instructions、tools、reasoning、prompt cache key 和 metadata 构成。

ChipMate 的 provider 当前主要是 Chat Completions 形态。因此实现时不要直接把 Codex `ResponseItem` 当作 wire shape；应实现内部 Codex-like transcript item union，再由 adapter 转成当前 `ChatMessage[]` 请求。未来如增加 Responses adapter，可复用内部 transcript。

## 核心数据结构

- `ConversationContextState`: 当前 session 的任务级上下文快照。
- `HistoryTranscriptState`: 按顺序保存模型可见 transcript item，支持版本号、rollback、normalization 和 replacement history。
- `ContextWindowState`: 当前 chat 模型窗口、估算输入 token、auto compact limit、tokens until compaction、是否达到 full window。
- `CompactionState`: compact 触发原因、summary、retained user messages、replacement history、window id、失败/回退状态。
- `WorldStateBaseline`: 当前 workspace/tool/settings/RAG/git/permission/model 状态 baseline，用于 diff inject、full reinject 和 rollback 后恢复。
- `TaskState`: 当前目标、范围、约束、完成状态、阻塞点和下一步。
- `PlanState`: 结构化步骤列表，包含 `pending`、`in_progress`、`completed`、`blocked`。
- `MemoryState`: durable summary、用户纠偏、open decisions、risks、next actions。
- `EvidenceState`: local context、CodeGraph、Document RAG、analysis、tool output、visual evidence 的统一索引。
- `FileState`: 已读、已改、已验证、stale 文件状态。
- `VerificationState`: 命令、测试、打包、验证结果及关键日志摘要。
- `FailureState`: blocker、失败原因、已尝试方案、retry rule 和 remaining risk。
- `TurnRecap`: 每轮结束后的结构化摘要。
- `ContextPack`: 最终注入模型的分区上下文和预算报告。

## 全局实现契约

这些契约贯穿所有版本，避免后续实现时重新做关键取舍：

- 所有 context state 必须 append-only 持久化，使用 versioned event 或 versioned snapshot；compact、rollback、migration 不能删除原始 JSONL 事件，只能新增可审计的 rewrite metadata。
- 内部 transcript 可以是 Codex-like item union，但 provider wire shape 继续由 adapter 转成现有 Chat Completions `ChatMessage[]`；不得把 Codex `ResponseItem` 直接暴露成 provider 请求格式。
- `ContextPack` 必须按固定优先级组包：latest user request、system/task rules、TaskState、high-priority corrections、FailureState、VerificationState、FileState、PlanState、EvidenceState、recent turns、compressed memory、low-priority historical evidence。
- request-stage token gate 是最终保护层；任何局部 bytes/turn 限制只能作为预裁剪，不能替代最终 token/window 判断。
- 截断必须写入 budget report，至少包含 section、included tokens/bytes、omitted tokens/bytes、reason、是否可恢复、是否建议 compact。
- 任何 state 被注入模型前都必须带 provenance：来自用户、工具、文件读取、测试命令、RAG/CodeGraph、visual artifact、summary、compact 或 migration。
- 用户纠偏、当前失败原因、未完成任务和未验证风险的优先级高于旧摘要、旧 evidence 和长历史。
- 对外可见提示必须区分 error、warning、degraded-but-safe、info；`262144` context fallback 属于 degraded-but-safe。
- 所有新增 UI 默认只读展示 context state；修改/编辑 context state 不属于首轮 parity 范围。

## Phase Gate 总览

| Phase | 主要交付 | 不可跳过的完成证据 |
| --- | --- | --- |
| v0 | Codex baseline、ChipMate baseline、matrix/plan 同步 | 只读 fixture 能描述当前 prompt assembly、session events、summary、tool/evidence/visual history 差异 |
| v1a | versioned context state 与只读聚合器 | 旧 session 可聚合出 stable snapshot，且不改变现有模型请求 |
| v1b | `TaskState`、`TurnRecap`、纠偏优先注入 | 20 轮任务模拟后能恢复目标、约束、失败点和下一步 |
| v2 | token/window resolver、`ContextPackBuilder`、request-stage token gate | 手动 context length、metadata、内置表、`262144` fallback 四条路径均有测试 |
| v2.5 | Codex-style compaction 与 replacement history | 超窗前能 compact；compact 后目标、近期意图、文件/测试/失败状态仍可恢复 |
| v3 | transcript normalization、文件/验证/失败闭环 | tool call/output 成对；未验证内容不会被说成 verified fact |
| v4 | plan/goal/resume/rollback 合流 | restart/resume 和 rollback/backtrack 都不会携带 stale state |
| v5 | evidence freshness 与 world state baseline | 文件、索引、git/workspace 状态变化后旧 evidence 自动降级或重注入 |
| v6 | 用户可见 Context Summary UI | 用户能看到 included/truncated/omitted、stale/current、compact、fallback 和 rollback 状态 |
| vFinal | parity eval 与最终矩阵回填 | 所有 in-scope capability 达到 Score 4；out-of-scope 私有机制有体感等价说明 |

## Capability 承接表

| Matrix Capability | Primary Phase | 说明 |
| --- | --- | --- |
| Persistent History Transcript | v1a | 建立 `HistoryTranscriptState` 与版本化 transcript item。 |
| History Normalization | v3 | 发送前规范化 tool call/output、视觉输入和无效 transcript item。 |
| Token / Window Accounting | v2 | `ContextWindowState` 统一 active tokens、remaining、compact threshold。 |
| Model Context Window Source | v2 | 手动配置、metadata、内置表、`262144` fallback 和提示。 |
| Request-Stage Budget Gate | v2 | 每次 provider 请求前执行最终 token/window gate。 |
| Codex-Style Compaction Trigger | v2.5 | auto/manual/mid-turn compact policy。 |
| Replacement History | v2.5 | compact 后替换模型可见 transcript。 |
| Initial Context Reinjection | v2.5 / v4 / v5 | compact、rollback、baseline invalidation 后重新注入 current world state。 |
| Rollback / Backtrack | v4 | 按 user turn 回退 transcript、state diff 和 stale baseline。 |
| Request Wire Adapter | v1a / v2 | 内部 transcript 到 Chat Completions 的 adapter。 |
| Recent Conversation Window | v2 | recent turns 成为 token budget 的一个分区。 |
| Rolling Summary / Memory | v2.5 | rolling summary 保留为 `MemoryState`，不冒充 replacement history。 |
| Task State Tracking | v1b | `TaskState` 高优先级注入。 |
| Plan / Checklist Persistence | v4 | `PlanState` 与 goal runtime 合流。 |
| User Correction Priority | v1b / v2 | 用户纠偏进入 high-priority context section。 |
| Evidence Ledger / EvidenceState | v5 | evidence 统一索引、排序、freshness 和预算。 |
| Tool Execution Memory | v3 | tool result 更新 transcript、evidence、verification 和 failure state。 |
| Shell / Test Result Carryover | v3 | `VerificationState` 记录命令、退出码和验证范围。 |
| File Read / Write State | v3 | `FileState` 区分 read/write/verified/stale。 |
| Git / Diff Awareness | v5 | 纳入 `WorldStateBaseline` 和 diff inject。 |
| RAG / CodeGraph Freshness | v5 | 索引或文件变化时降级 stale evidence。 |
| Visual Evidence Carryover | v3 / v5 | modality fallback 与长期 visual evidence index。 |
| Context Budgeting | v2 | `ContextPackBuilder` 与 budget report。 |
| Interruption / Resume Recovery | v4 | checkpoint、resume prompt、failure recovery。 |
| Goal Continuation | v4 | goal runtime 映射到 `TaskState.goal`。 |
| User-Visible Context Summary | v6 | Liquid Glass 只读 Context Summary UI。 |
| Failure / Blocker Memory | v1b / v3 | `FailureState` 从 TurnRecap 和工具失败持续更新。 |
| Cross-Session Durability | v1a / v4 | versioned state、migration、checkpoint 和 compact metadata。 |
| Compaction Telemetry / Warning | v2.5 / v6 | compact metadata、warning 和 UI 可见状态。 |
| Private Mechanism Boundary | vFinal | 所有无法复制的私有机制标注 out-of-scope 和体感替代。 |

## v0: Codex-Backed Baseline Audit

目标：先把 Codex 对齐目标固定成可测试的公开行为，并确保矩阵与计划一致。

关键改动：

- 固定 Codex 上下文基线：persistent history chain、history normalization、token/window accounting、auto/manual compaction、replacement history、initial context reinjection、rollback、per-turn client session boundary。
- 固定 ChipMate 当前 baseline：`systemPrompt + historyMessages + current user content`，其中 historyMessages 来源于 rolling summary、evidence/tool history 和 recent raw turns。
- 更新 parity matrix，使其包含计划中的所有核心能力：`HistoryTranscriptState`、`ContextWindowState`、`CompactionState`、`WorldStateBaseline`、request adapter、rollback、model context window source。
- 建立只读 baseline fixtures，锁定当前 prompt assembly 和 session event shape，作为后续迁移防回归依据。

验收标准：

- 矩阵和计划的 capability / phase 一一对应，不再出现计划有能力项、矩阵无验收项。
- 开发计划不再把 rolling summary 当作 Codex compaction 等价物。
- 能用测试矩阵说明 Codex 与 ChipMate 在同一 session history、summary、compact、tool output、visual input、rollback 上的差异。

## v1a: State Types And Read-Only Aggregation

目标：先建立状态类型和只读聚合，不改变模型请求内容。

关键改动：

- 新增 `ConversationContextState`、`HistoryTranscriptState`、`ContextWindowState`、`TaskState`、`MemoryState`、`EvidenceState`、`FileState`、`VerificationState`、`FailureState`、`TurnRecap` 类型。
- 新增 `ConversationContextManager`，从现有 JSONL session events、conversation memory、evidence ledger、tool history、visual evidence 和 goal runtime 聚合状态。
- 将现有 `message`、`memory`、`evidence`、`visual_evidence` events 只读映射为初版 transcript items。
- 新增 state version 和 migration guard；没有 context state 的旧 session 必须 fallback 到当前逻辑。

验收标准：

- 不改变现有 prompt 和 UI 行为。
- 旧 session 可读取；损坏或未知 event 不阻断聊天。
- 测试能从一段现有 session events 聚合出稳定 state snapshot。

## v1b: TaskState And TurnRecap Injection

目标：建立最小任务级上下文闭环，仍保持现有 history/memory/evidence 发送方式。

关键改动：

- 每轮 assistant 完成、失败、abort 或 tool failure 后生成 `TurnRecap`。
- 从 `TurnRecap` 汇总 `TaskState`、用户纠偏、FailureState 初版和 next actions。
- `ContextPackBuilder` 初版接入发送链路，将 `TaskState` 和 high-priority corrections 放在 rolling summary、recent turns 之前。
- goal runtime 不重写，只映射进 `TaskState.goal`。

验收标准：

- 20 轮长对话后，ChipMate 能回答当前目标、已完成事项、未完成事项、关键约束、失败点和下一步。
- `TaskState` 在下一轮模型请求中稳定出现在旧摘要和 ordinary recent turns 之前。

## v2: Token-Window Context Packing

目标：把上下文从按 turn/bytes 裁剪升级为 token/window 驱动的分层预算。

关键改动：

- 新增 chat 模型 context window 来源优先级：
  1. `chipmate.provider.contextLength > 0` 时直接使用用户手动值。
  2. `chipmate.provider.contextLength` 为 `0` 或未设置时，读取 provider `/models` metadata 中的只读窗口信息。
  3. `/models` 不可用或缺少窗口信息时，查询内置公开模型窗口表。
  4. 仍取不到时 fallback 到 `262144` tokens，标记 `source=fallback_default`，并保留 safety margin。
- 新增 VS Code setting：`chipmate.provider.contextLength`，默认值为 `0` 表示 auto-detect；用户输入正整数时覆盖自动探测结果。
- 明确 `chipmate.provider.maxTokens` 是输出 token cap，不得作为 input context window。
- `ContextWindowState` 计算 active estimated tokens、model context window、auto compact limit、tokens until compaction、full context reached。
- `ContextPackBuilder` 输出固定分区：latest user request、system/task rules、TaskState、corrections、PlanState、FailureState、VerificationState、FileState、EvidenceState、recent turns、compressed memory。
- 新增 `ContextPackBudgetReport`，记录每个分区的 included tokens/bytes、omitted tokens/bytes、truncated 和 reason。
- 当最终使用 `262144` fallback 时，`ContextWindowState` / budget report 必须记录原因，并在 UI Context Summary 和日志中提示：未能从模型元数据获取上下文长度，当前使用默认 `262144` tokens；可在设置中手动调整 `chipmate.provider.contextLength`。该状态是 degraded-but-safe，不作为错误阻断请求。
- 最终请求发送前必须执行 request-stage token budgeter/pruner；局部 byte limit 不能替代最终 gate。

验收标准：

- 超预算会话中，最新纠偏、当前任务、失败原因和验证结果不会被旧摘要挤掉。
- `chipmate.provider.contextLength=131072` 时，`ContextWindowState.modelContextWindow` 使用 `131072`，且不显示 fallback 提示。
- `chipmate.provider.contextLength=0` 且 `/models` 返回有效窗口时，使用 provider metadata，且不显示 fallback 提示。
- `chipmate.provider.contextLength=0`、`/models` 无窗口、内置表命中时，使用内置表，且不显示 fallback 默认提示。
- `chipmate.provider.contextLength=0`、所有来源都不可用时，fallback 为 `262144`，标记 `source=fallback_default`，并显示“取不到所以使用默认值”的提示。
- `provider.maxTokens` 不影响 input context window。
- 当估算 token 接近模型窗口时，系统能触发 compact 或安全裁剪，而不是直接请求失败。
- 每轮日志能输出 context pack 分区、token window 状态和截断原因。

## v2.5: Codex-Style Compaction

目标：把 ChipMate rolling memory 从“聊天摘要 sidecar”升级为可替换 transcript 的 Codex-style compact。

关键改动：

- 新增 compaction policy：
  - pre-turn 达到硬阈值：inline compact，成功后再发当前请求。
  - 普通软阈值：后台预压缩，不阻塞当前低风险请求。
  - manual compact：用户或内部命令显式触发。
  - mid-turn/tool-loop context pressure：允许 compact 并 reinject initial context 到模型预期边界。
  - compact 失败：安全裁剪、提示用户、或建议新 session，不能静默丢关键状态。
- compact 输入使用 `HistoryTranscriptState + ContextPack`，输出 `CompactionState`：summary、retained recent user messages、replacement history、preserved state refs、window metadata。
- compact 后用 replacement history 替换模型可见 transcript，并保留原始 JSONL events 作为审计日志。
- 区分 pre-turn/manual compact 与 mid-turn compact：
  - pre-turn/manual compact 后下一轮 full reinject initial context。
  - mid-turn compact 需要把 initial context 插入到最后真实 user message 或 summary 前。

验收标准：

- 长 session 超过窗口前能自动 compact 并继续同一任务。
- compact 后仍能恢复目标、近期用户意图、关键证据、文件状态、测试结果和失败点。
- replacement history 不是普通 assistant memory message，且不会被误当成用户新指令。

## v3: Transcript Normalization And Engineering State Loop

目标：补齐工具、文件、命令、测试和失败闭环，并保证 transcript 模型可见部分一致。

关键改动：

- transcript normalization：tool call 必须有 output；orphan output 不进入模型可见 transcript；超大 output 按策略截断并保留摘要。
- visual/tool image output 按模型 modality 处理：不支持图片时替换为文本占位或 artifact 摘要。
- `FileState` 记录路径、read/write/verified/stale、来源、last turn、摘要和 stale reason。
- `VerificationState` 记录命令、cwd、退出码、关键输出、验证范围、失败原因和时间。
- `FailureState` 记录 blocker、attempted fixes、remaining risk 和 retry rule。
- 工具调用结果、shell/test 输出、RAG/CodeGraph evidence 更新后同步进入对应 state。

验收标准：

- 测试失败后，下一轮无需用户重复日志，ChipMate 能引用失败命令、失败原因和下一步修复方向。
- 文件被读取、修改或验证后，下一轮能说明哪些文件已读、已改、哪些尚未验证。
- 不允许把未读文件或未执行测试表述为 verified fact。

## v4: Plan / Goal / Resume / Rollback Parity

目标：让 goal runtime、计划状态、checkpoint、resume 和 rollback 合流。

关键改动：

- `PlanState` 记录步骤 ID、标题、状态、证据引用和更新时间。
- 每轮开始恢复 active goal、PlanState、last checkpoint、FailureState。
- 每轮结束写入 checkpoint，包含当前步骤、下一步和恢复说明。
- abort、provider failure、tool failure、usage limit 都必须更新 checkpoint 或 FailureState。
- goal continuation prompt 使用 `TaskState + PlanState + FailureState + VerificationState`，不只依赖普通历史。
- rollback/backtrack 按 user turn 回退 `HistoryTranscriptState`，清理紧邻 contextual initial-context updates、tool call/output、文件状态更新和 stale baseline，下一轮 full reinject current world state。

验收标准：

- 中断或重启 VS Code 后恢复同一 session，ChipMate 能继续原任务，并知道上次停在哪一步。
- 回退最近 N 个 user turns 后，后续请求不会继续携带已回退的工具输出、文件状态更新或 stale initial context。

## v5: Evidence Freshness And World State

目标：让 evidence 从“历史文本”升级为可排序、可追踪、可失效的上下文资产，并实现 world state diff/reinject。

关键改动：

- `EvidenceState` 统一接入 local context、CodeGraph、Document RAG、analysis evidence、visual evidence 和 tool output。
- 每条 evidence 包含 source、path/range、query、summary、freshness、confidence、turnID、hash。
- 当前轮 evidence 优先于旧 evidence；旧 evidence 默认 stale 或 unknown，除非 hash/index 状态证明仍有效。
- RAG/CodeGraph 状态变化时更新 evidence freshness，避免旧索引证据被当作当前事实。
- `WorldStateBaseline` 覆盖 workspace/tool/settings/RAG/git/permission/model 状态，按 diff 注入模型可见上下文；baseline 丢失、compact 或 rollback 后 full reinject。
- `VisualEvidenceState` 记录 artifact、page、sourceHash、coverage、可复用范围和 modality fallback 文本。

验收标准：

- 文件或索引状态变化后，ChipMate 不会把旧 evidence 说成当前事实。
- 工作区状态变化后，下一轮上下文只注入必要 diff；baseline 不可信时强制全量重新注入。

## v6: User-Visible Context UI

目标：给用户一个可检查的上下文状态面板。

关键改动：

- 在聊天 UI 增加 Context Summary 入口，默认遵循 iOS 26 Liquid Glass 风格。
- 展示 TaskState、PlanState、FileState、VerificationState、EvidenceState、FailureState、ContextWindowState、CompactionState 和 budget report。
- 展示 included/truncated/omitted、stale/unknown/current、compact warning、rollback marker。
- 首版只读，不提供复杂编辑能力。
- 图标与工具栏使用正常文档流布局，使用 flex/grid/inline-flex，不用 `position: absolute` 做图标对齐。

验收标准：

- 用户能看到 ChipMate 当前记住了什么、哪些证据被使用、哪些内容被截断、是否 compact、哪些风险未验证。
- 窄宽度下 UI 不重叠、不遮挡、不溢出。

## vFinal: 100% Parity Gate

目标：按 parity matrix 完成最终验收。

最终状态：

- 所有 in-scope capability 达到 Score 4。
- `Private Mechanism Boundary` 完成审计：无法复制的 Codex 私有宿主机制必须明确标为 out-of-scope，并提供用户体感等价替代方案。
- 矩阵和计划中的 capability、phase、验收项完全同步。

关键改动：

- 增加 parity eval fixtures，覆盖 persistent history、token-window trigger、replacement history、rollback、initial context reinjection、tool output normalization、长任务、用户纠偏、测试失败、文件修改、RAG stale、视觉证据、跨 session resume。
- 增加 ContextPack snapshot 测试，固定关键分区顺序、优先级和截断策略。
- 增加 30+ 轮端到端模拟任务，验证不丢目标、约束、失败原因、文件状态、证据和下一步。
- 更新 `chipmate-codex-context-parity-matrix.md`，写入最终评分、剩余差异和 out-of-scope。

验收标准：

- 用户体感上，ChipMate 能像 Codex 一样在长任务和 compact 后保持任务连续性。
- 工程能力上，ChipMate 能稳定恢复目标、计划、上下文证据、文件状态、验证状态、失败状态、transcript 和 world state。
- 所有相关测试、lint、compile、package 验证通过。

## 推荐实现顺序

1. Codex-backed baseline audit 与矩阵同步。
2. `ConversationContextState` 类型与版本化事件。
3. `HistoryTranscriptState` 与旧 session events 只读映射。
4. `TurnRecap`、`TaskState` 和 high-priority corrections 注入。
5. chat context window 来源、`ContextWindowState` 和 request-stage token gate。
6. `ContextPackBuilder` 分层预算和 budget report。
7. Codex-style auto/manual compact、replacement history 和 compact metadata。
8. transcript normalization、visual modality fallback、tool output pruning。
9. `FileState`、`VerificationState`、`FailureState`。
10. `PlanState` 与 goal runtime 合流。
11. rollback/backtrack 与 initial context reinjection。
12. `EvidenceState` freshness、`WorldStateBaseline` 和 visual evidence 扩展。
13. Context Summary UI。
14. parity eval fixtures 与最终矩阵更新。

## 建议 PR / 交付拆分

为降低风险，后续实现不要把所有阶段塞进一个大改动。推荐按下面批次交付，每批都必须保持现有聊天主路径可回退：

| Batch | 覆盖阶段 | 交付边界 | 风险控制 |
| --- | --- | --- | --- |
| A | v0 + v1a | 只读 baseline fixtures、context state 类型、聚合器、snapshot 测试 | 不改变 provider 请求、不改变 UI 主流程 |
| B | v1b | `TurnRecap`、`TaskState`、纠偏优先注入 | 只注入小体积高优先级摘要，保留旧 history/memory 逻辑 |
| C | v2 | context window resolver、`ContextPackBuilder`、request-stage token gate | 先 shadow 输出 budget report，再启用裁剪/compact trigger |
| D | v2.5 | auto/manual compact、replacement history、compact telemetry | compact 失败必须 fallback 到安全裁剪或提示新 session |
| E | v3 | transcript normalization、File/Verification/Failure state | 不把未验证结果升级为 verified；tool output 截断必须可审计 |
| F | v4 | Plan/Goal/Resume/Rollback 合流 | rollback 后强制 baseline invalidation 和 full reinject |
| G | v5 | Evidence freshness、WorldStateBaseline、visual evidence index | stale evidence 默认降级，不自动当作 current fact |
| H | v6 + vFinal | Context Summary UI、parity eval、最终矩阵回填 | UI 首版只读；最终才回填 Score 4 / out-of-scope |

## 下一批开发任务细化

当前详细任务表已推进到 Batch H；A-H 详细任务均已完成。

| Task ID | Batch | 开发任务 | 完成证据 |
| --- | --- | --- | --- |
| ✅ A1 | A | 新增 baseline fixture，捕获当前 prompt assembly：system prompt、rolling summary、evidence/tool history、recent raw turns、current user content。 | snapshot 测试证明未接入新 state 前请求内容不变。 |
| ✅ A2 | A | 定义 versioned context state 类型和最小 schema：session id、state version、source event id、turn id、provenance、created/updated time。 | 类型测试覆盖未知 version、缺字段、损坏 event 的 fallback。 |
| ✅ A3 | A | 实现只读 `ConversationContextManager`，从现有 JSONL events、memory、evidence、tool history、visual evidence、goal runtime 聚合 state。 | 旧 session fixture 可生成 stable state snapshot，且不影响聊天发送链路。 |
| ✅ A4 | A | 实现内部 transcript adapter 的只读映射层，不改变 provider wire request。 | transcript snapshot 能解释每个 item 来自哪个原始 event 或 sidecar。 |
| ✅ B1 | B | 在 assistant 完成、失败、abort、tool failure 后生成 `TurnRecap`。 | fixture 覆盖成功轮、失败轮、工具失败轮和用户纠偏轮。 |
| ✅ B2 | B | 从 `TurnRecap` 聚合 `TaskState`、high-priority corrections、FailureState 初版和 next actions。 | 20 轮模拟后 `TaskState` 可回答当前目标、已做、未做、失败点和下一步。 |
| ✅ B3 | B | 将 `TaskState` 与 corrections 作为小体积高优先级 context section 注入旧发送链路前部。 | 请求 snapshot 证明其位于 rolling summary 和 ordinary recent turns 之前。 |
| ✅ C1 | C | 新增 `chipmate.provider.contextLength` 设置，默认 `0` auto-detect，正整数为手动 input context window。 | 配置测试证明它独立于 `provider.maxTokens` 和 `completion.contextLength`。 |
| ✅ C2 | C | 实现 chat context window resolver：manual、provider metadata、builtin table、`262144` fallback。 | 四条 resolution path 均有单测；fallback 记录 `source=fallback_default`。 |
| ✅ C3 | C | 实现 `ContextPackBuilder` shadow mode，输出 sections 和 `ContextPackBudgetReport`，但先不改变裁剪策略。 | 日志和 snapshot 可看到 included/truncated/omitted、reason 和 estimated tokens。 |
| ✅ C4 | C | 启用 request-stage token gate，在超窗时优先裁剪低优先级 section，必要时触发 compact candidate。 | 超预算 fixture 证明 latest request、TaskState、corrections、FailureState、VerificationState 被保留。 |
| ✅ C5 | C | 将 `262144` fallback 提示接入日志和未来 Context Summary 数据源。 | fallback 场景可看到“无法获取模型上下文长度，使用默认 262144 tokens”的 degraded-but-safe 提示。 |
| ✅ D1 | D | 实现 compaction policy scaffold：基于 token ratio、request-stage truncation、manual/mid-turn trigger 生成 compact candidate。 | 单测覆盖 soft threshold、hard/truncated trigger 和不触发路径。 |
| ✅ D2 | D | 实现 replacement history scaffold：保留最近 user messages，并生成 `compaction_summary` item，明确不是普通 assistant memory message。 | replacement history snapshot 覆盖 retained user、summary、provenance 和 window metadata。 |
| ✅ D3 | D | 将 compact candidate 接入 request-stage token gate 的 telemetry，不立即替换真实 transcript。 | 超窗请求路径日志包含 compact id、trigger、before/after tokens、retained/omitted、reinject mode。 |
| ✅ D4 | D | 建立 compact metadata 的失败/降级语义：truncated 后标记 `fallback_pruned`，soft threshold 标记 `candidate`。 | 单测证明 compact 失败前不会静默丢关键状态，后续可安全接模型摘要。 |
| ✅ E1 | E | 实现 transcript normalization scaffold：记录 omitted item、orphan tool output、large tool output 和 visual modality fallback。 | normalization snapshot 覆盖 orphan output、无效/省略 transcript item、图片 fallback 诊断，且不进入模型可见 transcript。 |
| ✅ E2 | E | 实现 `FileState` 初版：从 evidence、visual artifact 和工具输入/输出提取文件路径，区分 read/write/stale。 | 单测证明文件路径、来源、状态、摘要和 provenance 可恢复；未验证文件不会被标成 verified。 |
| ✅ E3 | E | 实现 `VerificationState` 初版：从 shell/test/verify 工具状态记录 command、cwd、exit code、summary 和 pass/fail/abort。 | 单测覆盖失败命令 carryover，`provider.maxTokens` 等非验证配置不会影响 verification state。 |
| ✅ E4 | E | 实现 `FailureState` 初版：从 failed TurnRecap 和 failed VerificationState 聚合 blocker、remaining risk 和 retry rule。 | 下一轮 context 可看到最近失败原因，且失败验证不会被表述为已通过。 |
| ✅ E5 | E | 将 File/Verification/Failure state 接入高优先级 task context 摘要。 | `renderTaskStateContext` snapshot 包含 FileState、VerificationState、FailureState，位于 ordinary recent turns 之前。 |
| ✅ F1 | F | 新增 `PlanState` scaffold：支持显式 plan snapshot，并可从 goal runtime 与 TurnRecap next actions 派生 active step。 | 单测证明 active step、step status、evidenceRefs 和 provenance 可恢复。 |
| ✅ F2 | F | 新增 `CheckpointState` 与 `ResumeState` scaffold：每轮可从 checkpoint 或最新 task state 生成恢复说明。 | 单测证明 checkpoint resume instructions、next action 和 active plan step 会进入恢复状态。 |
| ✅ F3 | F | 新增 rollback marker scaffold：原始事件 append-only 保留，派生 transcript 将 rolled-back message 标记为 omitted。 | 单测证明被回退 message 不再作为 model-visible transcript item。 |
| ✅ F4 | F | rollback 后清理同 turn 的 File/Verification/Failure 派生状态，并强制标记 full initial context reinjection。 | 单测证明 rollback 后不会携带已回退文件写入、验证结果和失败状态。 |
| ✅ F5 | F | 将 Plan/Resume/Rollback state 接入高优先级 task context 摘要。 | `renderTaskStateContext` snapshot 包含 PlanState、ResumeState、RollbackState。 |
| ✅ G1 | G | 实现 `EvidenceState` freshness scaffold：按 evidence staleness、路径、turn、hash/index 状态区分 current/stale/unknown。 | stale evidence 不会被渲染为 current fact，snapshot 覆盖 current/stale/unknown。 |
| ✅ G2 | G | 新增 `WorldStateBaseline` scaffold：记录 workspace/tool/settings/RAG/git/model baseline 和 diff inject 需求。 | 单测证明 baseline 丢失、变化或 rollback 后会要求 full reinject。 |
| ✅ G3 | G | 扩展 `VisualEvidenceState`：记录 artifact、sourceHash、coverage、modality fallback 文本和 stale 语义。 | 单测证明视觉证据能 carry over，但在不支持图片模型时只注入文本摘要。 |
| ✅ G4 | G | 将 freshness、WorldStateBaseline 和 visual evidence index 接入 ContextPack/TaskState 摘要。 | budget/state snapshot 可看到 stale/current、baseline diff 和 visual fallback 状态。 |
| ✅ H1 | H | 新增只读 Context Summary 数据模型，聚合 Task/Plan/File/Verification/Evidence/Failure/Window/Compact/Rollback。 | 单测或 snapshot 覆盖 included/truncated/omitted、fallback、compact、rollback 字段。 |
| ✅ H2 | H | 实现 Liquid Glass Context Summary UI 首版，只读展示上下文状态。 | webview source snapshot 证明 UI 入口、fallback、compact、rollback summary 均存在且使用正常文档流状态行。 |
| ✅ H3 | H | 增加 parity eval fixtures：长 session、compact、rollback、resume、测试失败、文件变更、RAG stale、视觉 fallback。 | 30+ 轮模拟和 ContextPack snapshot 覆盖最终 parity 场景。 |
| ✅ H4 | H | 回填 parity matrix 最终评分、证据和 private mechanism out-of-scope 边界。 | 所有 in-scope capability 达到 Score 4 或明确剩余差异与替代方案。 |

## 观测与证据包

每个批次完成时，必须产出可以回看和复现的证据包，而不是只给“已实现”结论：

- Context pack snapshot：记录每个 section 的 included/truncated/omitted、token/byte 估算、优先级和截断原因。
- Context window resolution record：记录 `configured`、`provider_metadata`、`builtin_table`、`fallback_default` 中实际命中的 source；fallback 到 `262144` 时必须包含用户可见提示文本。
- Compaction record：记录 trigger、before/after tokens、retained messages、replacement history id、summary id、initial context reinjection mode、失败 fallback。
- State snapshot：记录 `TaskState`、`PlanState`、`FileState`、`VerificationState`、`FailureState`、`EvidenceState`、`WorldStateBaseline` 的 version 和来源。
- Resume / rollback record：记录 checkpoint id、恢复来源、被回退 user turns、清理的 tool/file/state diff、下一轮是否 full reinject。
- UI evidence：v6 起提供 Context Summary 的桌面与窄宽度截图，证明 included/truncated/stale/compact/fallback/rollback 状态可见且不重叠。
- Private leak check：每批结束前扫描计划、测试 fixture、日志样例和文档，确认没有私有 provider endpoint、私有模型名或 VSIX 注入默认值。

## 最终 Definition Of Done

只有同时满足下面条件，才能把本路线图视为完成：

- parity matrix 每个 in-scope capability 都有对应实现、测试、证据包和最终评分；不能用“未发现问题”替代逐项证明。
- 同一长 session 在普通继续、超窗 compact、中断恢复、rollback、测试失败、文件变更、RAG stale、视觉证据 fallback 场景下都能保持任务连续性。
- context window 解析覆盖手动值、provider metadata、内置表和 `262144` fallback；fallback 提示用户可见且不阻断请求。
- 所有模型可见上下文都来自 `ContextPack` 或 transcript adapter，且有 budget report 可解释为什么包含、截断或省略。
- compact 产生 replacement history，而不是只追加一条普通 assistant summary。
- rollback/backtrack 后不会继续携带已回退工具输出、文件状态、verification、failure 或 initial context diff。
- Context Summary UI 能解释当前记住什么、哪些证据过期、哪些内容被截断、是否使用 fallback、是否发生 compact/rollback。
- `bun test`、`bun run lint`、`bun run compile` 和 `bun run package` 通过；最终交付报告列出未覆盖风险和 out-of-scope 私有机制。

## 完成度标尺

后续汇报进度时统一使用下面状态，避免把“计划已写”误报成“功能已完成”：

| Status | 含义 | 可接受证据 |
| --- | --- | --- |
| Planned | 文档已有目标、接口边界和验收要求。 | 本计划或 matrix 中有明确条目。 |
| Scaffolded | 类型、配置或空实现已接入，但不影响生产路径。 | 编译通过，snapshot 证明旧路径不变。 |
| Shadowed | 新逻辑已运行并产生日志/报告，但不改变模型请求结果。 | shadow report、snapshot 和旧行为对比。 |
| Active | 新逻辑已参与真实请求组包、裁剪、恢复或 UI 展示。 | 行为测试、集成测试和真实请求日志。 |
| Verified | 覆盖正常、降级、失败和迁移场景。 | 单测、集成测试、fixture、UI 截图或命令验证。 |
| Parity | matrix 对应 capability 达到 Score 4。 | 最终 parity eval 通过，矩阵回填评分和证据链接。 |

## 兼容性与迁移

- 所有新增 state 必须版本化。
- 没有 context state 的旧 session 必须 fallback 到当前 history/memory/evidence 逻辑。
- 旧 conversation memory 不删除，先作为 `MemoryState` 输入源。
- 旧 rolling summary 不直接等同于 Codex compaction；只有 replacement history 接入后才视为 compact parity。
- goal runtime 不重写，只映射进 `TaskState.goal`。
- evidence ledger 不重写，先作为 `EvidenceState` 输入源。
- 配置项默认保持现状；新增 `chipmate.provider.contextLength` 默认 `0` 表示自动探测，正整数表示用户手动 input context window；所有来源都取不到时 fallback 到 `262144` tokens，并给用户可见提示，避免破坏现有用户设置。
- 对历史事件新增版本迁移器，确保 compact/rollback 后仍能从原始 JSONL 审计完整过程。

## 测试与验证总表

每个阶段完成后至少运行：

- `bun test` 覆盖新增/修改行为。
- `bun run lint` 检查代码风格。
- `bun run compile` 做快速编译验证。
- 最终交付前运行 `bun run package`。

最终 parity 验收额外要求：

- persistent transcript snapshot。
- token-window compaction 模拟。
- manual compact 模拟。
- replacement history snapshot。
- rollback/backtrack 模拟。
- initial context reinjection。
- chat context window 手动配置、metadata 读取、内置表命中、`262144` fallback 和 fallback 提示。
- tool call/output normalization。
- visual modality fallback。
- 30+ 轮长任务模拟。
- 中断恢复模拟。
- 失败测试 carryover。
- 文件 read/write/verified 状态一致性。
- RAG/CodeGraph stale evidence 降级。
- Context Summary UI 窄宽度检查。

## 风险与约束

- 不要一次性重写聊天链路；每个版本必须有可回退路径。
- 不要把 prompt tweaking 当作主要方案；核心是结构化 state、transcript、token/window budget 和 compaction。
- 不要把 rolling summary 误认为 Codex-style compaction；compaction 必须产生 replacement history 或等价结构。
- 不要直接照搬 Codex `ResponseItem` wire shape；ChipMate 需要内部 transcript adapter 到现有 Chat Completions provider。
- 不要只按 byte 预算；最终请求必须有 token/window 级保护。
- 不要把 `provider.maxTokens` 当 input context window。
- 不要在最终 fallback 到 `262144` 时静默处理；必须提示这是因为无法获取模型上下文长度而使用的默认值。
- 不要把未验证信息写成 verified fact。
- 不要把旧 evidence 当作 current evidence。
- 不要让 rollback 后的上下文继续携带已回退的工具输出、文件状态或 initial context diff。
- 不要把 `Private Mechanism Boundary` 之外的私有宿主细节列为 ChipMate 必须实现的工程项。
- 不要写入任何私有 provider endpoint、私有模型名或 VSIX 注入默认值。
- UI 相关实现必须遵循 iOS 26 Liquid Glass 风格和图标布局规则。

## 交付物

- 同步后的 matrix 与 development plan。
- `ConversationContextManager` 与相关 state 类型。
- `HistoryTranscriptState`、`ContextWindowState`、`CompactionState` 和 `WorldStateBaseline`。
- chat context window resolver 与 request-stage token gate。
- `ContextPackBuilder` 与 budget report。
- `TurnRecap`、task checkpoint、replacement history 和 compact metadata 持久化。
- transcript normalization、rollback/backtrack 与 initial context reinjection。
- 文件、验证、失败、计划和证据状态闭环。
- Context Summary UI。
- parity eval fixtures 和最终矩阵更新。
