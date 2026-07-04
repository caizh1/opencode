# ChipMate Codex Context Management Parity Matrix

## 背景

本文档用于审计 ChipMate 在“同一对话中的上下文管理”上与 Codex 的差距，并作为后续实现路线图。

这里的 parity 目标是“用户体感和工程能力接近 Codex”：长任务不轻易丢目标、不遗忘关键约束、能延续已做/未做状态、能复用工具和证据结果、能在中断或压缩后继续推进。本文档不声称、也不要求复制 Codex 的私有宿主运行时、服务端 sticky routing 或隐藏策略。

## Codex 参考基线

本矩阵以当前可见的公开 `openai/codex` 源码行为为参考，而不是以固定 turn 数或普通聊天摘要为参考：

- `codex-rs/core/src/context_manager/history.rs`: `ContextManager` 维护 ordered `ResponseItem` history、`history_version`、token info、world state baseline，并在 `for_prompt()` 前 normalization。
- `codex-rs/core/src/session/context_window.rs`: `context_window_token_status()` 基于 active context tokens、auto compact scope、full context window 计算 `tokens_until_compaction` 和 `token_limit_reached`。
- `codex-rs/core/src/compact.rs`: compaction 生成 replacement history，保留近期 user messages 和 summary，并按场景决定是否 reinject initial context。
- `codex-rs/core/src/client.rs`: 每个 turn 创建新的 `ModelClientSession`，请求由 formatted input、instructions、tools、reasoning、prompt cache key 和 metadata 构成。

ChipMate 不需要直接复制 Codex `ResponseItem` wire shape。目标是在 VS Code 扩展内实现等价的内部 transcript、token/window budgeting、replacement-history compaction、state recovery 和用户可见性，再适配到现有 Chat Completions 请求。

## 评分标准

| Score | 含义 |
| --- | --- |
| 0 | 不存在 |
| 1 | 仅基础支持 |
| 2 | 可用但粗粒度 |
| 3 | 接近 Codex 体感 |
| 4 | 基本 parity |

## Parity Matrix

