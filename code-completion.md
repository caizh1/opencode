# CODE_COMPLETION_DEVELOPMENT_PLAN.md

## 0. 总目标

把当前 VS Code 插件的代码补全从“单次 FIM 调用 + 后处理补救”升级为产品级补全流水线。

目标模型是 qwen-coder30b0。

最终补全架构必须是：

1. CompletionPlanner
2. SymbolResolver
3. ContextRetriever
4. ContextPacker
5. ModelRouter
6. CompletionPostprocessor
7. InlineEditBuilder
8. Eval Fixtures + Regression Tests
9. Structured Debug Telemetry

最终行为目标：

* 高置信度时展示补全。
* 低置信度时不展示。
* 不展示 echoed prefix。
* 不重复当前注释。
* 不重复 line suffix，例如 `);`、`}`、`]`。
* 不把自然语言命令当普通 FIM 补全。
* 不让模型猜项目符号，先用 deterministic symbol resolution。
* 普通代码补全走 Qwen FIM。
* 注释转测试、自然语言命令走 instruction/edit prompt。
* 每一个 bug 都必须有 fixture 测试，之后不能回归。

## 1. 已知必须修复的两个问题

### Case 1

用户输入：

```text
unit test for epr_ppn_raw_wr
```

当前行为：

```text
edit-rejected reason=echoed-prefix
```

实际项目里存在完整函数：

```text
epr_ppn_raw_write_with_cb_dfx
```

期望行为：

* `epr_ppn_raw_wr` 通过 SymbolResolver 命中 `epr_ppn_raw_write_with_cb_dfx`。
* 该行是 bare natural-language command。
* 插入策略是 `replace-whole-line`。
* 不能让模型 echo `unit test for epr_ppn_raw_wr`。
* 最终应替换整行，生成真实 unit test 代码。

### Case 2

用户输入：

```c
// unit test for epr_ppn_raw_write_cb_dfx()
```

当前行为：

```c
// unit test for epr_ppn_raw_write_cb_dfx()
```

补全输出重复了同一行注释。

期望行为：

* 该行是 comment-to-test intent。
* 插入策略是 `insert-after-line`。
* 保留用户原注释。
* 在下一行生成测试代码。
* 模型输出中如果重复注释，Postprocessor 必须剥掉重复注释。

## 2. 总体原则

### 必须做

* 先写测试，再修逻辑。
* 所有阶段必须能单独 review。
* 每个阶段完成后运行 test、lint、typecheck。
* 每个补全请求都要产出结构化 debug 信息。
* 每个 visible suggestion 都必须有合法 range、filterText、insertText。
* 对 Qwen FIM prompt，必须真正注入 retrieved snippets。
* 对 unit-test 场景，必须注入 target symbol definition 和 similar tests。
* 对自然语言命令，不能走普通 FIM。
* 对注释转测试，不能走普通 FIM。
* 对符号补全，优先 deterministic resolver，模型只做辅助。

### 禁止做

* 禁止针对 `epr_ppn_raw_write_with_cb_dfx` 写硬编码。
* 禁止只靠 prompt tweak 修 bug。
* 禁止所有场景共用一个 completion path。
* 禁止把 empty output 包装成 completion。
* 禁止展示 echoed-prefix。
* 禁止展示重复注释。
* 禁止在 middle-of-line 场景重复 suffix。
* 禁止把多行 edit range 设置成 inline completion range；VS Code inline range 必须单行。
* 禁止无测试改动生产逻辑。

## 3. 推荐文件结构

根据当前项目实际结构调整，但目标模块建议如下：

```text
src/
  completion.ts
  completion-plan.ts
  completion-symbol.ts
  completion-context.ts
  completion-router.ts
  completion-prompt.ts
  completion-normalize.ts
  completion-edit.ts
  completion-telemetry.ts

test/
  completion/
    completion-plan.test.ts
    completion-symbol.test.ts
    completion-context.test.ts
    completion-router.test.ts
    completion-normalize.test.ts
    completion-edit.test.ts
    completion-e2e.test.ts
    fixtures/
      c/
        symbol-abbrev/
        comment-to-test/
        natural-command/
        suffix-overlap/
        echoed-prefix/
        indentation/
```

不要求一次重命名所有文件。可以在现有文件基础上逐步抽模块，但最终必须形成上述职责边界。

## 4. 阶段 1：建立 Eval Fixtures，不改生产逻辑

