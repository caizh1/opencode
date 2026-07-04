# Deep Code Understanding Roadmap

## Goal

提升 ChipMate 对宽泛代码理解问题的回答质量，尤其是性能因素、根因分析、模块职责、业务流程、架构影响面、状态迁移和优化建议类问题。

设计原则：

- [x] 不用代码正则承担开放语义分类。
- [x] 代码只识别少量高置信 fast path。
- [x] 其他问题默认进入 LLM Understanding Planner。
- [x] Planner 只生成证据计划，不直接生成最终结论。
- [x] 最终回答必须绑定 CodeGraph / Code RAG / 文档 / 工具证据。
- [x] 任何 planner 失败、超时、非法输出或证据不足，都必须回退到现有 `queryEvidence()` 路径。
- [x] v1 不替换现有明确查询能力，只旁路增强宽问题。

## V1: Gated Understanding Planner

- [x] 新增 `UnderstandingPlanner` 模块，输入用户问题、当前文件、相关路径、CodeGraph/RAG 状态，输出结构化 `EvidencePlan`。
- [x] 定义 `EvidencePlan` 类型，至少包含 `questionSummary`、`concepts`、`hypotheses`、`tasks`、`answerShape`、`riskNotes`。
- [x] 定义受支持的 planner task 类型：`semantic_search`、`symbol_discovery`、`module_map`、`call_expansion`、`call_chain`、`reference_search`、`state_machine_search`、`config_search`、`test_search`。
- [x] 新增保守 fast-path guard，只跳过 planner 处理明确的 callers、callees、call-chain、reference、inspect-symbol 查询。
- [x] 所有非 fast-path 聊天代码问题默认进入 planner。
- [x] Planner 输出必须经过 schema 校验；非法 JSON、未知 task、超预算、空任务全部触发 fallback。
- [x] Planner 设置短超时和最大 token 预算，超时直接 fallback。
- [x] Planner 第一版只用于生成证据任务，不改变最终回答 prompt 的安全边界。
- [x] 将 planner task 映射到现有 `codeGraph.queryEvidence()`、`findSymbols()`、`runAnalysisTool()` 和 `chipmate_search_code` 等能力。
- [x] 新增 planner trace：记录 `planner_used`、`fast_path_reason`、`fallback_reason`、`task_count`、`evidence_count`、`latency_ms`。
- [x] 对“哪些因素影响 GC 速度”类问题，输出按因素分组的 evidence pack，而不是只返回函数列表。
- [x] 保留现有 `queryEvidence()` 路径作为 fallback，不删除 `classifyQuestion()`。
- [x] 增加单元测试：明确 callers/callees/call-chain 不进 planner。
- [x] 增加单元测试：宽问题进入 planner，planner 失败后回退旧路径。
- [x] 增加单元测试：planner 输出非法 task 被拒绝。
- [x] 增加 fixture：`提升 GC 速度的因素有哪些` 应产生多类证据任务，而不是单一 `impact` 查询。
- [x] 运行 `bun test`。
- [x] 运行 `bun run lint`。
- [x] 运行 `bun run compile`。
- [x] 最终运行 `bun run package`。

## V2: Evidence Aggregation And Factor Modeling

- [x] 新增 `EvidenceAggregator`，将多任务 evidence 聚合为因素、模块、路径、配置、测试、状态、风险等组。
- [x] 定义 `UnderstandingFactor` 类型，包含 `label`、`category`、`supportingEvidence`、`confidence`、`gaps`。
- [x] 支持性能类默认因素框架：算法复杂度、调用频率、扫描范围、锁/并发、队列/调度、IO、缓存、批处理、配置阈值、错误重试、测试/benchmark。
- [x] 支持按 evidence 自动合并相同 symbol、相同路径、相近 snippet。
- [x] 对每个因素输出证据强度：direct、indirect、weak、missing。
- [x] 对无证据因素必须标注为 hypothesis，不允许写成确定结论。
- [x] 将 aggregated factors 注入最终回答 prompt。
- [x] 增加测试：宽问题答案必须包含 evidence-backed factors。
- [x] 增加测试：无证据假设不得进入确定结论区。
- [x] 增加测试：相同函数被多个任务命中时只保留合并后的引用。
- [x] 运行 `bun test`、`bun run lint`、`bun run compile`、`bun run package`。

