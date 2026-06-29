# ChipMate Goal 与 Codex Goal 完全对齐开发计划

## 目标

本计划用于把 ChipMate Goal 从“已具备主要持久目标能力”推进到“与 Codex Goal 机制语义等价”。目标不是只补 UI，也不是把 goal 当作普通待办标签，而是完整对齐 Codex 的 thread-level persistent goal：

- 目标状态独立于普通聊天消息持久化。
- 模型可见 `get_goal` / `create_goal` / `update_goal` 工具。
- 用户可 create / edit / pause / resume / clear。
- active goal 在 thread idle 后自动 continuation。
- token/time/tool/turn accounting 与 budget limit 可追踪。
- provider error / usage limit / abort / resume 有明确状态流转。
- 重新打开 thread 或 extension host 重启后，active goal 能恢复运行；paused / blocked / usage_limited goal 能提示用户 resume。
- continuation 不污染普通 user history，但模型仍能基于已有聊天、工具结果、当前 worktree 和 goal objective 继续工作。

## Codex 参考来源

开发时以以下 Codex 开源实现为准：

- Goal model: `codex-rs/state/src/model/thread_goal.rs`
- Goal state store/accounting SQL: `codex-rs/state/src/runtime/goals.rs`
- Goal extension lifecycle: `codex-rs/ext/goal/src/extension.rs`
- Goal runtime: `codex-rs/ext/goal/src/runtime.rs`
- Goal accounting state: `codex-rs/ext/goal/src/accounting.rs`
- Goal tools: `codex-rs/ext/goal/src/spec.rs`, `codex-rs/ext/goal/src/tool.rs`
- Goal app-server processor: `codex-rs/app-server/src/request_processors/thread_goal_processor.rs`
- TUI goal actions/menu: `codex-rs/tui/src/app/thread_goal_actions.rs`, `codex-rs/tui/src/chatwidget/goal_menu.rs`
- Prompt templates: `codex-rs/ext/goal/templates/goals/continuation.md`, `budget_limit.md`, `objective_updated.md`

ChipMate 当前实现入口：

- Goal state/runtime: `src/goal-runtime.ts`
- Tool surface: `src/tool-runtime.ts`
- Agent loop/continuation: `src/direct-agent-client.ts`
- Webview host: `src/chat-view.ts`
- Webview UI: `src/chat-html.ts`
- Public types/events: `src/types.ts`

## 当前对齐状态

## 实施进度

当前按 8 个 Phase 统计：

- 已完成：8/8
- 待完成：0/8

### Iteration 1: Thread Resume 与 Restart Recovery

状态：已完成。

完成内容：

- 新增 `DirectAgentClient.restoreGoalAfterSessionResume(sessionID)`，用于模拟 Codex `on_thread_resume` 后的 runtime restore。
- active goal 在 session resume / extension host reload 语义下会重新调度 internal continuation。
- paused / blocked / usage_limited goal 在 resume 后不会静默启动 continuation，保留给用户手动 resume。
- `chat-view` 在 refresh goal snapshot 后先 `postState()`，再调用 restore，确保 UI 先显示当前目标再开始自动续跑。
- 补充 DirectAgentClient restart recovery 测试，验证 continuation 不污染普通 user history。
- 补充 source-level history guard，固定 snapshot-before-restore 顺序。

验证结果：

- `bun test test/direct-agent-client.test.ts`
- `bun test test/chat-history.test.ts`
- `bun test test/chat-html.test.ts`
- `bun run compile`
- `bun run package`

### Iteration 2: Goal Accounting 完全对齐

状态：已完成。

完成内容：

- 将 `GoalRuntime` 从单一 active turn map 升级为 accounting state，区分 `currentTurnID`、active turn goal、idle goal、last usage、last accounted time 和 budget steering 去重标记。
- 对齐 Codex accounting mode 状态过滤：
  - `activeStatusOnly`: 只计 `active`
  - `activeOnly`: 计 `active` / `budget_limited`
  - `activeOrComplete`: 计 `active` / `budget_limited` / `complete`
  - `activeOrStopped`: 计 `active` / `paused` / `blocked` / `usage_limited` / `budget_limited`