### 目标

先让失败可复现。不要先修。

### Codex 任务

1. 检查项目测试框架。
2. 找到当前 completion pipeline 的入口。
3. 添加测试工具函数，能构造：

   * fake TextDocument
   * fake Position
   * linePrefix
   * lineSuffix
   * currentWord
   * fake retrieved snippets
   * fake model response
4. 添加以下 failing tests：

   * `unit test for epr_ppn_raw_wr` 不应得到 echoed-prefix。
   * `// unit test for epr_ppn_raw_write_cb_dfx()` 不应重复注释。
   * `epr_ppn_raw_wr` 应 resolve 到 `epr_ppn_raw_write_with_cb_dfx`。
   * 模型输出等于当前 prefix 时必须 reject 或 retry。
   * middle-of-line 补全不能重复 `);`。
   * 多行补全缩进必须匹配当前 block。
5. 加 debug snapshot assertion：

   * plan.kind
   * plan.insertMode
   * targetSymbol
   * currentWord
   * selectedCandidate
   * modelRoute
   * rawText
   * normalizedText
   * finalRange
   * filterText
   * rejectionReason

### 验收标准

* 测试能运行。
* 至少两个已知 bug 的测试当前失败。
* 没有为了让测试通过而改生产逻辑。
* 输出当前失败行为快照。

### 推荐 Codex prompt

```text
Start Phase 1 from CODE_COMPLETION_DEVELOPMENT_PLAN.md.

Do not fix production logic yet.

Add eval fixtures and failing tests that reproduce:
1. "unit test for epr_ppn_raw_wr" causing echoed-prefix.
2. "// unit test for epr_ppn_raw_write_cb_dfx()" duplicating the comment.
3. Abbreviated symbol "epr_ppn_raw_wr" should resolve to "epr_ppn_raw_write_with_cb_dfx".
4. Model output equal to current prefix should be rejected or retried.
5. Middle-of-line suffix overlap should not duplicate ");".
6. Multiline indentation should match current block.

Add test helpers if needed. Run test/lint/typecheck and report current failures.
```

## 5. 阶段 2：实现 CompletionPlanner

### 目标

先判断补全任务类型，再决定后续路径。

### 类型定义

```ts
export type CompletionPlanKind =
  | "ordinary-code"
  | "symbol-completion"
  | "comment-to-code"
  | "comment-to-test"
  | "natural-command"
  | "disabled";

export type CompletionInsertMode =
  | "replace-current-word"
  | "insert-at-cursor"
  | "insert-after-line"
  | "replace-whole-line";

export interface CompletionPlan {
  kind: CompletionPlanKind;
  insertMode: CompletionInsertMode;
  targetSymbol?: string;
  replaceCurrentWord: boolean;
  needsSymbolRetrieval: boolean;
  needsTestRetrieval: boolean;
  useFim: boolean;
  useInstruction: boolean;
  maxTokens: number;
  confidenceFloor: number;
}
```

### 规则

```text
"unit test for <symbol>" 
=> natural-command
=> replace-whole-line
=> useInstruction = true
=> useFim = false
=> needsSymbolRetrieval = true
=> needsTestRetrieval = true
=> maxTokens = 768 or 1024
```

```text
"// unit test for <symbol>()"
=> comment-to-test
=> insert-after-line
=> useInstruction = true
=> useFim = false
=> needsSymbolRetrieval = true
=> needsTestRetrieval = true
=> maxTokens = 768 or 1024
```

```text
"epr_ppn_raw_wr|"
=> symbol-completion if current token looks like identifier
=> replace-current-word
=> deterministic resolver first
=> useFim = false initially
```

```text
normal code context
=> ordinary-code
=> insert-at-cursor or replace-current-word depending current word
=> useFim = true
```

### 验收标准

* 所有 planner tests 通过。
* `unit test for epr_ppn_raw_wr` 不再被 planner 视为普通 FIM。
* `// unit test for xxx()` 不再被 planner 视为普通 FIM。
* planner 不调用模型。

### 推荐 Codex prompt

```text
Start Phase 2 from CODE_COMPLETION_DEVELOPMENT_PLAN.md.

Implement CompletionPlanner with explicit plan.kind and insertMode.

Rules:
- Bare "unit test for <symbol>" is natural-command and uses replace-whole-line.
- Comment "// unit test for <symbol>()" is comment-to-test and uses insert-after-line.
- Partial identifiers should become symbol-completion when appropriate.
- Ordinary code stays ordinary-code.
- Planner must not call the model.

Add and update tests. Run test/lint/typecheck.
```

