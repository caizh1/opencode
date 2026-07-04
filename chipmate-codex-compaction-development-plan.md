# ChipMate Codex Compaction Development Plan

## 背景与当前结论

本文档基于 `chipmate-codex-compaction-parity-matrix.md`，把 ChipMate 的 Codex-style compaction 补齐工作拆成可执行阶段。本文只覆盖上下文压缩机制，不重新展开完整 context parity。

当前结论：ChipMate 的 Codex-style replacement-history compaction 主链路已完成 H4/H5 验收回填。当前实现已经能解析 context window、做 request-stage token gate、生成 compact candidate、写入 persistent `context_compaction` event、发起 model-generated compact summary、在 quality gate 通过后写 completed event、失败时写 failed event，并让后续请求优先使用 completed replacement history adapter；D5 明确防止 rolling memory 冒充 compact replacement history；D6 已新增 compact strategy router；E1 已新增 `ContextWindowState`，能区分 active tokens、prefill tokens、body/scope tokens、tokens until compaction 和 hard limit；E2 已实现 completed compact event 写入后的 current-turn inline re-pack，本轮请求会重新读取 session events 并使用 replacement history adapter；E3 已实现 request-stage prune 延迟安装，compact completed 优先，compact 未完成时才 fallback prune；E4 已将 TaskState、PlanState、FailureState、VerificationState、FileState 和用户纠偏写入强制 `initial_context` state snapshot，并用长 session fixture 验证 compact 后不丢；E5 已避免 latest completed compact 覆盖同一 historyVersion 且 soft pressure 未增长时重复调用 compact model；E6 已在 compact summary request 自身超窗时执行 bounded oldest-message trimming/retry，并记录 degraded reason；F1-F4 已将 reinject mode、baseline metadata、compact 后 world baseline 注入、baseline invalidation 和 simulated restart resume 接入请求链路；G1-G2 已新增 service-only manual compact 入口并明确 UI 后续入口边界；G3-G4 已新增 tool-loop 安全边界 mid-turn compact，在完整 assistant tool_calls + tool outputs 后写 completed compact event，并将 compacted replacement history、`mid_turn_insert` reinjection 和最后一组原始工具后缀重组到下一次 provider request；H1-H3 已让 Context Summary 从 persisted `context_compaction` event 展示 status、strategy、summary age、retained/omitted、fallback/failure reason 和 compact 后 long-thread warning；H4/H5 已新增 DirectAgent 30+ turn parity eval，覆盖 pre-turn compact、replacement history、append-only persistent event、restart resume、rollback marker、stale evidence、visual fallback 文本化和 provider-safe request。仍保留后续增强：用户可见 manual compact command surface、真实 VS Code UI smoke、provider capability 驱动 token-budget path 和更细粒度 world diff。

## Codex 公开源码审计补充

- Codex 的 compaction 不是单一“滚动摘要”：公开源码中同时存在 model-generated local compaction、token-budget compaction，以及按 provider 能力扩展 remote compaction 的策略入口。
- Codex compact lifecycle 包含 auto/manual trigger、pre/post compact hooks、`ContextCompactionItem` started/completed、replacement history、history rewrite、token usage recompute、analytics 和 compact 后 long-thread warning。
- Codex 的 window pressure 不是单纯 ratio：它区分 active context、auto-compact scope、prefill tokens、tokens until compaction、full context hard limit 等状态。
- Codex 的 summary replacement history 会保留近期真实 user messages，并在 token cap 下尽量保留更多用户意图；summary item 本身在 provider 适配时必须明确标注为 continuity context，不能被当成新的用户请求。
- Codex 在 compact model call 自身超窗时会裁掉最老 history item 后重试，避免 compact 因历史过大直接失败。

## 目标状态

最终目标是让 ChipMate 在长会话接近上下文窗口时具备与 Codex 体感等价的 compaction 闭环：