- `restoreAfterSessionResume()` 会为 active goal 建立 idle marker，使重开后到下一次 mutation/turn 的时间可结算。
- `setGoal` / `pauseGoal` / `resumeGoal` / `clearGoal` 会在 mutation 前结算当前 active 或 idle goal progress。
- budget limit steering 对同一个 `goalID` 只注入一次，后续 token accounting 仍可继续累计到 `budget_limited` goal。
- `stopTurn()` 会在 active goal 仍未完成时切换为 idle marker，保持 turn 间 accounting 连续。
- 修正 `activeOrStopped` 不再错误统计 `complete` goal。

验证结果：

- `bun test test/direct-agent-client.test.ts`
- `bun test test/chat-history.test.ts test/chat-html.test.ts`
- `bun run compile`
- `bun run package`

### Iteration 3: Goal State Lock 与并发窗口

状态：已完成。

完成内容：

- 在 `DirectAgentClient` 增加 per-session `goalStateLocks` 与 `withGoalStateLock()`，把 goal mutation 串行化。
- 用户侧 create / set / pause / resume / clear / startGoalOperation 已接入 goal-state lock。
- 模型侧 `create_goal` / `update_goal` handler 已接入 goal-state lock。
- `restoreGoalAfterSessionResume()` 已通过 locked/unlocked 分层接入锁。
- automatic continuation 的 active goal read + controller/start operation 窗口已接入锁，避免读取旧 goal 后被 clear/edit 穿插再启动。
- `abortSession()` 内部 pause goal 的 mutation 已接入锁，避免和其它 goal mutation 并发错账。
- 补充 race 测试：
  - restore 后立即 edit，后续 continuation 使用新 objective，不使用旧 objective。
  - restore 后立即 clear，不启动旧 goal continuation。

验证结果：

- `bun test test/direct-agent-client.test.ts`
- `bun test test/chat-history.test.ts test/chat-html.test.ts`
- `bun run compile`
- `bun run package`

### Iteration 4: Abort / Cancel 语义对齐

状态：已完成。

完成内容：

- 新增 `GoalRuntime.abortTurn()`，普通 abort 只结算 active goal progress 并清理当前 turn marker，不再把 goal 改成 `paused`。
- `DirectAgentClient.abortSession()` 改为通过 `abortTurn()` accounting + finish operation；active goal 保持 `active`。
- `cancelGoalOperation()` 继续先 `pauseGoal()` 再 abort，因此 explicit goal operation cancel 会把 goal 置为 `paused`。
- 普通 abort 与 explicit goal cancel 的状态分界已接近 Codex extension/TUI 的分层语义：
  - turn abort：account + finish turn
  - cancel goal operation：pause goal + abort current turn
- 补充测试：
  - 普通 abort 不 pause active goal，operation 变 inactive，goal 仍 active。
  - explicit `cancelGoalOperation()` pause active goal，operation 变 inactive 且状态为 paused。

验证结果：

- `bun test test/direct-agent-client.test.ts`
- `bun test test/chat-history.test.ts test/chat-html.test.ts`
- `bun run compile`
- `bun run package`

### Iteration 5: Thread Goal Event 与 UI Snapshot 对齐

状态：已完成。

完成内容：

- 在 composer 内新增 `goalResumePrompt`，对 `paused` / `blocked` / `usage_limited` goal 显示明显恢复提示。
- 恢复提示提供 `Resume` 和 `Clear` 操作，复用现有 `resumeGoal` / `clearGoal` host message，不新增普通 chat message。
- 恢复提示只消费 `state.goal`，不会把 objective 写入 user history。
- 保留现有 `goalSummaryBanner`，继续显示当前 objective、status、usage 和 running turn badge。
- 恢复提示使用现有 Liquid Glass chip/button 体系，图标和按钮均使用 flex/inline-flex 正常文档流布局，不使用 `position:absolute`。
- 补充 source-level 测试，固定：
  - `goalResumePrompt` DOM 存在。
  - `renderGoalResumePrompt()` 只在 paused / blocked / usage_limited 显示。
  - `Resume` / `Clear` 按钮走 `data-goal-action`。
  - prompt 不污染普通 chat history。