## 6. 阶段 3：实现 SymbolResolver

### 目标

不要让模型猜项目符号。先确定目标符号。

### SymbolCandidate

```ts
export interface SymbolCandidate {
  name: string;
  kind: "function" | "method" | "macro" | "type" | "variable" | "unknown";
  signature?: string;
  filePath?: string;
  score: number;
  snippet?: string;
  source: "codeGraph" | "workspace" | "openDocument" | "retrievedSnippet";
}
```

### 匹配规则

排序优先级：

1. exact match
2. prefix match
3. snake_case abbreviation match
4. subsequence match
5. same file
6. same directory
7. function/method 优先，特别是 unit-test target
8. 最近打开或最近编辑文件优先，如果项目已有这类信息

必须支持：

```text
epr_ppn_raw_wr -> epr_ppn_raw_write_with_cb_dfx
wr -> write
cb -> cb 或 callback
dfx -> dfx
```

### scorer 伪代码

```ts
function scoreSymbol(query: string, name: string): number {
  const q = normalizeIdent(query);
  const n = normalizeIdent(name);

  if (!q || !n) return 0;
  if (q === n) return 10000;
  if (n.startsWith(q)) return 9000;

  const qTokens = q.split("_").filter(Boolean);
  const nTokens = n.split("_").filter(Boolean);

  let score = 0;
  let ni = 0;

  for (const qt of qTokens) {
    let found = false;

    while (ni < nTokens.length) {
      const nt = nTokens[ni++];

      if (nt === qt) {
        score += 1000;
        found = true;
        break;
      }

      if (nt.startsWith(qt)) {
        score += 700;
        found = true;
        break;
      }

      if (isAbbrev(qt, nt)) {
        score += 500;
        found = true;
        break;
      }
    }

    if (!found) score -= 600;
  }

  return score;
}

function isAbbrev(queryToken: string, nameToken: string): boolean {
  if (!queryToken || !nameToken) return false;
  if (nameToken.startsWith(queryToken)) return true;

  let qi = 0;
  for (const ch of nameToken) {
    if (ch === queryToken[qi]) qi++;
    if (qi === queryToken.length) return true;
  }
  return false;
}
```

### 验收标准

* `epr_ppn_raw_wr` 命中 `epr_ppn_raw_write_with_cb_dfx`。
* ambiguous symbol 返回 top N candidates，并有 score。
* no match 时不能伪造 symbol。
* symbol resolver 不调用模型。
* unit-test 场景优先 function/method。

### 推荐 Codex prompt

```text
Start Phase 3 from CODE_COMPLETION_DEVELOPMENT_PLAN.md.

Implement deterministic SymbolResolver.

It must use existing codeGraph/retrieved snippets/workspace symbols if available. Add fuzzy snake_case abbreviation scoring.

Required case:
"epr_ppn_raw_wr" must rank "epr_ppn_raw_write_with_cb_dfx" as the top candidate.

Do not hardcode this function name. Implement generic scoring.

Add tests for exact, prefix, abbreviation, ambiguous, and no-match cases. Run test/lint/typecheck.
```

## 7. 阶段 4：实现 ContextPacker

### 目标

让模型真正看到需要的上下文。

### Context blocks

```ts
export interface PackedContextBlock {
  kind:
    | "current-prefix"
    | "current-suffix"
    | "current-function"
    | "target-symbol"
    | "similar-test"
    | "include"
    | "open-tab"
    | "recent-file";
  title: string;
  filePath?: string;
  text: string;
  score: number;
  tokenEstimate: number;
}
```

### 不同场景的预算

```text
symbol-completion:
  small budget
  target symbol names and signatures only

ordinary-code:
  prefix/suffix
  current function
  imports/includes
  nearby symbols

comment-to-test:
  prefix/suffix
  target symbol definition
  target symbol signature
  similar tests
  test framework examples
  includes

natural-command:
  target symbol definition
  similar tests
  destination file context
  test framework examples
```

### Qwen FIM prompt 必须包含

对于 ordinary-code：

```text
<|fim_prefix|>...
<|fim_suffix|>...
<|fim_middle|>
```

对于带 retrieved context 的 FIM：