## V3: Iterative Multi-Hop Retrieval

- [x] 支持 planner 分阶段执行：discovery phase -> expansion phase -> aggregation phase。
- [x] 第一阶段用 RAG/BM25/module map 找 seed concepts 和 seed symbols。
- [x] 第二阶段对 seed symbols 做有界 callers/callees/references/call-chain/state expansion。
- [x] 第三阶段按因素模型聚合证据。
- [x] 每轮 expansion 必须受 `maxDepth`、`maxFanout`、`maxTasks`、`maxEvidenceBytes` 限制。
- [x] 支持 task 去重，避免重复查询同一 symbol/path。
- [x] 支持 early stop：证据足够或预算耗尽时停止。
- [x] 支持 gap-driven follow-up：如果缺配置、测试、状态机或入口证据，自动补一个有限任务。
- [x] 增加 trace UI 或 audit 字段，展示每一跳的原因、输入、输出、截断情况。
- [x] 增加测试：多跳不会超过预算。
- [x] 增加测试：第二跳基于第一跳 seed 扩展，而不是凭空生成 symbol。
- [x] 增加测试：function pointer/callback/generated-code gap 会被标注。
- [x] 运行完整验证和 package。

## V4: Domain-Specific Understanding Templates

- [x] 为性能问题新增 template：performance-factor-analysis。
- [x] 为根因问题新增 template：root-cause-analysis。
- [x] 为架构问题新增 template：architecture-understanding。
- [x] 为模块职责问题新增 template：module-responsibility-map。
- [x] 为状态流问题新增 template：state-flow-understanding。
- [x] 为测试/覆盖问题新增 template：test-impact-analysis。
- [x] Template 只定义证据任务框架和回答结构，不 hardcode 项目词、函数名或业务字符串。
- [x] Planner 可以选择 template，但代码只校验 template id 是否受支持。
- [x] 每个 template 都必须声明所需 evidence 类型和缺失证据时的回答策略。
- [x] 增加 regression fixtures 覆盖 GC 性能、模块初始化、状态迁移、测试影响、配置阈值类问题。
- [x] 运行完整验证和 package。

## V5: Evaluation And Quality Gates

- [x] 建立宽问题 eval fixture 集，覆盖性能、架构、根因、影响面、状态机、测试和配置问题。
- [x] 每个 fixture 记录 expected evidence categories，而不是固定答案文本。
- [x] 增加 evidence recall 指标：关键 symbol、关键 path、关键 config、关键 tests 是否命中。
- [x] 增加 answer grounding 指标：最终答案每个主要结论是否有 evidence。
- [x] 增加 latency budget 指标：planner、retrieval、aggregation、answer generation 分阶段计时。
- [x] 增加 fallback 指标：planner invalid、timeout、insufficient evidence、budget exceeded。
- [x] 增加对比报告：old path vs planner path 的 TopK evidence 和答案结构差异。
- [x] CI 或本地 gate 中加入 targeted eval 命令。
- [x] 文档化可接受退化：明确 fast path 不应变慢或改变证据类型。
- [x] 运行完整验证和 package。

## V6: Mature Target

- [x] 默认启用 Understanding Planner，但明确 fast path 仍直接走旧路径。
- [x] Planner 支持多阶段、多跳、可观测、可回退的代码理解流程。
- [x] 宽问题答案稳定包含：因素分组、证据引用、置信度、缺口、下一步验证建议。
- [x] CodeGraph 负责结构关系，Code RAG 负责语义召回，rerank 负责候选排序，LLM 负责规划和归纳。
- [x] 所有开放语义判断来自 planner 的结构化输出，不由代码正则 hardcode。
- [x] 代码层只做安全校验、预算控制、工具执行、证据聚合、fallback 和 telemetry。
- [x] 支持用户追问时复用上一轮 evidence plan、trace 和已确认 concepts。
- [x] 支持把 planner trace 暴露给调试面板或 audit log，便于排查回答偏差。
- [x] 对大仓库保持 bounded retrieval，不因宽问题触发不可控扫描。
- [x] 文档更新：说明 fast path、planner path、fallback path、known gaps 和调试方法。
- [x] 完整运行 `bun test`、`bun run lint`、`bun run compile`、`bun run package`。