验证结果：

- `bun test test/chat-html.test.ts test/chat-history.test.ts`
- `bun test test/direct-agent-client.test.ts`
- `bun run compile`
- `bun run package`

### Iteration 6: Prompt Template 完全对齐

状态：已完成。

完成内容：

- 以 Codex goal templates 的当前语义审计 `continuation`、`budget_limit`、`objective_updated` 三类 internal steering。
- 将 `continuation` prompt 扩展为 Codex-grade 执行约束：
  - goal across turns，不因单轮结束缩小目标。
  - current worktree / external state 优先于记忆。
  - `update_plan` 可用时用于多步进度可见性。
  - 明确 fidelity 约束，不能把目标降级成更小、更容易测试的替代目标。
  - completion audit 必须逐项证明 requirement、artifact、command、test、gate、invariant、deliverable 已满足。
  - blocked audit 必须满足同一 blocker 连续三轮，blocked goal resume 后重新开始 blocked audit。
- 审计 `budget_limit` prompt，确认其继续要求模型停止新实质工作，只收口 progress / remaining work / blockers，并且只有真实完成才能 `update_goal complete`。
- 审计 `objective_updated` prompt，确认新 objective supersedes old objective，不继续只服务旧目标的工作。
- 补充 source-level runtime 测试，固定 continuation prompt 的 completion audit、blocked audit 和 budget-complete 边界。

验证结果：

- `bun test test/direct-agent-client.test.ts`：142 pass。
- `bun test test/chat-history.test.ts test/chat-html.test.ts`：92 pass。
- `bun run compile`
- `bun run package`

### Iteration 7: Tool Surface 与权限边界审计

状态：已完成。

完成内容：

- 对照 Codex `spec.rs` / `tool.rs` 审计 `get_goal` / `create_goal` / `update_goal` 工具定义和结果形状。
- `get_goal` 描述补齐 status、budgets、token usage、elapsed-time usage、remaining token budget。
- `create_goal` 描述补齐 Codex 权限边界：
  - 仅在 user 或 system/developer instructions 显式要求时创建。
  - 不从 ordinary tasks 推断 goal。
  - 只有显式要求 token budget 时才设置 `token_budget`。
  - unfinished goal 存在时失败，complete 后可创建新 goal。
- exposed schema 只暴露 Codex-style `token_budget`，不再把内部 camelCase `tokenBudget` 暴露给模型；runtime 仍可兼容 host/UI 的 camelCase 输入。
- `update_goal` 描述补齐 Codex blocked / complete 边界：
  - complete 只在 objective achieved 且 no required work remains 时使用。
  - blocked 必须同一 blocking condition 连续至少三轮，且真实 impasse。
  - blocked resume 后重新开始 blocked audit。
  - 不因 budget nearly exhausted 或 stopping work 标 complete。
  - 不允许模型 pause / resume / clear / budget-limit / usage-limit。
- `update_goal complete` 的 accounting mode 对齐 Codex `ActiveOrComplete`，`blocked` 继续使用 `ActiveOrStopped`。
- `completionBudgetReport` 对齐 Codex：完成后返回让模型基于 structured `goal.tokensUsed` / `goal.tokenBudget` / `goal.timeUsedSeconds` 汇报最终用量的 instruction，而不是拼接一个固定英文预算句。
- 补充 source-level / runtime 测试，固定：
  - goal tool schema 只暴露 `token_budget`。
  - `update_goal` 只允许 `complete` / `blocked`。
  - create / update description 包含显式 goal 创建、三轮 blocked audit、fresh blocked audit、budget exhaustion 非完成条件、用户/系统控制 status 的语义。
  - `completionBudgetReport` 返回 structured-fields instruction。

验证结果：

- `bun test test/direct-agent-client.test.ts`：142 pass。
- `bun run compile`