| Capability | Codex Baseline | ChipMate Current | Score | Gap | Target State | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Persistent History Transcript | 持续追加 ordered `ResponseItem` thread history，并用 `history_version` 标记 rewrite。 | 使用 JSONL session events 保存 message/memory/evidence/visual evidence；已有 `HistoryTranscriptState` scaffold、compact rewrite metadata、model-generated completed compact event、completed-event adapter、E2 current-turn inline re-pack 和 F3 compact-aware restart fixture。 | 2 | 仍缺少 fully authoritative model-visible transcript；general restart eval、rollback/stale evidence 联动和 UI replay 未完成。 | 新增 `HistoryTranscriptState`，从旧 events 映射为模型可见 transcript item，支持版本号、rewrite 和审计。 | P0 |
| History Normalization | 发送前保证 tool call/output 成对，移除 orphan output，并按模型 modality 去除不支持图片。 | compacted transcript adapter 已有 normalization snapshot，可跳过重复 summary/item、orphan tool output、unsupported modality，并把 system role 转为 provider-safe continuity context；通用 tool-loop normalization 仍缺。 | 2 | compacted history path 已有基础，但工具循环、视觉输入和普通 raw transcript 尚未统一一致性检查。 | 新增 transcript normalization，保证 call/output 配对、输出截断、图片 fallback 和无效项移除。 | P0 |
| Token / Window Accounting | 使用 active context tokens、auto compact scope、full context window 计算 compact 压力。 | 已有 chat input window resolver、request-stage budget report 和 E1 `ContextWindowState`，可记录 active/prefill/body/scope tokens、threshold、tokens until compaction、hard limit 和 request-stage truncation。 | 3 | 尚未持久化为独立 pressure event，scope / prefill 分类仍比 Codex 粗。 | 新增 `ContextWindowState`，按 chat 模型窗口估算 tokens、remaining 和 compact threshold。 | P0 |
| Model Context Window Source | Codex 由 model info/config 提供 context window 和 auto compact limit。 | 已支持用户手动 `chipmate.provider.contextLength`、provider metadata、内置公开模型表，以及无法获取时 `262144` fallback 和用户可见提示。 | 3 | provider `/models` 能否返回真实窗口取决于外部 provider；auto compact limit 仍用本地阈值而非 provider-specific metadata。 | 定义来源优先级：用户手动 `chipmate.provider.contextLength`、provider `/models` metadata、内置公开模型表；仍取不到时 fallback 到 `262144` tokens、标记 `source=fallback_default`、保留 safety margin，并给出用户可见提示。 | P0 |
| Request-Stage Budget Gate | 每次发送前按完整请求窗口做最终保护。 | 已有 `ContextPackBudgetReport`、request-stage token gate 和 `[context-window-state]` pressure log；可在最终发送前 prune 低优先级 message、驱动 compact candidate，并在 completed compact 后重新组本轮请求；E3 已让初始 request-stage truncation 先触发 compact，compact 未完成时才安装 pruned messages。 | 3 | hard prune 仍是降级路径；fallback reason 的 UI persisted replay 还需完善。 | `ContextPackBuilder` 最后执行 request-stage token budget/prune，必要时触发 compact。 | P0 |
| Codex-Style Compaction Trigger | 由 token/window pressure 或 manual compact 触发，不按固定 turn 数触发。 | H4/H5 已对齐主链路：E1/E2/E3 基于 `ContextWindowState` pressure 自动触发 compact candidate；completed `local_summary` / `token_budget` event 可驱动本轮 inline re-pack；request-stage truncation 会 defer fallback，先尝试 compact；E5 已在 latest completed compact 覆盖当前 historyVersion + 1 且 soft pressure 未增长时跳过重复 compact；E6 已在 compact summary request 自身超窗时裁掉最老 compact prompt transcript message 并重试；F1-F4 已接入 initial context reinjection、baseline invalidation 和 restart resume；G1/G2 已有 service-only manual compact 入口；G3/G4 已有 tool-loop safe-boundary mid-turn compact；H1-H3 已有 Context Summary compact status / telemetry / warning；H4 DirectAgent 30+ turn parity eval 验证 pre-turn soft compact、replacement history、restart resume、rollback/stale evidence 和 visual fallback。 | 4 | 主链路基本对齐；用户可见 manual command surface 和真实 UI smoke 仍是后续增强。 | auto/manual compact policy，pre-turn 超阈值 inline compact，已覆盖的 soft pressure 不重复 compact，compact call 超窗可 retry，普通溢出可后台预压缩。 | P0 |
| Replacement History | compact 后用 selected recent user messages + summary + optional initial context 替换模型可见 history。 | H4/H5 已对齐主链路：completed compact event adapter 可将 replacement history 转为 provider-safe user/assistant history；E2E request snapshot 证明 completed compact event 会替换 raw recent history；model-generated completed event 已可写入；E2 已让刚写入的 completed event 参与本轮重新组包；F3 simulated restart fixture 和 H4 restored-client fixture 证明新 client 可从 JSONL completed event 恢复 compacted transcript；G1 manual compact 和 G3 mid-turn compact 都会写 completed replacement history event；request-stage fallback、failed event 和 rolling memory 不冒充 completed replacement history；H4 证明旧 raw history、rolled-back secret、`image_url` 和 PNG data URI 不进入 compacted provider request。 | 4 | 主链路基本对齐；真实 UI smoke 仍是后续增强。 | `CompactionState` 保存 summary、retained messages、replacement history、window metadata，并替换 transcript。 | P0 |
| Initial Context Reinjection | pre-turn/manual compact 后下一轮 full reinject；mid-turn compact 在模型预期位置插入 initial context。 | H4/H5 已对齐主链路：F1-F4 记录 `initialContextReinjection` 和 `baselineMetadata`；compact 后下一轮会注入 `<chipmate-initial-context-reinjection>` continuity context，包含 workspace/git/settings/RAG/tool/model baseline、diffRequired/fullReinjectRequired 和 baseline invalidation reason；G4 已在 mid-turn safe boundary 注入 `<chipmate-mid-turn-context-reinjection>`；H4 验证 restart 后仍注入 compact initial context 和 rollback invalidation reason。 | 4 | 主链路基本对齐；更细粒度 world diff 可继续增强。 | `WorldStateBaseline` 支持 diff 注入、baseline invalidation、rollback 后 full reinject。 | P0 |
| Rollback / Backtrack | 可按最近 user turn 回退 history，并清理相邻 contextual updates。 | 有 session events，但没有模型可见 transcript rollback。 | 0 | 回退后旧工具输出、文件状态或 initial context 可能继续泄漏。 | `HistoryTranscriptState` 支持按 user turn rollback，清理 call/output、state diff 和 stale baseline。 | P1 |
| Request Wire Adapter | Codex Responses request 使用 formatted input、instructions、tools、reasoning、metadata。 | ChipMate 现有 provider 走 Chat Completions `ChatMessage[]`。 | 1 | 若直接照搬 `ResponseItem` 会与现有 provider 失配。 | 内部 transcript 保持 Codex-like，发送前适配到 Chat Completions；未来可增加 Responses adapter。 | P0 |
| Recent Conversation Window | Codex 保留 thread history，并由 token/window 决定 compact 后保留哪些近期消息。 | 支持最近 raw history，默认 `maxHistoryTurns=10`、`maxHistoryBytes=40000`。 | 2 | 仍按固定 turn/bytes，而非 token/window relevance。 | recent raw history 成为 transcript/budgeter 的一个输入层，由 token/window 和 priority 决定保留。 | P1 |
| Rolling Summary / Memory | Codex compaction summary 是 replacement history 的组成部分。 | 支持 session-local rolling summary，默认 max 12000 bytes；D5 已明确 rolling memory 只作为 sidecar / compact 输入，不能驱动 completed replacement history adapter。 | 2 | 摘要是 sidecar，不是 compacted transcript；长会话保真仍应由 `context_compaction` completed event 承担。 | rolling summary 保留为 `MemoryState` 输入；compact parity 由 replacement history 承担。 | P1 |
| Task State Tracking | Codex 通过 goal、plan、conversation history 和 tools 维持任务连续性。 | 有 goal runtime，但聊天上下文组包未形成统一 `TaskState`。 | 1 | 目标、约束、阻塞、下一步不是高优先级上下文。 | 新增 `TaskState`，作为每轮请求的高优先级上下文。 | P0 |
| Plan / Checklist Persistence | 多步计划状态应跨轮稳定保留并可恢复。 | 可在文本历史中保留，但没有结构化 plan state。 | 1 | 计划状态依赖模型从旧文本恢复。 | 新增 `PlanState`，记录 pending/in_progress/completed/blocked、证据引用和更新时间。 | P1 |
| User Correction Priority | 最新用户纠偏优先级高于旧摘要和旧计划。 | 主要依赖最近窗口自然保留。 | 2 | compact/summary 后可能稀释纠偏。 | 将 user correction 抽取为 high-priority memory，ContextPack 强制靠前。 | P0 |
| Evidence Ledger / EvidenceState | 证据应可追踪、排序、失效，并进入上下文预算。 | 已有 evidence ledger，可随历史注入。 | 2 | 证据更多是文本历史，不是可排序资产。 | `EvidenceState` 统一 local context、CodeGraph、Document RAG、analysis、tool 和 visual evidence。 | P1 |
| Tool Execution Memory | 工具调用和输出是 transcript 的一部分，必须可恢复、可规范化。 | 已有工具历史摘要能力。 | 2 | 与 Task/File/Failure 状态联动不足。 | 工具结果归档为 ToolState，并更新 TaskState、EvidenceState、VerificationState、FailureState。 | P1 |
| Shell / Test Result Carryover | 命令和测试结果应跨轮保留并明确 verified/unverified。 | 部分工具历史可记录，但测试/命令语义不结构化。 | 1 | 命令、cwd、exit code、关键日志缺少统一状态模型。 | 新增 `VerificationState`，记录命令、结果、关键输出、时间和适用范围。 | P0 |
| File Read / Write State | 能区分 read、written、verified、stale，避免伪造验证。 | 当前上下文可包含本地文件和选择区。 | 1 | 缺少跨轮文件状态账本。 | 新增 `FileState`，记录 read/write/verified/stale，并与 diff 和 verification 关联。 | P0 |
| Git / Diff Awareness | worktree/diff 状态是工程上下文的重要 world state。 | `includeGitDiff` 默认 false，未作为核心状态。 | 1 | 分支、dirty files、staged/committed 状态不稳定进入上下文。 | 新增 `GitState` 或纳入 `WorldStateBaseline`，按需注入 branch、dirty files、diff summary、recent commits。 | P2 |
| RAG / CodeGraph Freshness | 证据带 freshness、index state 和路径相关性。 | 已有 CodeGraph/RAG evidence 与部分 staleness 字段。 | 2 | freshness 与上下文优先级、compact、world baseline 联动有限。 | 每条 evidence 标记 current/stale/unknown；索引或文件变化时自动降级旧 evidence。 | P1 |
| Visual Evidence Carryover | 图像按模型 modality 管理；不支持时降级为文本/artifact 摘要。 | 已支持上一轮 assistant visual evidence 输入，最多偏最近轮。 | 2 | 缺少长期 visual evidence index 和 modality fallback。 | `VisualEvidenceState` 记录 artifact、page、sourceHash、coverage、可复用范围和 visual modality fallback 文本。 | P2 |
| Context Budgeting | 按最新请求、任务、工具/文件/证据、近期 history、summary 分层预算。 | 已有 `ContextPackBudgetReport`、request-stage token gate 和 E1 `ContextWindowState`，按优先级保护 system / task state / latest user request，并输出 budget/pressure 日志；E2 会在 completed compact 后重跑 budget gate；E3 已把初始 prune 改为 compact 未完成后的 fallback；E4 在 replacement history 中强制保留 high-priority state snapshot；E5 已避免 unchanged soft pressure 重复消耗 compact 请求预算；E6 已避免 compact summary call 因旧 transcript slice 过大直接失败。 | 3 | 分层预算仍按 message 粗粒度，不是完整 asset-level ContextPack；更细 state protection、baseline 分类和 UI replay 仍未完成。 | `ContextPackBuilder` 按优先级组包并输出 budget report，最后执行 request-stage token gate。 | P0 |
| Interruption / Resume Recovery | 中断、重启、compact 后能恢复做到哪一步和下一步。 | F3 已有 compact-aware restart fixture：新 DirectAgent client 复用 JSONL completed compact event 后仍恢复 compacted transcript、retained intent、summary 和 reinjection context；checkpoint/rollback state scaffold 已存在。 | 2 | compact restart 已有基础；普通 interruption checkpoint、manual/mid-turn resume 和 UI replay 仍缺。 | 每轮写入 `TurnRecap` / checkpoint；resume 优先注入 Task/Plan/Failure/Verification state。 | P0 |
| Goal Continuation | active goal 能跨 turn 继续，不污染普通 user history。 | goal runtime 已较完整，但与新 context state 未合流。 | 2 | goal、plan、tool、file、failure 状态分散。 | GoalState 成为 TaskState 一部分，continuation 使用 Task/Plan/Failure/Verification state。 | P1 |
| User-Visible Context Summary | 用户可检查当前记忆、证据、截断和 stale 风险。 | H1-H3 已接入只读 Context Summary：展示 local context、window fallback、budget、CodeGraph/Document RAG、visual fallback、latest persisted compact status、strategy、summary age、retained/omitted、fallback/failure reason 和 compact 后 warning；H4/H5 已完成 request 级 parity eval 回填。 | 3 | 缺真实 VS Code UI smoke、可编辑 context state 和 manual compact 用户入口。 | 增加 Liquid Glass Context Summary UI，展示 Task/Plan/File/Verification/Evidence/Failure/Budget/Compact。 | P2 |
| Failure / Blocker Memory | 失败原因、阻塞条件、已尝试方案应跨轮保留。 | 可能存在于最近对话或工具历史中。 | 1 | 失败不是一等状态，长对话或 compact 后容易丢。 | 新增 `FailureState`，记录 blocker、attempted fixes、remaining risk、retry rule。 | P0 |
| Cross-Session Durability | 重启后恢复重要 state、history version、compact metadata。 | 已有 local session JSONL、memory records、goal store；F1-F4 已让 completed compact event 持久化 reinject mode、baseline metadata、history version，并在 simulated restart 后恢复 compacted transcript 与 baseline invalidation context；G1 manual compact 和 G3 mid-turn compact event 也写入同一 append-only JSONL；H1 可从 JSONL latest compact event 恢复 UI summary；H4 restored-client fixture 证明 30+ turn compact 后可从同一 storageRoot 恢复 replacement history、initial reinjection 和 rollback invalidation。 | 4 | 主链路基本对齐；真实 VS Code restart smoke 仍是后续增强。 | 所有新增 state 版本化持久化；旧 events 可迁移；compact/rollback 保留审计链。 | P1 |
| Compaction Telemetry / Warning | Codex compact 后有 token accounting、window metadata 和长线程 warning。 | 已有 `context_compaction` event telemetry、strategy log、before/after tokens、retained/omitted、window source、reinject mode、baseline metadata、failure/fallback/degraded reason；E5 skip、E6 overflow retry、G1 manual compact 和 G3 mid-turn compact 也会输出结构化日志；H2 Context Summary 展示 strategy、implementation、phase、historyVersion、summaryAge、duration 和 token/window metadata；H3 completed compact 后显示 long-thread warning；H4 fixture 验证 lifecycle + completed event 持久化。 | 4 | 基本对齐；真实 UI smoke 和 manual command surface 仍是后续增强。 | 记录 compact trigger、before/after tokens、retained/omitted counts、fallback reason，并在 UI 中显示 warning。 | P2 |
| Private Mechanism Boundary | 私有宿主机制不应被误列为必须复制。 | 文档已说明不复制私有运行时。 | 3 | 还需在最终验收中逐项标注 out-of-scope。 | vFinal 矩阵为每项标注 in-scope/out-of-scope 和体感等价方案。 | P2 |