## Acceptance Criteria

- [x] 明确调用类问题的结果不因 planner 引入而退化。
- [x] 宽问题不再仅由 `classifyQuestion()` 决定检索模式。
- [x] Planner 失败时用户仍能收到旧路径结果。
- [x] “提升 GC 速度的因素有哪些”类问题能输出多因素、有证据、有缺口说明的答案。
- [x] 所有 planner 决策可追踪、可调试、可回放。
- [x] 没有在生产逻辑中 hardcode 具体现场函数名、路径、业务词或样例字符串。

## Review 2026-07-03

结论：V1-V6 已经把“宽问题进入 planner、多跳检索、证据聚合、fallback、trace、基础 eval”这条主线跑通，没有发现需要推翻当前架构的明显问题。但当前完成态更接近第一版闭环，仍有几个会直接影响真实宽问题回答质量的明显缺口，建议作为下一轮目标继续增强。

主要问题：

- [x] Eval 仍偏结构化和模拟化，能证明 planner/aggregation 形状存在，但不能充分证明真实仓库宽问题的召回、排序、最终答案质量。
- [x] Aggregation 主要按 task type 分桶，例如 `call_expansion` 进入调用频率、`config_search` 进入配置阈值，尚未充分理解 evidence snippet 本身表达的性能因素、根因关系或模块职责。
- [x] 当前 grounding 规则主要注入 prompt，缺少对最终回答的后置校验、自动修复和“无证据结论”拦截。
- [x] Fast path 仍由少量代码正则识别。虽然范围保守，但还缺少系统性的误入/漏入评估，尤其是混合问题，例如“谁调用 X，会不会影响性能”。
- [x] 对索引覆盖状态、RAG partial、CodeGraph 缺边、callback/function pointer/generated code 缺口的用户可见表达还不够强，容易让答案看起来比证据更确定。
- [x] Follow-up reuse 只传递上一轮 plan、trace、confirmed concepts，没有复用上一轮证据包、引用、缺口和用户纠正信息。
- [x] Trace 主要在 Output Channel/audit 文本中，缺少可视化、可回放、可导出的调试面板或结构化 artifact。
- [x] Planner task 执行仍偏串行和固定策略，缺少并行调度、按阶段预算、取消传播、低收益任务跳过和候选多样性控制。

## V7: Real-World Quality Evaluation

- [x] 建立真实或半真实 mini-repo eval fixture，覆盖性能因素、根因链路、模块职责、状态迁移、测试影响和配置阈值问题。
- [x] 每个 fixture 提供 gold evidence set，包括必须命中的 symbol、path、config、test、state、caller/callee/reference。
- [x] 每个 fixture 提供 forbidden evidence set，防止 planner 被相邻但无关的模块、同名符号、弱语义片段误导。
- [x] Eval 必须真实执行 `UnderstandingPlanner -> executeEvidencePlan -> aggregateUnderstandingEvidence`，不允许只用手工构造的 aggregation。
- [x] 增加最终答案评估：用 deterministic fake answer 或模型输出样本检查答案是否包含因素分组、引用、置信度、缺口和下一步验证建议。
- [x] 增加 old path vs planner path 对比报告，输出召回增益、噪声增量、遗漏项和 latency 增量。
- [x] 增加 “GC 速度因素” 真实 fixture，至少覆盖调用频率、扫描范围、锁/并发、配置阈值、测试/benchmark 和缺失 callback gap。
- [x] 将 `bun run eval:understanding` 升级为质量 gate：真实 fixture 失败时返回非零退出码。
- [x] 文档化 eval fixture 编写规范，要求 expected evidence categories 之外必须写 gold/forbidden evidence。
- [x] 运行 `bun run eval:understanding`、`bun test`、`bun run lint`、`bun run compile`、`bun run package`。

## V8: Evidence-Aware Factor And Claim Modeling