### Iteration 8: Long Objective 与 Goal Materialization

状态：已完成。

完成内容：

- 对照 Codex TUI `goal_files.rs` / `thread_goal_actions.rs`，将超长 objective 从“直接拒绝”改为附件物化。
- 4000 字符以内的 objective 继续直接存入 `ThreadGoal.objective`。
- 超过 4000 字符的 objective：
  - 写入 `globalStorage/goals/attachments/<id>/goal-objective.md`。
  - `ThreadGoal.objective` 保存短引用：要求读取该目标文件后继续。
  - 短引用继续通过 `MAX_THREAD_GOAL_OBJECTIVE_CHARS` 校验，保持持久 state 小而稳定。
- `continuation`、`budget_limit`、`objective_updated` internal steering 会在构造 prompt 前读回完整 objective，因此模型 continuation 不会只看到短引用。
- `GoalRuntime.goalForDisplay()` 会读回完整 objective，供 DirectAgentClient 的 `goal.updated`、公开 `getGoal()`、operation objective 和 Webview edit/summary 使用。
- `create_goal` / `setGoal` 的长 objective 路径不写普通 user message，不污染普通 chat history。
- 补充 runtime 测试，固定：
  - 长 objective 落盘为 `goal-objective.md`。
  - 持久 goal objective 是 4000 字符以内的短引用。
  - display/edit 路径读回完整 objective。
  - continuation prompt 和 objective-updated steering 使用完整 objective，而不是短引用。

验证结果：

- `bun test test/direct-agent-client.test.ts`：146 pass。
- `bun run compile`

| 能力点 | 当前状态 | 对齐度 | 必须补齐 |
|---|---|---:|---|
| Goal 状态模型 | 已有 `active/paused/blocked/usage_limited/budget_limited/complete` 与 usage/time/budget 字段 | 5/5 | 保持现有类型，补行为测试 |
| Goal 持久化 | `globalStorage/goals/thread-goals.jsonl` append-only store，已补重放恢复与 goal-state lock 测试 | 5/5 | 保持 append-only replay 回归测试 |
| 模型工具 | 已有 `get_goal/create_goal/update_goal`，schema、权限描述、update accounting mode、completionBudgetReport 已按 Codex tool contract 审计并加测试 | 5/5 | 保持 tool surface 回归测试 |
| Prompt templates | continuation 已补 Codex-grade progress visibility、fidelity、completion audit、blocked audit；budget/objective updated 已审计 | 5/5 | 后续随 Codex upstream template 变更再审计 |
| 创建输入模式 | Goal button 进入目标输入模式，发送 prompt 创建 goal；webview state 持久化 `goalInputMode`，goal mode 发送走 `createGoal` 而非普通 chat | 5/5 | 保持 composer source-level 回归测试 |
| 当前目标可见性 | 已有 composer summary banner、goal popover、paused/blocked/usage_limited resume prompt | 5/5 | 保持 UI 回归测试 |
| idle continuation | 已有 `scheduleGoalContinuation()`、internal turn、resume 后 active goal 自动 continuation，且 continuation prompt 对齐 Codex audit 语义 | 5/5 | 保持 restart/continuation 回归测试 |
| 手动 resume | `resumeGoal()` 会置 active 并调度 continuation，保留 goalID、tokensUsed、timeUsedSeconds；blocked resume audit 由 continuation prompt 重新开始 | 5/5 | 保持 resume progress 回归测试 |
| 错误中断 | provider non-retryable error 标记 `blocked`；retryable usage/rate-limit 错误耗尽后标记 `usage_limited` | 5/5 | 保持 provider error / usage limit 回归测试 |
| 用户取消/abort | 普通 abort 只 accounting/finish，不 pause；explicit goal operation cancel 才 pause | 5/5 | 保持回归测试 |
| 重启/重开恢复 | restore-after-session-resume 已接 UI snapshot、idle marker、goal-state lock；active 自动续跑，paused/blocked/usage_limited 不静默启动 | 5/5 | 保持 snapshot-before-restore 测试 |
| token/time accounting | 已有 Codex-style accounting state、idle marker、mutation 前 accounting、状态过滤和 budget steering 去重 | 5/5 | 保持 stale expectedGoalID / idle accounting 测试 |
| 并发保护 | 已有 expectedGoalID、busy/timer guard、per-session goal-state lock，覆盖用户 mutation、模型 goal tool、restore 与 continuation start 窗口 | 5/5 | 保持 edit/clear race 回归测试 |
| budget limit | 已有 budget_limited、状态过滤、同一 goalID steering 只注入一次，completionBudgetReport 已对齐 structured usage instruction | 5/5 | 保持 budget/tool report 回归测试 |
| objective update | 已有 objective_updated steering，并通过 mutation-before-accounting 与 goal-state lock 保护 | 5/5 | 保持 edit active goal 后 continuation objective 测试 |
| 长 objective | 4000 字符以内直接保存；超长 objective 物化到 goal attachment，state 保存短引用，prompt/edit/display 读回完整 objective | 5/5 | 保持 materialization 回归测试 |
| 测试覆盖 | 已有 store/runtime/direct-agent/chat-html/history 主路径测试，并覆盖 restart/resume、abort、race、idle accounting、resume prompt、prompt template、tool surface、long objective materialization | 5/5 | 后续随真实 VS Code 体验补端到端截图/日志 |