- `ContextWindowState` 能记录 active tokens、scope tokens、prefill tokens、tokens until compaction、window source、fallback reason 和 token limit reached。
- `context_compaction` event 以 append-only 方式持久化 compact 结果，不删除原始 session message。
- compact lifecycle 有 started/completed/failed/interrupted 状态，可被 UI、日志和调试流观察。
- compact strategy 能区分 local model summary、token-budget fallback 和后续 provider/remote 扩展位。
- compact summary 由模型生成，并明确保留 TaskState、PlanState、FileState、VerificationState、FailureState、EvidenceState 和 VisualEvidence fallback。
- replacement history 替换模型可见旧历史，发送链路优先使用 latest completed compact event。
- compact 后执行 initial context reinjection，确保 workspace/tool/settings/RAG/git/model baseline 可恢复。
- compact 失败时 fallback 到安全 prune，并在日志与 Context Summary 中显示 degraded-but-safe。
- compact model call 自身超窗时执行 bounded oldest-item trimming/retry，并保留近期用户消息优先级。
- 重启或恢复 session 后仍能从 compact event 恢复 model-visible transcript。

## 阶段路线

阶段标签：`v0: Correct Audit And Guardrails`、`v1: Persistent Compact Event`、`v2: Replacement History Adapter`、`v3: Model-Generated Compact Summary`、`v4: Pre-Turn Inline Compact`、`v5: Initial Context Reinjection And Resume`、`v6: Manual And Mid-Turn Compact`、`v7: UI And Telemetry`、`vFinal`。

| Phase | 名称 | 主要交付 | 完成判断 |
| --- | --- | --- | --- |
| v0 | Correct Audit And Guardrails | 修正文档评分和验收口径，防止 scaffold 被当成 parity。 | 总矩阵与专项矩阵都明确真实 compact 未完成。 |
| v1 | Persistent Compact Event And Lifecycle | 定义并读写 append-only `context_compaction` event，补 compact lifecycle item 与 hooks。 | completed / failed / interrupted / fallback_pruned event 可从 JSONL 恢复，UI 可见真实 compact lifecycle。 |
| v2 | Replacement History Adapter | 发送链路优先使用 completed replacement history。 | provider request 中旧 raw history 被 compacted transcript 替换，且后置 system 不再出现。 |
| v3 | Model-Generated Compact Summary | 增加 compact summary model call、prompt override、strategy router 和质量 gate。 | summary 能保留关键 state，失败时安全降级，token-budget strategy 可走 fresh window。 |
| v4 | Pre-Turn Inline Compact | context pressure 达阈值时先 compact 再发送，并处理 compact 自身超窗。 | 长 session 超窗前自动 compact 并继续请求；compact call 超窗可裁旧项重试。 |
| v5 | Initial Context Reinjection And Resume | compact 后 full reinject baseline，重启后恢复 compacted transcript。 | restart / resume fixture 能恢复 compact 后任务状态。 |
| v6 | Manual And Mid-Turn Compact | manual compact 入口和 tool-loop 安全边界 compact。 | manual 与 mid-turn compact 都不破坏 tool call/output 成对关系。 |
| v7 | UI Telemetry And Warning | Context Summary 展示真实 compact 状态、telemetry 和 long-thread warning。 | 用户可见 retained/omitted、summary age、fallback reason、compact 后可靠性提示。 |
| vFinal | Parity Eval | 30+ turn 长会话端到端验收。 | ✅ replacement-history compaction 主链路达到 Score 4，并已回填矩阵；manual command surface 和真实 UI smoke 作为后续增强保留。 |

## 详细任务表

状态标记：`✅` 已完成；`◐` 部分落地；未标记表示未完成。