## 实现回填

截至当前开发批次，ChipMate 已落地内部状态、预算、真实 replacement-history compaction 主链路、rollback scaffold、freshness scaffold、visual fallback preservation、只读 Context Summary UI 和 H4/H5 DirectAgent 30+ turn parity eval。评分含义仍以本文档的 0-4 标尺为准；无法验证或复制的 Codex 私有宿主机制不纳入 in-scope。真实 VS Code UI smoke、用户可见 manual command surface 和更细 world diff 仍作为后续增强保留。

| Area | 当前实现证据 | 回填评分 | 仍需注意 |
| --- | --- | --- | --- |
| Transcript / State | `src/conversation-context.ts` 定义 `ConversationContextState`、`HistoryTranscriptState`、`TaskState`、`PlanState`、`FileState`、`VerificationState`、`FailureState`、`EvidenceState`、`WorldStateBaseline`。 | 4 | 内部 wire shape 继续适配 Chat Completions，不复制 Codex Responses 私有格式。 |
| Token Window / Budget | `src/context-window.ts` 与 `src/context-pack.ts` 覆盖 manual、metadata、builtin、`262144` fallback、budget report 和 request-stage gate。 | 4 | provider `/models` 可用性仍取决于外部 provider。 |
| Compaction / Replacement History | `src/context-compaction.ts` 生成 compact candidate、replacement history、retained users、summary、telemetry、fallback-pruned 状态、redundant compact skip decision、compact overflow retry plan、initial reinject mode 和 baseline metadata；request-stage `fallback_pruned` 会写入 append-only `context_compaction` JSONL event；latest completed compact event 已有 provider-safe replacement history adapter、normalization diagnostics 和 request snapshot；soft-threshold/manual candidate 已可通过 chat provider 生成 model compact summary，quality gate 通过后写 completed event，失败时写 failed event；D5 保证 rolling memory 不冒充 compact replacement history；D6 新增 strategy router；E1 新增 scope-aware `ContextWindowState`，避免 large prefill 误触发 soft compact；E2 让 completed event 写入后立即参与本轮重新组包发送；E3 让 request-stage truncation 优先尝试 compact，compact 未完成时才 fallback prune；E4 强制 high-priority state snapshot 进入 replacement history；E5 避免 latest completed compact 已覆盖且 soft pressure 未增长时重复 compact；E6 让 compact summary request 自身超窗时裁掉最老 transcript slice 后重试；F1-F4 让 completed compact 后恢复 initial context reinjection 和 simulated restart resume；G1-G2 增加 service-only manual compact 入口；G3-G4 增加 mid-turn safe-boundary compact / reinjection；H1-H3 增加 persisted compact UI summary、telemetry 和 long-thread warning；H4/H5 DirectAgent parity eval 验证 30+ turn pre-turn compact、replacement history、restart resume、rollback marker、stale evidence 和 visual fallback。 | 4 | 主链路已对齐；manual compact 用户可见入口和真实 VS Code UI smoke 仍是后续增强。 |
| Resume / Rollback | `ConversationContextState` 支持 checkpoint、resume、rollback marker、rolled-back transcript omitted、文件/验证/失败状态清理和 full reinject marker。 | 4 | rollback 基于 append-only marker，不删除原始 JSONL 审计事件。 |
| Evidence / Visual / World | `EvidenceState` freshness、`VisualEvidenceState` fallback text、`WorldStateBaseline` diff/full reinject 语义已接入高优先级上下文。 | 4 | Git diff、RAG index hash 等更细粒度 world diff 可继续增强。 |
| User-Visible Context Summary | `src/context-summary.ts` 和 chat webview context popover 提供只读 summary，展示 included/truncated/omitted、fallback、compact、rollback、freshness；H1-H3 已从 persisted `context_compaction` event 回放 compact status、summary age、strategy、retained/omitted、fallback/failure reason 和 long-thread warning。 | 3 | UI 首版只读，不提供编辑 context state；仍需真实 UI smoke。 |
| Private Mechanism Boundary | 本路线只实现公开可见行为等价，不写入或依赖私有 provider endpoint、私有模型名、隐藏 sticky routing 或 Codex 私有宿主策略。 | 4 | 私有宿主机制标为 out-of-scope；用本地状态、预算、compact、checkpoint 和 summary 提供体感替代。 |