## 关键语义判定

### 1. Resume 是否丢进度

不应丢。ChipMate 完全对齐后的 resume 必须保留：

- `goalID`
- `objective`
- `tokensUsed`
- `timeUsedSeconds`
- 已有 assistant/user/tool history
- 当前 worktree / 文件系统状态
- 已完成工具结果和已落盘 artifact

resume 不是恢复模型隐藏思考链，而是让下一次 continuation 基于持久 thread state、聊天记录、工具结果、当前外部状态和完整 objective 继续工作。Codex 也是这个机制。

### 2. 哪些断点必须可恢复

- provider 非重试错误或重试耗尽：goal 变 `blocked`，用户点 resume 后重新 active 并续跑。
- usage limit：goal 变 `usage_limited`，用户点 resume 后重新 active 并续跑。
- token budget 达到：goal 变 `budget_limited`，不再启动新实质工作，只允许收口或用户编辑/新建。
- 用户显式 pause：goal 变 `paused`，resume 后继续。
- 普通 turn abort：对齐 Codex extension，先 accounting 并结束当前 turn；是否 pause 由 UI 的 explicit goal-operation cancel 决定。
- extension host 重启或重新打开 thread：如果 goal 仍 `active`，恢复 idle active marker 并在 thread idle 后自动 continuation。
- 重新打开 paused / blocked / usage_limited thread：显示 resume prompt 或醒目的 resume affordance，不静默启动。

### 3. 什么不应该恢复

- 不恢复模型隐藏 reasoning。
- 不把 continuation 写成普通 user message。
- 不用 goal objective 替换或压缩已有聊天历史。
- 不因 budget_limited 自动开始新一轮实质工作。
- 不让模型工具 pause/resume/clear/budget-limit；这些由用户或系统控制。

## 开发阶段

### Phase 1: Thread Resume 与 Restart Recovery

目标：补齐 Codex `on_thread_resume -> restore_after_resume -> on_thread_idle -> continue_if_idle` 的等价链路。

实现计划：

1. 在 `DirectAgentClient` 增加 goal restore 入口，例如 `restoreGoalAfterSessionResume(sessionID)`。
2. 该入口读取持久 goal：
   - `active`：标记 idle active goal，刷新 operation snapshot，受 busy/provider/tools-visible gate 保护后调度 continuation。
   - `paused/blocked/usage_limited`：不自动启动，向 webview 暴露 resume prompt 状态。
   - `budget_limited/complete`：不启动 continuation，必要时 finish operation。
   - no goal：清理 operation/timer。