| Task | Phase | 目标 | 实现内容 | 验收证据 |
| --- | --- | --- | --- | --- |
| ✅ A1 | v0 | 修正总 parity 评分口径。 | 将总矩阵中过度回填的 Compaction / Replacement History 从 Score 4 改为未达 parity 状态，并随真实实现进展保守回填。 | `chipmate-codex-context-parity-matrix.md` 已避免早期把 compaction 标为 Score 4；H4/H5 通过后仅将有 request 级 eval 证明的 replacement-history 主链路回填为 Score 4。 |
| ✅ A2 | v0 | 标明 scaffold 与真实 compact 边界。 | 在 compaction 专项矩阵和开发计划中说明 candidate / telemetry 不等于 completed compact。 | 专项 matrix / plan 都明确 scaffold 不算 parity。 |
| ✅ A3 | v0 | 增加实现前 guardrail。 | 在开发计划中固定 append-only、system-only-first、no private defaults、continuity-context 标注等约束。 | 文档列出不可违反的实现边界。 |
| ✅ A4 | v0 | 建立验收 checklist。 | 定义每阶段最小测试、最终 parity eval 和回填条件。 | 本文档含测试矩阵和 Matrix 到任务对齐索引。 |
| ✅ B1 | v1 | 设计 `context_compaction` event schema。 | 定义 version、id、trigger、reason、implementation、strategy、phase、status、window、summary、replacementHistory、retainedMessageIds、omittedMessageIds/count、failureReason。 | `src/context-compaction.ts` 定义 `ContextCompactionEventRecord`，`test/context-compaction.test.ts` 覆盖事件构造和损坏事件忽略。 |
| ✅ B2 | v1 | 实现 compact event 写入。 | 新增 append-only writer，只追加 JSONL，不改写原始 message。 | `appendContextCompactionEvent()` 单测证明不修改旧 events；`DirectAgentClient.persistFallbackCompactionEvent()` 对 request-stage `fallback_pruned` 写入 JSONL。 |
| ✅ B3 | v1 | 实现 compact event 读取。 | 从 session events 中读取 latest completed / failed / interrupted / fallback compact event。 | `contextCompactionEventsFromSessionEvents()` 与 `latestContextCompactionEvent()` 单测覆盖 latest completed 和损坏 event。 |
| ✅ B4 | v1 | 增加 rewrite metadata。 | 为 compact event 添加 historyVersion、baseEventId、createdAt、sourceModel、sourceWindow、compactPromptSource。 | event snapshot 单测验证 `historyVersion`、`baseEventId`、`sourceModel`、`sourceWindow`、`compactPromptSource`。 |
| ✅ B5 | v1 | 接入 compact event telemetry。 | completed / failed / interrupted / fallback_pruned 都输出结构化日志。 | `formatContextCompactionEventRecord()` 覆盖 trigger、reason、implementation、strategy、phase、status、before/after tokens、retained、omitted、duration、failure/fallback/reinject/baseline；DirectAgent model-generated / token-budget / fallback path 输出 event telemetry。 |
| ✅ B6 | v1 | 增加 compact lifecycle item。 | 新增 `ContextCompaction` 等价 run progress item，标记 started/completed/failed/interrupted。 | `ContextCompactionLifecycleSessionEvent` 与 `buildContextCompactionLifecycleEvent()` 单测覆盖 started/completed；DirectAgent model-generated / token-budget / fallback path 写入 lifecycle JSONL。 |
| ✅ B7 | v1 | 增加 compact hooks。 | 新增 preCompact/postCompact service hooks，用于 state snapshot、event write、UI notify 和 interruption。 | `runCompactHooks()` 覆盖 continue/stopped/error；DirectAgent model-generated / token-budget / fallback compact path 已接 pre/post hooks，hook 中止/错误会写 interrupted/failed lifecycle 且不阻断请求。 |
| ✅ C1 | v2 | 定义 model-visible compacted transcript。 | 将 completed compact event 转换为 retained user messages + compaction summary + required state context。 | `compactedHistoryMessagesFromEvent()` 将 completed event 转成稳定 provider-safe history message，单测覆盖 retained、summary、initial context。 |
| ✅ C2 | v2 | 接入发送链路。 | `recentChatHistoryMessages()` 优先读取 latest completed compact event，再追加当前 request。 | DirectAgent 已接 `latestCompletedContextCompactionEvent()` + `compactedHistoryMessagesFromEvent()`；`direct-agent-client` E2E request snapshot 证明 completed compact replacement history 替换 raw recent history。 |
| ✅ C3 | v2 | 保证 system message 顺序。 | adapter 输出时只允许第一条为 `system`；compact summary 不使用 system role。 | adapter 单测验证 replacement history 输出不包含 `system` role，`initial_context` 会转为 user continuity context。 |
| ✅ C4 | v2 | 防止 summary 被当成用户新指令。 | compaction summary 使用 provider-compatible continuity context；可按 provider 使用 user-role wrapper，但必须显式标注 `continuity context, not a new user request` 并包含 provenance。 | adapter 单测验证 compaction summary 包含 `ChipMate compacted conversation continuity context` 和 `not as a new user request`。 |
| ✅ C5 | v2 | 保留 recent user intent。 | replacement history 按 token cap 保留近期 user messages，首版可提供默认上限并允许后续配置。 | `buildCompactionCandidate()` 默认按 `DEFAULT_RETAINED_USER_MESSAGE_MAX_TOKENS` 和 `DEFAULT_RETAINED_USER_MESSAGE_MAX_COUNT` 保留近期 user messages；单测覆盖超过 3 条和小 token cap。 |
| ✅ C6 | v2 | 做 history normalization。 | compacted transcript 进入 provider 前处理不支持的图片、orphan tool output、重复 summary 和 stale reference context。 | `buildCompactedHistoryAdapterSnapshot()` 生成 normalized messages + diagnostics；单测覆盖 system role 降级、重复 summary/item、orphan tool output、unsupported modality；DirectAgent 输出 adapter diagnostics。 |
| ✅ D1 | v3 | 设计 compact summary prompt。 | 输入 transcript slice、TaskState、PlanState、FileState、VerificationState、FailureState、EvidenceState、VisualEvidence fallback，并支持内部默认 prompt 与 override。 | `buildCompactSummaryPrompt()` 生成 bounded system/user prompt，支持 override；单测覆盖 state sections、visual fallback、长正文截断和不带 provider 配置字段。 |
| ✅ D2 | v3 | 实现 compact summary model call。 | 使用当前 chat provider 发起非工具 compact request，要求 JSON 或结构化文本输出。 | `DirectAgentClient.requestCompactSummary()` 以 `stream:false`、无 tools 调用当前 chat provider；`parseCompactSummaryModelOutput()` + `compactStateWithModelSummary()` 生成 completed replacement history；mock provider 测试验证返回 summary 后写入 completed `context_compaction` event。 |
| ✅ D3 | v3 | 增加 summary quality gate。 | 校验 summary 非空、包含 current objective / next actions / risks，并限制最大 bytes。 | `validateCompactSummaryQuality()` 覆盖空/超长/乱码、missing objective、missing next actions、missing risks；DirectAgent 只在 gate 通过后写 completed compact event，失败时写 failed lifecycle 并继续当前请求。 |
| ✅ D4 | v3 | 处理 compact 失败。 | 失败写入 failed event，保留 request-stage prune，不阻断用户请求。 | model compact 失败或 quality gate 失败时写入 `status=failed` 的 `context_compaction` event 与 failed lifecycle；DirectAgent 记录 degraded-but-safe 日志并继续当前请求；Context Summary model 对 failed compaction 显示 warning。 |
| ✅ D5 | v3 | 防止 rolling summary 冒充 compact。 | rolling memory 只能作为 compact 输入，不作为 completed replacement history。 | `latestCompletedContextCompactionEvent()` 只读取 completed `context_compaction` event；单测验证 memory event 即使包含 replacementHistory / contextCompaction-like payload 也不会驱动 adapter；DirectAgent 请求级测试验证 rolling memory 只作为 sidecar 注入，raw recent history 不被替换。 |
| ✅ D6 | v3 | 增加 compact strategy router。 | 支持 `local_summary`、`token_budget`、`fallback_pruned`，并预留 provider capability 扩展位。 | `chooseCompactionStrategy()` 输出 implementation / strategy / phase / prompt source / requiresModelSummary；DirectAgent 统一记录 `[context-compact-strategy]` 并按 decision 分派；单测证明 token-budget compact 不要求模型摘要但仍可写 lifecycle/event，DirectAgent 请求级测试验证 JSONL 写入 `strategy=local_summary`。 |
| ✅ E1 | v4 | 实现 pre-turn pressure check。 | 在发送前用 `ContextPackBudgetReport` 和 `ContextWindowState` 判断 ratio、scope tokens、prefill tokens、tokens until compaction、hard limit。 | `buildContextWindowState()` 记录 active/prefill/body/scope tokens、threshold、tokensUntilCompaction、hardLimitReached 和 reason；DirectAgent 每轮输出 `[context-window-state]`；单测覆盖 90% body scope 触发 compact、body-after-prefill 不被 large prefill 误触发。 |
| ✅ E2 | v4 | 实现 inline compact before send。 | 达阈值时先生成 compact summary 或 token-budget completed event；completed event 写入后重新读取 session events、走 completed compact adapter，并重建本轮 provider `messages`。 | `persistModelGeneratedCompactionEvent()` / `persistTokenBudgetCompactionEvent()` 返回 completed record；DirectAgent 记录 `[context-compact-inline] re-packed current request` 和 `[context-compact-adapter] using completed compact`；请求级测试证明 compact summary request 先发生，随后 stream request 使用 compacted continuity context，且不再携带旧 raw assistant history。 |
| ✅ E3 | v4 | 合并 request-stage prune 与 compact。 | 初次 request-stage gate 只生成 budget/pressure/fallback candidate；`deferRequestStageFallback` 让 compact first，completed compact 会重组本轮请求；只有 compact 未完成且 gate 确实截断时，才安装 pruned messages 并写 `fallback_pruned` event。 | `compactStateWithRequestStageFallbackPrune()` 单测覆盖 deferred fallback；DirectAgent 超窗 fixture 证明初始 gate `truncated=true` 时仍先写 completed `local_summary`，stream request 使用 compacted history，session JSONL 不写 `status=fallback_pruned`。 |
| ✅ E4 | v4 | 保护高优先级 state。 | completed compact replacement history 增加 provider-safe `initial_context` state snapshot，强制保留 TaskState、PlanState、FailureState、VerificationState、FileState 和用户纠偏；token-budget compact 也保留该 state snapshot。 | `highPriorityStateSnapshot()` 写入 `<chipmate-high-priority-state>`；长 session fixture 验证 retained user token cap 很小时，compact 后仍保留 objective、PlanState、user correction、FileState、VerificationState、FailureState 和失败日志。 |
| ✅ E5 | v4 | 避免重复 compact。 | 新增 redundant compact skip decision：latest completed compact 已覆盖当前 historyVersion + 1，且 soft-threshold active/scope pressure 未增长时，跳过 compact summary/token-budget 分派；hard limit / request-stage truncation 不跳过。 | `shouldSkipRedundantCompaction()` 单测覆盖 unchanged pressure skip、pressure 增长不 skip、request-stage truncation 不 skip；DirectAgent 连续发送 fixture 验证只发 stream request，不再发 `stream:false` compact summary，也不追加等价 `context_compaction` event。 |
| ✅ E6 | v4 | 处理 compact call 自身超窗。 | compact summary request 遇到 context-window exceeded 时执行 bounded oldest-message trimming/retry；每次 retry 把 compact prompt 的 `<transcript-slice>` 减半，保留最新 transcript message，成功后在 completed `context_compaction` event 的 fallback/degraded reason 中记录裁剪原因。 | `compactSummaryOverflowRetryPlan()` 单测覆盖裁最老 message 并保留近期 message；DirectAgent `compact-overflow` fixture 模拟首次 `400 context length exceeded`，第二次裁剪后成功写 completed event，session log 记录 `compact summary request exceeded model context`，且不写 failed event。 |
| ✅ F1 | v5 | 实现 initial context reinjection 标记。 | `context_compaction` completed event 记录 `initialContextReinjection` 和 `baselineMetadata`，并在 event telemetry 中输出 `reinject` / `baseline`。 | event schema 单测验证 `next_turn_full`、baseline source、workspace/git/settings/RAG/model/sourceWindow metadata 可从 JSONL 恢复。 |
| ✅ F2 | v5 | 接入 world baseline。 | `recentChatHistoryMessages()` 在 latest completed compact 后插入 provider-safe `<chipmate-initial-context-reinjection>` user continuity context，注入 workspace/git/settings/RAG/tool/model baseline 和 diff/invalidation reason。 | DirectAgent request snapshot 包含 `WorldStateBaseline`、`compactId`、`mode=next_turn_full`，且不会插入后置 system message。 |
| ✅ F3 | v5 | 实现 restart / resume 恢复。 | 重启后从 JSONL 读取 latest completed compact event，恢复 model-visible compacted transcript，并继续注入 compact initial context。 | simulated restart fixture 用新 DirectAgent client 复用同一 storageRoot，stream request 仍包含 retained intent、compact summary 和 reinjection context。 |
| ✅ F4 | v5 | 处理 baseline invalidation。 | 比较 compact event baseline metadata 与当前 world baseline / chat model，发现 settingsHash、RAG index、git、tool hash、model 等变化时标记 full reinject reason。 | stale baseline fixture 显示 `settings hash changed`、`RAG index version changed` 等 invalidation reason。 |
| ✅ G1 | v6 | 增加 manual compact 入口。 | `DirectAgentClient.compactSession()` 作为 service-only manual compact 入口，强制 `trigger=manual` 生成 candidate，并复用 compact summary、strategy router、lifecycle hooks、baseline metadata 和 persistent `context_compaction` event 写入。 | manual compact 单测验证无 pressure 也能写 completed event，`trigger=manual`、`phase=manual`、`implementation=local_summary`，且 compact request 为 `stream:false` / no tools。 |
| ✅ G2 | v6 | 设计 UI 后续入口边界。 | 代码注释明确首版是 service-only manual compact entry；后续 UI 或 command surface 必须调用同一 pipeline，不另写旁路 JSONL。 | 核心 pipeline 不依赖 UI 按钮；manual compact service 测试独立通过。 |
| ✅ G3 | v6 | 实现 mid-turn compact 安全点。 | 在 tool-loop 中先用 byte-level guard 避免无压力路径开销；只有 live messages 接近窗口阈值时才做 token pressure 检测；仅在最后一组 assistant `tool_calls` 与后续 `tool` outputs 完整成对、且没有 pending/orphan tool message 时 compact。 | `DirectAgentClient` tool-loop fixture 验证请求顺序为 stream -> compact summary -> stream，且第二次 provider request 中 tool output 紧跟对应 assistant tool_calls。 |
| ✅ G4 | v6 | mid-turn initial context reinjection。 | mid-turn compact completed 后将 provider-safe replacement history、`<chipmate-mid-turn-context-reinjection>` user continuity context 和最后一组原始 tool-call suffix 重组成下一次 live provider request；原始 JSONL message 保持 append-only。 | `DirectAgentClient` fixture 验证 request role/order 合法、无后置 system、无 `<chipmate-initial-context-reinjection>` 误注入，session log 记录 `trigger=mid_turn_pressure`、`phase=mid_turn`、`initialContextReinjection=mid_turn_insert`。 |
| ✅ H1 | v7 | Context Summary 展示真实 compact status。 | `DirectAgentClient.getLatestContextCompaction()` 暴露 latest completed / failed / interrupted / fallback_pruned event；`ChatView` 在会话加载/流结束后缓存 latest compact event，并把 persisted compact section 合并到 Context Summary。 | webview source snapshot 包含 `getLatestContextCompaction()` 数据源和 compact rows；Context Summary 单测验证 completed compact section 显示 retained/omitted、summary age、strategy、status。 |
| ✅ H2 | v7 | 完善 compact telemetry。 | Context Summary compact row 展示 trigger、status、strategy、implementation、phase、reason、historyVersion、summaryAge、duration、before/after tokens、window source、retained/omitted、fallback/failure reason；已有 event formatter 覆盖四类 persistent status。 | `context-summary` 单测验证 persisted completed compact telemetry；`context-compaction` telemetry 测试覆盖 completed / failed / interrupted / fallback_pruned。 |
| ✅ H3 | v7 | 增加 compact 后 warning。 | completed compact 后 Context Summary 输出非阻塞 long-thread warning，说明长会话和重复 compact 可能降低准确性，可继续或新开会话；failed/fallback/interrupted 仍显示 degraded warning。 | UI/model snapshot 包含 compact warning，但请求不中断；`context-summary` 单测验证 completed compact warning。 |
| ✅ H4 | vFinal | 增加 parity eval fixtures。 | 新增 DirectAgent 30+ turn parity eval fixture，覆盖 pre-turn soft compact、model-generated completed event、replacement history、append-only session log、system-only-first、restart resume、rollback marker、stale evidence、visual fallback artifact path/sourceHash/page、PNG data URI 不进 provider request。 | `bun test test/direct-agent-client.test.ts -t "parity eval keeps replacement history" --timeout 30000` 通过；fixture 断言 compact request 包含 Plan/Evidence/Visual/Verification/rollback state，stream/restart request 使用 compacted transcript 且不含旧 raw history、rolled-back secret、`image_url` 或 PNG data URI。 |
| ✅ H5 | vFinal | 回填专项矩阵和总矩阵。 | 基于 H4 证据，将 compaction 主链路相关 capability 回填到 Score 4；未实现的用户可见 manual command surface、真实 UI smoke、provider capability 自动 token-budget 仍保持后续增强，不误标完成。 | `chipmate-codex-compaction-parity-matrix.md` 与 `chipmate-codex-context-parity-matrix.md` 已同步更新。 |