```text
<repo_context>
...
</repo_context>

<|fim_prefix|>...
<|fim_suffix|>...
<|fim_middle|>
```

对于 comment-to-test 和 natural-command，不走 FIM，走 instruction prompt：

```text
You are generating code for a VS Code inline completion.

Task:
Generate a unit test for the target symbol.

Rules:
- Do not repeat the user's current line.
- Do not output markdown.
- Do not explain.
- Output only code.
- Use the target symbol and similar tests from context.

Target symbol:
...

Similar tests:
...

Current file:
...
```

### 验收标准

* Qwen FIM prompt 中确实包含 retrieved target symbol。
* comment-to-test prompt 中确实包含 target symbol definition 和 similar tests。
* context packer 有 token budget，不会无限拼接。
* debug log 显示 selected/dropped context blocks。

### 推荐 Codex prompt

```text
Start Phase 4 from CODE_COMPLETION_DEVELOPMENT_PLAN.md.

Implement ContextPacker.

Requirements:
- Build structured context blocks.
- Inject target symbol and similar test snippets into prompts.
- Qwen FIM prompts must actually include retrieved snippets when available.
- comment-to-test and natural-command prompts must include target symbol definition and similar tests.
- Add token budget handling and debug logs for selected/dropped blocks.
- Add tests proving the prompt contains target symbol and similar tests.

Run test/lint/typecheck.
```

## 8. 阶段 5：实现 ModelRouter

### 目标

不同任务走不同模型调用方式。

### 路由规则

```text
ordinary-code
=> qwen-coder-fim
=> FIM prompt
=> maxTokens 128-256
=> temperature 0 or very low
```

```text
symbol-completion
=> SymbolResolver first
=> no model if symbol candidate is high confidence
=> optional model only for call arguments or surrounding syntax
=> maxTokens 64-128
```

```text
comment-to-test
=> instruction/edit prompt
=> no FIM
=> maxTokens 768-1024
```

```text
natural-command
=> instruction/edit prompt
=> no FIM
=> maxTokens 768-1024
```

### 验收标准

* `// unit test for xxx()` 不走 FIM。
* `unit test for xxx` 不走 FIM。
* ordinary-code 仍走 Qwen FIM。
* symbol-completion 高置信度时不调用模型。
* 每条 route 有测试。

### 推荐 Codex prompt

```text
Start Phase 5 from CODE_COMPLETION_DEVELOPMENT_PLAN.md.

Implement ModelRouter.

Rules:
- ordinary-code uses qwen-coder-fim.
- symbol-completion uses deterministic SymbolResolver first.
- comment-to-test uses instruction/edit prompt, not FIM.
- natural-command uses instruction/edit prompt, not FIM.
- Use separate maxTokens per plan kind.
- Add tests with mocked model responses.

Run test/lint/typecheck.
```

## 9. 阶段 6：重构 CompletionPostprocessor

### 目标

把模型 raw output 变成安全可展示的 insertText。

### 必须处理

1. markdown fence
2. explanation text
3. echoed prefix
4. repeated comment
5. suffix overlap
6. leading newline
7. trailing whitespace
8. indentation
9. empty output
10. low-confidence output

### 核心函数

```ts
export interface PostprocessInput {
  rawText: string;
  linePrefix: string;
  lineSuffix: string;
  plan: CompletionPlan;
  languageId: string;
  indent: {
    currentIndent: string;
    targetIndent: string;
    indentUnit: string;
  };
}

export interface PostprocessResult {
  text: string;
  rejected?: boolean;
  reason?: CompletionRejectReason;
}
```

### comment-to-test 规则

如果 raw output 是：

```c
// unit test for epr_ppn_raw_write_cb_dfx()
static void test_x(void) {}
```

最终必须变成：

```c
static void test_x(void) {}
```

然后 InlineEditBuilder 负责在注释后插入换行。

### natural-command 规则

如果 raw output 是：

```text
unit test for epr_ppn_raw_wr
```

必须 reject 或 retry，不能展示。

### suffix-overlap 规则

如果 lineSuffix 是：

```text
);
```

raw output 是：

```text
epr_ppn_raw_write_with_cb_dfx());
```

最终不能重复 `);`。

### 验收标准

* 重复注释被剥掉。
* echoed prefix 被 reject 或触发 retry。
* markdown 被剥掉。
* suffix overlap 被剥掉。
* empty output 不展示。
* 所有 rejection reason 有测试。