3. 在 session load、webview reconnect、extension host 初始化后的 session hydration 路径调用 restore 入口。
4. 保证 state 先 post 到 webview，再启动 continuation，避免用户看不到当前 goal 就开始跑。
5. 如果 provider 未连接或 tools 不可用，不启动 continuation，只显示可恢复状态和错误/连接提示。

验收标准：

- 新建 client 实例复用同一 `globalStorage` 和 session JSONL 时，active goal 会自动续跑。
- paused/blocked/usage_limited goal 重开后只提示 resume，不自动跑。
- complete/budget_limited goal 重开后不跑。
- continuation 仍不新增普通 user message。

### Phase 2: Goal Accounting 完全对齐

目标：把当前 per-turn accounting 升级为 Codex 风格 accounting state。

实现计划：

1. 在 `GoalRuntime` 内引入 `GoalAccountingState`：
   - `currentTurnID`
   - `activeTurnGoalID`
   - `idleGoalID`
   - `lastUsageTotal`
   - `lastAccountedAt`
   - `budgetLimitReportedGoalID`
2. 对齐 Codex accounting mode：
   - `activeStatusOnly`: 只计 `active`
   - `activeOnly`: 计 `active` 和 `budget_limited`
   - `activeOrComplete`: 计 `active`、`budget_limited`、`complete`
   - `activeOrStopped`: 计 `active`、`paused`、`blocked`、`usage_limited`、`budget_limited`
3. 在以下位置结算 progress：
   - turn start
   - stream usage / estimated usage
   - tool finish
   - turn stop
   - turn abort
   - turn error
   - external goal mutation 前：edit/pause/resume/clear/set
   - idle restore / session resume
4. tool finish 只统计：
   - completed tools
   - handler 已执行且失败的 tools
   - 排除 `update_goal`
5. budget_limited steering 对同一个 goalID 只注入一次。

验收标准：

- stale `expectedGoalID` 不错账。
- paused/blocked/usage_limited resume 前后的 time/token 账可追踪。
- tool failure 不会无条件计入，只有实际执行过才计。
- budget_limited 后不会重复塞 budget prompt。

### Phase 3: Goal State Lock 与并发窗口

目标：补齐 Codex `goal_state_lock` 的语义，避免用户 mutation 与 automatic continuation 抢状态。

实现计划：

1. 为每个 session 增加 goal mutation/continuation lock。
2. 以下流程必须持有锁：
   - create/set/edit/pause/resume/clear
   - restore-after-resume
   - continue-if-idle read active goal + start turn window
   - tool-side create/update goal
3. `continue_if_idle` 读取 active goal 到实际启动 internal turn 之间，不能被 clear/edit/resume 穿插导致旧 goal 续跑。
4. 所有 accounting 都带 `expectedGoalID`。

验收标准：

- 用户 clear goal 与 timer continuation 同时发生时，不会启动旧 goal turn。
- 用户 edit active goal 时，不会出现旧 objective 的 continuation。
- tool update complete 与外部 clear 并发时，不会产生错误 operation 状态。

### Phase 4: Abort / Cancel 语义对齐

目标：区分 Codex extension 的 turn abort 与 ChipMate UI 的 goal operation cancel。

实现计划：

1. `abortSession(sessionID)`：
   - 普通 abort：account active progress，finish current turn，清 controller。
   - 不默认把 goal 标记为 paused。
2. `cancelGoalOperation(sessionID)`：
   - 这是用户明确取消整个 goal operation。
   - 先把 active goal 标记为 `paused`，再 abort 当前 turn。
   - finish operation 并发出 `goal.operation.finished`。
3. UI 上文案区分：
   - Stop current turn
   - Pause goal
   - Cancel goal operation

验收标准：

- 普通 stop 不会静默改 goal status。
- explicit goal cancel 会 pause，resume 能继续。
- abort 后不会留下 busy operation。

### Phase 5: Thread Goal Event 与 UI Snapshot 对齐

目标：让 webview 始终能看到当前 goal 与 operation 状态，且状态顺序与 Codex app-server snapshot 思路一致。

实现计划：