## Matrix 到任务对齐索引

| Matrix Capability | Plan Tasks |
| --- | --- |
| Context Window Pressure Detection | B1, E1, H2 |
| Auto-Compact Scope / Prefill Window | E1, 测试矩阵 scope / prefill 场景 |
| Auto Compact Trigger | E1, E2, E3, E5 |
| Manual Compact Trigger | ✅ G1, ✅ G2 |
| Pre-Turn Inline Compaction | E1, E2, E3, E4, E5, E6 |
| Mid-Turn / Tool-Loop Compaction | ✅ G3, ✅ G4 |
| Request-Stage Fallback Pruning | D4, E3 |
| Compaction Implementation Strategy | D6 |
| Model-Generated Compact Summary | D1, D2, D3, D4, D5, E6 |
| Compaction Prompt Override | B4, D1 |
| Replacement History | C1, C2, D5, E2, E4, E5 |
| Retained Recent User Messages | C5, E6 |
| Initial Context Reinjection | F1, F2, F4, ✅ G4 |
| Persistent Compact Event | B1, B2, B3, B4 |
| ContextCompaction Turn Item | B6, ✅ H1 |
| Compact Lifecycle Hooks | B7 |
| History Version / Rewrite Metadata | B4, C2, F3 |
| Transcript Adapter After Compact | C1, C2, C3, C4 |
| TaskState Preservation | D1, E4 |
| PlanState Preservation | D1, E4 |
| FileState Preservation | D1, E4, F4 |
| VerificationState Preservation | D1, E4 |
| FailureState Preservation | D1, D4, E4 |
| Evidence / RAG Freshness Preservation | D1, F4, ✅ H4 |
| Visual Evidence Fallback Preservation | D1, C6, ✅ H4 |
| Compact Failure Recovery | D4, E3, E6 |
| During-Compact Window Overflow Handling | E6 |
| User-Visible Compact Status | ✅ H1 |
| Long-Thread Warning After Compact | ✅ H3 |
| Compact Telemetry | B5, ✅ H2 |
| Cross-Session Resume After Compact | F3, F4 |
| Parity Eval Fixtures | ✅ H4, ✅ H5 |