### 推荐 Codex prompt

```text
Start Phase 6 from CODE_COMPLETION_DEVELOPMENT_PLAN.md.

Refactor CompletionPostprocessor.

It must:
- Strip markdown fences.
- Strip explanations.
- Strip echoed prefix.
- Strip repeated comment prompts.
- Strip suffix overlap.
- Normalize indentation.
- Reject empty output.
- Reject output that only repeats the current line.
- Return structured rejection reasons.

Add tests for each behavior. Run test/lint/typecheck.
```

## 10. 阶段 7：实现 InlineEditBuilder

### 目标

根据 plan.insertMode 构造合法 VS Code inline completion item。

### 插入模式

```text
replace-current-word:
  range = current word range on same line
  insertText = replacement
  filterText = full replacement or normalized replacement

insert-at-cursor:
  range = zero-width range at cursor
  insertText = completion text

insert-after-line:
  range = zero-width range at end of current line
  insertText = "\n" + generated code, with indentation normalized

replace-whole-line:
  range = from first non-whitespace or 0 to current position or line end, same line only
  insertText = generated code
```

### 注意

VS Code inline completion 的 range 必须是单行。多行文本可以放进 insertText，但 range 本身不能跨多行。

### 验收标准

* 每个 insertMode 有测试。
* range 总是单行。
* filterText 和 range 替换文本匹配。
* natural-command 替换整行。
* comment-to-test 插入到当前注释后。
* suffix 不重复。
* 不再出现错误 ghost text。

### 推荐 Codex prompt

```text
Start Phase 7 from CODE_COMPLETION_DEVELOPMENT_PLAN.md.

Implement InlineEditBuilder using plan.insertMode.

Ensure:
- VS Code inline completion range is always single-line.
- replace-current-word uses current word range.
- insert-after-line inserts after current line.
- replace-whole-line replaces the natural-language command line.
- filterText is valid and does not suppress correct suggestions.
- Empty insertText is rejected.

Add tests for all insert modes. Run test/lint/typecheck.
```

## 11. 阶段 8：实现 retry 策略

### 目标

对可恢复错误 retry 一次，对不可恢复错误静默拒绝。

### retry reasons

```text
echoed-prefix
no-insert-text
misaligned-leading-newline
repeated-comment
suffix-overlap-after-normalize
```

### retry prompt

```text
The previous output was rejected because it repeated the user's current line or produced no insertable code.

Return only the code to insert.
Do not repeat the user's current line.
Do not output markdown.
Do not explain.
Use the target symbol from context.
```

### 验收标准

* Qwen FIM 也允许 retry。
* comment-to-test 支持 retry。
* retry 最多一次。
* retry 后仍失败则不展示。
* 所有 retry path 有测试。

### 推荐 Codex prompt

```text
Start Phase 8 from CODE_COMPLETION_DEVELOPMENT_PLAN.md.

Implement one-shot retry for recoverable rejection reasons:
- echoed-prefix
- no-insert-text
- misaligned-leading-newline
- repeated-comment
- suffix-overlap-after-normalize

Retry prompt must be stricter and must forbid repeating the current line.

Do not retry forever. Add tests for retry success and retry failure. Run test/lint/typecheck.
```

## 12. 阶段 9：结构化 telemetry

### 目标

每次失败都能知道是哪个阶段的问题。

### 日志字段

```ts
interface CompletionDebugEvent {
  requestId: string;
  languageId: string;
  filePathHash?: string;
  triggerKind?: string;

  planKind: CompletionPlanKind;
  insertMode: CompletionInsertMode;
  currentWord?: string;
  targetSymbol?: string;

  symbolCandidates?: Array<{
    name: string;
    kind: string;
    score: number;
    source: string;
  }>;

  selectedContextBlocks?: Array<{
    kind: string;
    title: string;
    tokenEstimate: number;
    score: number;
  }>;

  droppedContextBlocks?: Array<{
    kind: string;
    title: string;
    reason: string;
  }>;

  modelRoute: "fim" | "instruction" | "deterministic-symbol" | "none";
  rawOutputLength?: number;
  normalizedOutputLength?: number;

  finalRange?: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };

  filterText?: string;
  accepted: boolean;
  rejectReason?: string;

  latencyMs: {
    planning?: number;
    symbol?: number;
    context?: number;
    model?: number;
    postprocess?: number;
    edit?: number;
    total: number;
  };
}
```

