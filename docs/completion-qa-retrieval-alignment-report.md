# Completion QA Retrieval Alignment Report

## Summary

P2.3 将 comment-guided C inline completion 的 evidence 检索从独立 completion ranking 路线切换为 shared repository evidence orchestrator。Completion 不使用 QA 的自然语言回答，只复用 QA 依赖的 repository evidence retrieval core，然后把 evidence 投影成短的 Qwen FIM context。

最终生成路径保持不变：

`sourceComment + selected evidence + current-prefix/current-suffix -> Qwen FIM inline completion`

## QA Retrieval Path

当前 QA/Chat 入口：

1. `RemoteChatViewProvider.sendMessage()`
2. `buildChatPrompt()`
3. `codeGraph.buildContext()` 和 `codeGraph.queryEvidence()`
4. `LocalCodeGraphService.queryEvidence()`
5. `queryEvidenceAsync()`
6. `retrieveHybridEvidence()`
7. graph candidates + vector candidates + rerank trace + evidence pack

QA 能找到相似函数的关键证据通常来自 `queryEvidence()` 返回的 `retrieval.evidence` 和 `evidencePack.evidence`，其中包含 `kind`、`score`、`reason`、`path`、`startLine/endLine`、`snippet` 和 `trace.steps`。

## Completion Retrieval Path Before P2.3

comment-guided completion 之前的路径：

1. `planCompletion()`
2. `completionRetrievalPlan()`
3. `findSymbols()`
4. `buildCEmbeddedCompletionEvidence()`
5. completion-specific comment-guided ranking / graph fallback
6. `buildQwenCoderFimPrompt()`

问题是 completion 维护了独立 retrieval/ranking 逻辑，导致 QA 能找到的候选和 completion evidence TopK 可能不同。

## Shared Core After P2.3

新增共享入口：

`retrieveRepositoryEvidenceForIntent(input)`

输入包含：

- `mode`: `qa` 或 `completion`
- `task`: `comment-guided-code`、`member-access`、`call-args` 等
- `sourceComment`
- `currentFile`
- `currentFunction`
- `prefix`
- `suffix`
- `nearbyIdentifiers`
- `maxEvidence`
- `latencyBudgetMs`

共享入口构造 repository evidence query，并调用现有 `CodeGraphContextProvider.queryEvidence()`。在本地服务中，这条路线进入 `LocalCodeGraphService.queryEvidence() -> queryEvidenceAsync() -> retrieveHybridEvidence()`，复用 QA 依赖的 graph/vector/rerank/evidence pack 核心。

Completion mode 只做短投影：

- 保留 code-like evidence。
- 排除当前函数自身，避免把正在补的函数当 similar function。
- 限制 evidence 数量和字节数。
- 不注入 QA suggested answer 或自然语言答案。

## Alignment Telemetry

completion telemetry 和 benchmark dump 新增：

- `qaAlignedEvidence`
- `qaTopCandidate`
- `completionTopCandidate`
- `sharedTopCandidate`
- `qaRetrievalTopK`
- `completionRetrievalTopK`
- `alignmentReason`
- `rerankEnabled`
- `ragAvailable`
- `latencyBudgetMs`
- `maxEvidence`
- `timeoutStage`

`alignmentReason` 用来解释差异，例如：

- `aligned`
- `latency-budget`
- `max-evidence`
- `token-budget`
- `rerank-disabled`
- `rag-unavailable`
- `graph-only-fallback`
- `not-in-index`
- `projection-trimmed`

## Fixture Comparison

Benchmark fixture: `generic-c-comment-guided-nfc-clock-reset-ranking`

Observed mock dry-run behavior:

- `actualPlanKind=comment-guided-c-code`
- `promptKind=qwen-fim`
- `current-prefix/current-suffix/source-comment` preserved
- completion prompt contains shared evidence for the expected similar function
- `qaRetrievalTopK` contains the expected similar function
- `completionRetrievalTopK` contains the expected similar function

In the mini benchmark graph, RAG/rerank is unavailable, so exact ranking can differ from real QA. The report records this as `ragAvailable=false`, `rerankEnabled=false`, and an `alignmentReason` such as `rag-unavailable` or `projection-trimmed`.

## Prompt Delivery

Completion prompt contains only structured code evidence blocks, for example:

- `C evidence: c-comment-semantic-match`
- `Source: path:line`
- `Reason: ...`
- `Code:`

The final prompt must also contain:

- `source-comment`
- `current-prefix`
- `current-suffix`

QA natural language answer text is not inserted into completion prompt.

## Non-Goals

P2.3 does not:

- add hard gates
- modify reject or quality gates
- implement prompt v2
- hardcode fixture function names, comment text, or paths in production logic
- paste QA final answers into inline completion

## Remaining Risks

- If RAG/vector/rerank is unavailable, completion and QA share the graph-only evidence pool; this can still rank broad same-module or domain-only evidence above a better semantic function. Telemetry now makes this visible through `rerankEnabled=false`, `ragAvailable=false`, and TopK comparison.
- If latency budget expires, completion falls back to graph-only evidence and records `timeoutStage`.
- Completion uses fewer evidence items than QA, so a correct QA candidate can be omitted by `maxEvidence` or token budget; this is reported through `alignmentReason`.

## Next Step

Use direct Qwen or UI smoke tests to compare:

- QA `qaRetrievalTopK`
- completion `completionRetrievalTopK`
- final FIM prompt evidence
- final ghost text

If the correct function appears in both TopK but Qwen still emits a weak local delay/poll snippet, the next fix should target evidence projection quality or prompt v2. If the correct function does not appear in shared TopK, the next fix should target parser/index/RAG/rerank quality.