## 测试与验收矩阵

| Scenario | 必须验证 | 主要测试 |
| --- | --- | --- |
| 长 session 接近 90% window | 自动 compact，当前请求继续发送。 | `context-compaction` + `direct-agent-client` fixture |
| auto-compact scope / prefill | body-after-prefix 或 prefilled baseline 不错误吞掉正文预算。 | `ContextWindowState` budget fixture |
| 请求已超窗 | compact 优先；失败时 fallback prune。 | request-stage budget gate fixture |
| compact call 自身超窗 | bounded oldest-item trimming/retry，近期用户消息优先保留。 | compact-overflow fixture |
| completed compact event | replacement history 替换旧 raw history。 | transcript adapter snapshot |
| compact lifecycle item | started/completed/failed/interrupted 可见。 | event/run-progress snapshot |
| strategy router | local summary 与 token-budget compact 都能写入合法 event。 | strategy unit test |
| provider summary 失败 | 写 failed event，不中断请求，显示 degraded warning。 | mock provider failure |
| 重启恢复 | latest completed compact event 恢复 model-visible transcript。 | simulated restart fixture |
| manual compact | 显式触发并写 completed event。 | service 单测 |
| mid-turn compact | 不产生 orphan tool output，不破坏 tool_choice 流程，压缩后继续下一次 provider request。 | 已通过 tool-loop fixture |
| stale evidence / visual fallback | compact 后不把 stale evidence 当 current，不强行发送 unsupported images。 | 已通过 DirectAgent H4 parity eval fixture |
| system message order | compact summary 不产生后置 system。 | provider request role snapshot |
| compact 后 warning | completed compact 后有非阻塞提示。 | 已通过 Context Summary UI/model snapshot |
| 最终验证 | 全量关键测试和 package 通过。 | H4 targeted test 已通过；交付前继续执行关键 compaction/context tests、`bun run compile`、`bun run package` 和 VSIX 打包。 |