### 隐私规则

* 默认不要打印完整文件内容。
* debug level 下可以打印 prompt excerpt，但必须截断。
* 不打印 API key。
* 不打印完整绝对路径，必要时 hash。

### 验收标准

* 每个 completion request 有 requestId。
* 每个 rejection 都有 reason。
* 两个已知 bug 能从日志定位到具体阶段。
* telemetry 有测试。

### 推荐 Codex prompt

```text
Start Phase 9 from CODE_COMPLETION_DEVELOPMENT_PLAN.md.

Add structured debug telemetry for the completion pipeline.

Log planner, symbol resolver, context packer, model route, postprocess, edit builder, rejection reason, and stage latency.

Do not log secrets. Avoid logging full file content by default.

Add tests for stable fields and redaction. Run test/lint/typecheck.
```

## 13. 阶段 10：端到端验收

### 必须通过的 E2E fixtures

#### E2E 1：自然语言命令生成 unit test

输入：

```text
unit test for epr_ppn_raw_wr
```

mock symbol index：

```text
epr_ppn_raw_write_with_cb_dfx
```

期望：

* plan.kind = natural-command
* insertMode = replace-whole-line
* selected symbol = epr_ppn_raw_write_with_cb_dfx
* model route = instruction
* final insertText 包含 test function
* final insertText 不包含 `unit test for epr_ppn_raw_wr`
* final range 是单行

#### E2E 2：注释转 unit test

输入：

```c
// unit test for epr_ppn_raw_write_cb_dfx()
```

mock model output：

```c
// unit test for epr_ppn_raw_write_cb_dfx()
static void test_epr_ppn_raw_write_cb_dfx(void) {
}
```

期望：

* plan.kind = comment-to-test
* insertMode = insert-after-line
* visible insertText 不重复注释
* final insertText 以换行开始
* final insertText 包含测试代码

#### E2E 3：普通 FIM

输入：

```c
if (ret != 0) {
    |
}
```

期望：

* plan.kind = ordinary-code
* model route = fim
* 不走 instruction route

#### E2E 4：符号补全

输入：

```c
epr_ppn_raw_wr|
```

期望：

* plan.kind = symbol-completion
* selected symbol = epr_ppn_raw_write_with_cb_dfx
* 高置信度时不调用模型
* range 替换 current word

#### E2E 5：suffix overlap

输入：

```c
foo(|);
```

mock model output：

```c
epr_ppn_raw_write_with_cb_dfx());
```

期望：

```c
foo(epr_ppn_raw_write_with_cb_dfx());
```

不能变成：

```c
foo(epr_ppn_raw_write_with_cb_dfx()););
```

### 最终验收命令

根据项目实际 package manager 调整：

```bash
npm test
npm run lint
npm run typecheck
npm run compile
```

如果没有这些命令，Codex 必须先检查 `package.json`，使用项目真实存在的命令。

## 14. 最终 Done Definition

该任务只有在以下条件全部满足时才算完成：

* 所有新增 tests 通过。
* 所有旧 tests 通过。
* lint 通过。
* typecheck 通过。
* compile/build 通过。
* 两个已知 bug 都有 regression test。
* Qwen FIM prompt 确实包含 retrieved snippets。
* comment-to-test 不走 FIM。
* natural-command 不走 FIM。
* `epr_ppn_raw_wr` 能 deterministic resolve 到完整函数。
* echoed-prefix 不展示。
* repeated comment 不展示。
* suffix overlap 不重复。
* debug log 能定位每次补全在哪个阶段失败。
* 没有硬编码具体函数名。
* 没有引入无用大依赖。
* 最终 diff 清晰、模块职责清楚、可 review。

## 15. 给 Codex 的总执行 prompt

```text
Read CODE_COMPLETION_DEVELOPMENT_PLAN.md and execute it phase by phase.

Important:
- Do not implement everything in one giant change.
- Start with Phase 1 eval fixtures.
- After each phase, run the relevant tests/lint/typecheck.
- Report what changed, what tests pass, and what failures remain.
- Do not hardcode the example function name.
- Do not solve this by prompt tweaks only.
- Preserve existing behavior for ordinary code completion unless a test proves it is broken.
- If existing commands are unknown, inspect package.json first.
- If a phase is too large, split it into smaller commits.
- Stop after each phase with a concise summary and next recommended phase.
```