- [x] 新增 evidence-aware claim extractor，将 evidence snippet、symbol、path、tool type 转成结构化 `UnderstandingClaim`。
- [x] `UnderstandingClaim` 至少包含 `claim`、`factorCategory`、`evidenceRefs`、`supportLevel`、`assumptions`、`counterEvidence`、`confidence`。
- [x] Factor 分类不能只依赖 task type，必须结合 evidence 内容、symbol role、call graph role、config/test/context 元数据。
- [x] 支持一个 evidence 引用支撑多个 claim，也支持多个 evidence 合并成一个 claim。
- [x] 增加 counter-evidence 和 ambiguity 表达，例如“配置存在但未见运行时使用”“测试覆盖 happy path 但缺少压力场景”。
- [x] 对 performance template 增强因素识别：算法复杂度、热路径频率、扫描范围、锁竞争、IO/cache、batching、错误重试、配置阈值、benchmark 覆盖。
- [x] 对 root-cause template 增强因果链建模：触发条件、传播路径、状态变化、错误处理、恢复路径、验证证据。
- [x] 对 architecture template 增强模块边界建模：owner、入口、出口、依赖方向、数据流、跨层调用风险。
- [x] 增加测试：同一个 `call_expansion` evidence 不应无条件归为调用频率，必须能根据 snippet/metadata 归到锁、IO、错误重试等因素。
- [x] 增加测试：弱证据、反证和冲突证据必须降低 confidence，而不是被聚合成确定结论。
- [x] 运行 `bun test`、`bun run lint`、`bun run compile`、`bun run package`。

## V9: Answer Grounding Verifier And Repair

- [x] 定义最终回答结构契约：主要结论、证据引用、置信度、缺口、假设、下一步验证建议。
- [x] 在最终回答生成后增加 grounding verifier，检查每个主要结论是否绑定至少一个真实 evidence ref。
- [x] Verifier 必须识别无引用结论、引用不存在、引用与结论类别不匹配、把 hypothesis 写成确定结论等问题。
- [x] 对 verifier 发现的问题执行一次 bounded repair：降级为假设、移动到缺口区、补引用或删除无证据结论。
- [x] 如果 repair 后仍不合格，答案必须显式声明证据不足，并优先输出已证实事实和缺口。
- [x] 将索引覆盖状态写入 grounding 规则：RAG partial、CodeGraph indexing、graph-only、hybrid 等状态必须影响答案措辞。
- [x] 增加测试：模型输出无证据性能结论时会被降级或移除。
- [x] 增加测试：引用不存在或引用错配时会触发 repair。
- [x] 增加测试：partial index 状态下答案必须包含覆盖限制说明。
- [x] 运行 `bun test`、`bun run lint`、`bun run compile`、`bun run package`。

## V10: Planner Routing, Follow-Up Memory, And Observability

- [x] 增加 planner routing audit fixture，覆盖明确窄问题、宽问题、混合问题、追问、省略主语问题、多语言问题。
- [x] 对 fast path 增加 ambiguity guard：混合问题不应只因出现 callers/references 关键词就跳过 planner。
- [x] 对 fast path 增加 false positive/false negative 计数和本地 eval 输出。
- [x] Follow-up context 增加 previous evidence refs、previous gaps、previous claims、user-confirmed/corrected facts。
- [x] 追问 planner 必须能区分“继续上一轮主题”和“切换新主题”，避免旧 evidence 污染新问题。
- [x] 增加证据复用策略：上一轮高置信 evidence 可复用，但必须检查文件版本、索引状态或 snippet hash 是否仍有效。
- [x] Planner execution 增加并行调度和取消传播，discovery/search 类任务可并行，graph expansion 仍按 seed 和预算有界。
- [x] 增加候选多样性控制，避免 TopK evidence 全部来自同一文件、同一函数或同一弱语义匹配。
- [x] 生成结构化 planner artifact，包含 plan、phase trace、task results、aggregation、claims、verifier findings，可从 Output Channel 或调试面板导出。
- [x] 文档更新：说明 routing、follow-up reuse、coverage limits、verifier repair、debug artifact。
- [x] 运行 `bun run eval:understanding`、`bun test`、`bun run lint`、`bun run compile`、`bun run package`。