1. `goal.updated`、`goal.cleared`、`goal.operation.started`、`goal.operation.finished` 保持专用事件。
2. session resume 时先 post 当前 goal snapshot，再启动 continuation。
3. webview 增加 paused/blocked/usage_limited 的 resume prompt：
   - 显示 objective 摘要。
   - 明确 resume 会继续该目标。
   - 不自动把 blocked 当作 complete。
4. `goalSummaryBanner` 继续显示所有未清除 goal：
   - status label
   - objective 摘要
   - token/time
   - running turn badge
5. complete goal 的 `New` 只进入 goal input mode，不直接创建。

验收标准：

- active goal 重开后，用户先看到 goal，再看到 continuation 运行。
- blocked goal 重开后，有明显 resume 入口。
- goal events 不进入普通 chat history。

### Phase 6: Prompt Template 完全对齐

目标：让 continuation、budget limit、objective updated 三类 steering 与 Codex template 语义一致。

实现计划：

1. 以 Codex templates 为母版，替换产品名为 ChipMate。
2. `continuation` 必须包含：
   - goal persists across turns
   - keep full objective intact
   - current worktree/external state authoritative
   - progress visibility
   - fidelity constraints
   - requirement-by-requirement completion audit
   - strict three-consecutive-turn blocked audit
3. `budget_limit` 必须要求：
   - 不开始新实质工作
   - 收口 progress / remaining work / blockers
   - 只有真实 complete 才可 `update_goal complete`
4. `objective_updated` 必须要求：
   - 新 objective supersedes old objective
   - 避免继续只服务旧目标的工作

验收标准：

- template source-level tests 覆盖关键段落。
- continuation turn 的最后一条 request message 是 internal steering，不是普通 user message。

### Phase 7: Tool Surface 与权限边界审计

目标：确保模型工具与 Codex tool contract 完全一致。

实现计划：

1. `get_goal`：
   - 无 goal 返回 `goal: null`
   - 返回 `remainingTokens`
   - 返回 token/time usage
2. `create_goal`：
   - 仅显式要求时使用。
   - unfinished goal 存在时失败。
   - complete 后可创建新 goal。
   - `token_budget` 仅用户显式要求时设置。
3. `update_goal`：
   - 只允许 `complete` / `blocked`
   - blocked 必须三次连续 blocker audit
   - 不允许 pause/resume/clear/budget/usage limited
   - complete 时返回 final budget report
4. tools disabled 时不暴露 goal tools。
5. 没有持久 session state 时不允许 create goal；若 ChipMate 所有 chat session 都可 materialize，则用测试证明。

验收标准：

- 参数别名、错误信息、返回 JSON shape 均有测试。
- tool disabled 场景没有 goal tool definition。

### Phase 8: Long Objective 与 Goal Materialization

目标：补齐 Codex TUI 对超长 goal 的处理能力。

实现计划：

1. 保留 `ThreadGoal.objective` 的 4000 字符持久 state 上限。
2. 实现 Codex 风格 materialization：
   - 超长 objective 写入 goal attachment / local goal file。
   - thread goal 保存短引用。
   - continuation / budget_limit / objective_updated prompt 能安全读取完整 objective。
   - UI display / edit 路径能读回完整 objective。
3. 防止 goal file 被当作普通 user message 或普通 RAG 文档污染。

验收标准：

- 4000 字符以内走普通 goal。
- 超长 goal 可 materialize，持久 state 只保存短引用，prompt/edit/display 可读取完整 objective。

## 实现顺序

1. Phase 1: thread resume / restart recovery。
2. Phase 2: accounting state 与 accounting mode 对齐。
3. Phase 3: goal state lock 与并发保护。
4. Phase 4: abort / cancel 语义拆分。
5. Phase 5: UI snapshot、resume prompt、operation state。
6. Phase 6: prompt templates 完全对齐。
7. Phase 7: tool surface 审计与边界测试。
8. Phase 8: long objective materialization。

优先级理由：断点恢复是当前最大不齐点；accounting 和 locking 是恢复机制可靠性的基础；UI 和 prompt 是行为可见性与模型执行质量；long objective 是高级 parity，可以最后补。

