# Deep Code Understanding

This note documents the current ChipMate code-understanding retrieval path.

## Fast Path

Explicit graph questions keep the existing direct path:

- callers
- callees
- call-chain
- references
- inspect-symbol

These questions skip the Understanding Planner and fall back to the existing local analysis evidence pack. This keeps narrow graph queries stable and avoids adding planning latency where the user already named the graph operation.

## Planner Path

Broad code-understanding questions use `UnderstandingPlanner` as an evidence planner. The planner does not answer the user directly. It returns a bounded `EvidencePlan` with:

- `templateId`
- `questionSummary`
- `concepts`
- `hypotheses`
- `tasks`
- `answerShape`
- `riskNotes`

Supported task types are:

- `semantic_search`
- `symbol_discovery`
- `module_map`
- `call_expansion`
- `call_chain`
- `reference_search`
- `state_machine_search`
- `config_search`
- `test_search`

The execution path is bounded and staged:

- discovery
- expansion
- gap follow-up
- aggregation

CodeGraph provides structure, Code RAG provides semantic recall, rerank orders candidates when available, and the model only plans and later summarizes evidence.

Mixed graph-and-understanding questions stay on the planner path. For example, a question that asks both "who calls X" and whether that affects performance is not treated as a narrow callers fast path, because the answer needs factor evidence and not only direct graph edges.

## Fallback Path

The existing `queryEvidence()` path remains the fallback when:

- planner output is invalid JSON
- required fields are missing
- the planner emits an unsupported task or template id
- task count exceeds the planner budget
- planner execution returns no evidence
- planner request times out

Fallback traces are included in the local understanding planner evidence block and also written to the Output Channel.

## Aggregated Factors

Planner execution is aggregated into factors with:

- label
- category
- supporting evidence
- confidence
- strength
- hypothesis flag
- gaps

Evidence-backed factors may be used as conclusions. Missing or weak factors must stay in a gaps or hypotheses section. Broad performance, root-cause, coverage, and state-flow answers should also include next-step validation suggestions.

The aggregation also extracts evidence-aware claims. A claim includes:

- claim text
- factor category
- evidence refs
- support level
- assumptions
- counter evidence
- confidence

Factor classification is evidence-aware. The task type is only a fallback; snippet content, symbol/path context, graph role, config terms, test terms, state terms, lock/IO/retry/cache/batch signals, and counter-evidence wording can move evidence into a more specific factor.

## Grounding Verifier

The grounding verifier checks structured answer drafts against retrieved evidence. It reports:

- missing citations on main conclusions
- citations that do not exist in retrieved evidence
- citations whose factor category does not match the conclusion
- hypotheses written as firm conclusions
- missing coverage-limit notices when indexes are partial

The repair step is bounded: it can remove or downgrade unsupported conclusions, move them to hypotheses, lower confidence for category mismatches, and add a coverage notice. If repair still cannot produce a grounded answer, the answer must say evidence is insufficient and prioritize confirmed facts plus gaps.

## Known Gaps

Static graph expansion can miss:

- callback edges
- function-pointer dispatch
- generated-code edges
- macro-expanded edges

When expansion evidence is empty, the aggregation adds an explicit static graph gap instead of pretending the relationship does not exist.

## Follow-Up Reuse

The chat path stores the previous planner audit after context construction. Follow-up planning receives the previous evidence plan, previous trace, and confirmed concepts so the next plan can continue from the same understanding context.

Follow-up planning also receives previous high-confidence evidence refs, previous gaps, previous claims, and any user corrections available in the follow-up context. The planner prompt tells the model to reuse that information only when the current question continues the same topic; topic switches must not inherit old evidence except as contrast.

## Debugging

The Output Channel logs:

- planner request and response byte counts
- planner result kind
- template id
- concepts
- fast-path and fallback reasons
- task and evidence counts
- phase trace
- factor summary
- artifact task and claim counts
- grounding verifier findings

Search for:

```text
[understanding-planner]
[understanding-planner-audit]
```

Planner artifacts are structured objects containing the plan, phase trace, task results, aggregation, claims, and verifier findings. They are attached to the chat-side planner audit so future debug panels or export commands can render the same evidence trail without scraping Output Channel text.

## Local Eval Gate

Run the targeted understanding eval with:

```bash
bun run eval:understanding
```

The eval fixtures check expected evidence categories rather than fixed answer text. Metrics cover evidence recall, answer grounding, latency budget, fallback reasons, and old-path versus planner-path evidence differences.

The targeted eval also includes real-world mini fixtures with gold evidence and forbidden evidence. Those fixtures execute the actual `UnderstandingPlanner -> executeEvidencePlan -> aggregateUnderstandingEvidence` path, then run claim extraction and grounding verification. A fixture fails closed when required gold evidence is missed, forbidden evidence is retrieved, the verifier fails, or the latency/grounding gates fail.