## 当前强项

- ChipMate 已经具备最近 raw history、session-local rolling summary、本地文件上下文、CodeGraph/RAG、Document RAG、evidence ledger、tool history、visual evidence 和 goal runtime。
- 当前架构不是裸聊，已有 JSONL session events、memory records、tool/evidence history，可作为 `HistoryTranscriptState` 与 `ConversationContextState` 的输入源。
- Goal runtime 已经比普通聊天状态更完整，后续应映射进 `TaskState`，不要重写一套 goal 系统。

## 主要短板

- 最大差距已从 replacement-history compaction 主链路转到产品入口和真实 UI 验证：ChipMate 已有 request-stage token gate、E1 scope-aware pressure check、model-generated completed compact event、completed-event adapter、compact strategy router、E2 inline re-pack、E3 compact-first/prune-fallback、E4 high-priority state snapshot、E5 redundant compact skip、E6 compact overflow retry、F1-F4 initial context reinjection / restart resume、G1-G2 service-only manual compact、G3-G4 mid-turn compact、H1-H3 compact UI summary / telemetry / warning，以及 H4/H5 DirectAgent 30+ turn parity eval；仍缺真实 VS Code UI smoke 和 user-visible manual command surface。
- rolling summary 只是 session-local sidecar memory，不能算 Codex compaction parity；D5 已加保护，防止它冒充 completed replacement history。
- chat provider context window 已有手动值、metadata、内置表和 `262144` fallback 解析；E1 已补 body-after-prefill pressure check，但仍需更细粒度 baseline 分类和持久化 pressure event。
- compacted transcript adapter 已有 normalization、compact 后 initial reinjection、mid-turn tool suffix 保留，以及 H4 对 visual fallback、rollback marker、stale evidence 的 request 级 eval；更细 world baseline / RAG index hash invalidation 仍可继续增强。
- 任务、文件、验证、失败和证据状态仍是分散信息，没有统一高优先级 ContextPack。

## 推荐优先级

1. 先做 Codex-backed baseline audit，并保持本矩阵与开发计划同步。
2. 建立 `HistoryTranscriptState + ConversationContextState`，从现有 JSONL events 只读映射，保证兼容。
3. 实现 Codex-style 用户可见 manual compact command surface，并复用 `DirectAgentClient.compactSession()` pipeline。
4. 继续深化 `ContextWindowState` 的 baseline 分类与持久化，补真实 provider capability 驱动 token-budget path。
5. 再补 `TaskState + TurnRecap + FileState + VerificationState + FailureState + EvidenceState` 的 UI/编辑闭环。
6. 最后完成真实 VS Code UI smoke，并持续扩展 parity eval 到更多 provider 错误样本和 RAG index invalidation。

## Assumptions

- 本文档是规划和审计文档，不写入任何私有 provider endpoint、私有模型名或 VSIX 注入默认值。
- 后续实现应复用现有 session events、memory records、goal runtime、evidence ledger、CodeGraph/RAG 和 Document RAG。
- parity 的定义是公开可见 Codex 上下文行为的用户体感和工程能力等价；无法复制的私有宿主机制必须在最终矩阵中标为 out-of-scope。