## 测试计划

### Store / Runtime Tests

- active goal 未完成时 `create_goal` 失败。
- complete 后可创建新 goal，并重置 usage。
- `expectedGoalID` 不匹配时不结算旧 goal。
- accounting mode 与 Codex 状态过滤一致。
- budget 达到后进入 `budget_limited`。
- budget steering 同一 goalID 只注入一次。
- external mutation 前会结算 active/idle progress。

### DirectAgentClient Tests

- active goal 在普通 assistant turn 后自动 continuation。
- continuation 不写普通 user message。
- 模型 `update_goal complete` 后停止 continuation。
- provider error 后 goal 变 `blocked`。
- usage limit 后 goal 变 `usage_limited`。
- explicit goal cancel 后 goal 变 `paused`。
- 普通 abort 不默认 pause goal。
- 新 DirectAgentClient 实例复用同一 storage 后，active goal 自动恢复 continuation。
- paused/blocked/usage_limited goal 重开后只显示 resume prompt，不自动跑。
- clear/edit 与 continuation timer 并发时不启动旧 goal。

### Tool Tests

- `get_goal` 无 goal 返回 `goal: null`。
- `create_goal` 返回 active goal 和 `remainingTokens`。
- unfinished goal 存在时 `create_goal` 失败。
- `update_goal complete` 返回 `completionBudgetReport`。
- `update_goal paused/active/budget_limited/usage_limited` 被拒绝。
- tools disabled 时不暴露 goal tools。

### UI Tests

- 无 goal 点击 Goal 进入 `goalInputMode`。
- goal mode 下发送 post `createGoal`，不是 `sendMessage`。
- active goal 显示 `goalSummaryBanner` objective 摘要。
- paused/blocked/usage_limited 重开后显示 resume affordance。
- Goal 和 summary 点击打开详情 popover。
- complete goal 的 `New` 进入 goal input mode。
- goal events 不污染普通 chat history。
- 相关图标布局不使用 `position:absolute`。

### Restart / Recovery Integration Tests

- 创建 active goal 后销毁 client，再用同一 storage 新建 client 和同一 sessionID，验证自动 continuation。
- 创建 blocked goal 后重开，验证不会自动 continuation，点击 resume 后继续。
- 创建 paused goal 后重开，验证 resume 后 goalID/usage 不变。
- 创建 active goal 后 extension/webview reload，验证先收到 goal snapshot，再收到 operation started。

## 验证命令

实现完成后至少运行：

```bash
bun test test/direct-agent-client.test.ts
bun test test/chat-html.test.ts test/chat-history.test.ts
bun run compile
bun run package
```

如果改动涉及 VS Code 实装体验，再运行：

```bash
bun run vsix
```

打包前后必须遵守本仓库 provider/RAG 私有默认值规则，不能把私有 endpoint 或模型写入 tracked source。

## 最终验证记录

当前 8/8 Phase 完成后的验证结果：

- `bun test test/direct-agent-client.test.ts`：146 pass。
- `bun test test/chat-history.test.ts test/chat-html.test.ts`：92 pass。
- `bun run compile`：通过。
- `bun run package`：通过。
- `bun run vsix`：生成 `chipmate-0.1.0-build.255.vsix`。
- 私有 provider endpoint / 私有 chat model tracked-source grep：无命中。

## 完成定义

只有满足以下条件，才认为 ChipMate Goal 与 Codex Goal 机制在当前 scope 内完全对齐：

- active goal 可跨 ordinary turn 自动继续。
- active goal 可跨 extension host restart / session reopen 自动继续。
- paused/blocked/usage_limited 可重开后提示并手动 resume。
- resume 不丢 goalID、objective、usage、time、聊天上下文和 worktree 进度。
- continuation 不污染普通 user history。
- 模型工具权限边界与 Codex 一致。
- accounting、budget、error、abort、tool finish 行为有测试覆盖。
- UI 始终显示当前 goal 和 operation 状态。
- `bun run package` 通过。