## 风险与边界

- 不删除原始 JSONL message；compact、rollback、migration 只能追加可审计 metadata。
- 不把 rolling summary 当作 Codex-style compaction；只有 completed `context_compaction` event + replacement history adapter 生效后才算 compact。
- 不把 compact summary 写成普通用户请求；它必须标注为 continuity context，具体 role 由 provider adapter 决定，但不能产生后置 system message。
- 不允许后置 system message；provider wire request 中 system 只能位于开头。
- 不写入任何私有 provider endpoint、私有模型名或 VSIX 注入默认值。
- 首版 manual compact 已先做 service-only entry，不强制立即做 UI 按钮；后续 UI/command 必须调用同一 `compactSession()` pipeline。
- 首版 compact summary 复用当前 chat provider；后续可增加独立 compact model 配置。
- token-budget compact 是可接受的 degraded strategy，但不能冒充 model-generated summary。
- compact prompt override 只能作为可配置能力，不能把私有 provider 参数写入默认源码。

## Assumptions

- 文档文件名固定为 `chipmate-codex-compaction-development-plan.md`。
- 该计划只覆盖 compaction，不重新展开全部 context parity。
- 当前 compaction scaffold 不再被标为完成 parity；只有 H4 这类 request 级 replacement-history / resume / stale evidence / visual fallback eval 证明的 capability 才能回填 Score 4。
- 后续实现必须保持 JSONL append-only，不删除原始 session message。
- 实现完成前，request-stage pruning 仍作为安全兜底保留。
- 文档中的 Codex baseline 来自公开源码中的可观察机制，不代表私有服务端实现细节。
