# 代码补全模块 README

这份文档说明当前仓库 VS Code inline completion 的真实实现。它面向维护者和开发者，用来解释一次补全请求从 VS Code 触发，到 planner、检索、模型路由、候选清洗、inline edit 构造、质量门禁和 telemetry 的完整路径。

根目录 `README.md` 只保留入口说明；补全实现细节以本文为准。

## 总体架构

补全模块不是一次简单的模型调用，而是一条带规划、检索、路由、编辑验证和质量门禁的产品级流水线。

```text
src/extension.ts
  -> RemoteCompletionProvider.provideInlineCompletionItems()
  -> planCompletion()
  -> retrieveCompletionSnippets()
  -> retrieveCompletionAnalysisEvidence()
  -> resolveCompletionPlanAfterSymbolRetrieval()
  -> routeCompletionModel()
  -> buildQwenCoderFimPrompt() / buildCompletionPrompt()
  -> CompletionModelClient or RemoteOpenCodeClient
  -> runCompletionCandidatePipeline()
  -> postprocessCompletion()
  -> buildInlineCompletionEditResult()
  -> adaptAndValidateInlineCompletionEdit()
  -> scoreCEmbeddedCompletionQuality()
  -> InlineCompletionItem + completion telemetry
```

核心原则：

- 普通代码、C/C++ embedded、函数体续写和 top-level declaration 继续使用 Qwen FIM。
- 自然语言命令、comment-to-test 和 comment-to-code 使用 instruction prompt，不走普通 FIM。
- 符号补全优先使用确定性 symbol resolution；只有不满足高置信唯一符号时才进入模型辅助。
- typed prefix 只是兼容性、投影和 edit 约束，不是业务特例或生产硬匹配。
- inline completion 的 `replaceRange` 必须是单行；返回给 VS Code 的 edit 接受后必须得到正确代码。
- 不展示 echoed prefix、重复注释、空输出、Markdown 解释、protocol artifact、低置信度 placeholder 或 suffix-duplicated output。
- C/C++ embedded 在普通 VS Code edit 契约之后还有运行时质量门禁。

## 模块职责

| 文件 | 主要职责 |
| --- | --- |
| `src/extension.ts` | 注册 inline completion provider、补全 API key 命令、格式化命令，并把 `codeGraph`、settings、client 注入 provider。 |
| `src/completion.ts` | provider 主入口，串联规划、检索、路由、prompt、模型调用、候选流水线、质量门禁、缓存刷新和 telemetry。 |
| `src/completion-plan.ts` | 根据光标上下文产出 `CompletionPlan`，决定 plan kind、insert mode、检索需求、FIM/instruction 和 token budget。 |
| `src/completion-c-embedded-intent.ts` | 对 C/C++ embedded 场景做 intent 分类，例如 member access、call args、initializer、symbol prefix、state machine。 |
| `src/completion-retrieval.ts` | 把 plan 和 cursor shape 转成 symbol query、evidence question、retrieval policy 和 preferred symbol kinds。 |
| `src/completion-symbol.ts` | 对 code graph symbol candidates 做 prefix/token/abbrev/subsequence 排序和确定性解析。 |
| `src/completion-c-embedded-evidence.ts` | 构建 C/C++ embedded evidence，包含 graph-only、hybrid、comment-guided、symbol-prefix、body-statement 等路径。 |
| `src/repository-evidence.ts` | QA 和 completion 共享的 repository evidence orchestrator，负责 hybrid/semantic retrieval、projection、pack 和 trace。 |
| `src/completion-context.ts` | 将 target symbol、tests、open tabs、current prefix/suffix、analysis evidence 按 token budget 打包进 prompt。 |
| `src/completion-router.ts` | 将 plan 和 snippets 路由到 deterministic symbol、Qwen FIM、instruction 或 none。 |
| `src/context.ts` | 构造 instruction prompt、Qwen FIM prompt，以及聊天 QA prompt 中的 shared evidence 调用。 |
| `src/completion-model-client.ts` | 直连 OpenAI-compatible `/chat/completions` 或 raw `/completions`。 |
| `src/completion-candidate-pipeline.ts` | 从模型消息提取文本，执行 postprocess、fallback、edit builder、edit contract validation。 |
| `src/completion-postprocess.ts` | 清理模型输出，处理 echo、重复注释、suffix overlap、protocol artifact、低置信度和 C intent 截断。 |
| `src/completion-edit.ts` | 按 insert mode 构造 VS Code inline edit，并验证 range/filterText/selectedCompletionInfo/接受语义。 |
| `src/completion-c-embedded-quality.ts` | C/C++ embedded runtime quality gate，拒绝 placeholder、危险 API、幻觉 symbol、明显 C 语法失败等。 |
| `src/completion-request-coordinator.ts` | debounce、pending 复用、stale 请求取消、结果 cache、compatible cache 和 local fallback。 |
| `src/completion-telemetry.ts` | 结构化 completion debug event、路径 hash、字段截断和 route 映射。 |

## 注册与配置

扩展启动时，`activate()` 创建 `LocalCodeGraphService` 和 `RemoteCompletionProvider`，然后注册：

```ts
vscode.languages.registerInlineCompletionItemProvider(
  { scheme: "file" },
  new RemoteCompletionProvider(...)
)
```

provider 总是注册，但每次触发都会先做配置和上下文检查：

- `opencode.remote.completion.enabled` 为 `false` 时跳过。
- 只处理 `file` scheme 文档。
- `completion.provider === "opencode"` 时必须有 active `RemoteOpenCodeClient`。
- `completion.provider === "openai-compatible"` 时必须配置 `completion.apiBaseUrl`，并且 `completion.model` 或 `defaultModel` 至少有一个可用模型名。

inline completion 相关设置由 `readRemoteSettings()` 读取，常用字段：

| Setting | 用途 |
| --- | --- |
| `opencode.remote.completion.enabled` | 是否启用 inline completion。 |
| `opencode.remote.completion.provider` | `opencode` 或 `openai-compatible`。 |
| `opencode.remote.completion.profile` | 直连补全文本协议：`generic-chat` 或 `qwen-coder-fim`。 |
| `opencode.remote.completion.apiBaseUrl` | OpenAI-compatible base URL。 |
| `opencode.remote.completion.model` | direct completion 模型名；为空时回退 `defaultModel`。 |
| `opencode.remote.completion.maxTokens` | direct completion 默认最大输出 token。 |
| `opencode.remote.completion.temperature` | direct completion temperature。 |
| `opencode.remote.completion.topP` | direct completion top-p。 |
| `opencode.remote.completion.debounceMs` | 请求远端前的 debounce。 |
| `opencode.remote.completion.logLevel` | `off`、`info`、`debug`。 |
| `opencode.remote.completion.debugFullRetrievalProbe` | 为 C embedded retrieval 写出完整 live debug dump。 |
| `opencode.remote.completion.debugExpectedSymbol` | debug probe 中检查目标 symbol 是否进入各阶段。 |
| `opencode.remote.completion.commentGuidedRetrievalMode` | comment-guided C code 的 retrieval shape，默认走 QA-style exact path。 |

直连补全 API key 通过 `OpenCode Remote: Set Inline Completion API Key` 保存到 SecretStorage，key 为 `opencode.remote.completion.apiKey`，不会写入 settings JSON。

## 一次请求的生命周期

主入口是 `RemoteCompletionProvider.provideInlineCompletionItems()`。

### 1. 光标上下文采集

provider 从当前文档和光标位置提取：

- `lineText`：当前整行文本。
- `linePrefix`：当前行光标前文本。
- `lineSuffix`：当前行光标后文本。
- `currentWord`：光标前的 identifier。
- `currentWordRange`：当前词在当前行中的 range。
- `lines`：整个文档逐行文本。
- `previousNonEmptyLine` / `nextNonEmptyLine`：上下最近非空行。
- `indent`：`inferCompletionIndent()` 推断出的 `targetIndent` 和 `indentUnit`。

缩进推断优先从附近同级 block opener 和文件已有缩进学习，最后回退 VS Code editor/config 的 `insertSpaces` 和 `tabSize`。

### 2. CompletionPlan 规划

`planCompletion()` 输出 `CompletionPlan`。plan 决定：

- `kind`：补全场景。
- `insertMode`：`replace-current-word`、`insert-at-cursor`、`insert-after-line` 或 `replace-whole-line`。
- `targetSymbol` / `sourceComment` / `cIntent`。
- `needsSymbolRetrieval`、`needsIntentRetrieval`、`needsTestRetrieval`。
- `useFim` 或 `useInstruction`。
- `maxTokens`、`retrievalBudgetMs`、`confidenceFloor`。

当前 planner 顺序很重要：

1. 先分析 C/C++ 上一行注释驱动的代码补全，能命中则返回 `comment-guided-c-code`。
2. 再尝试 `previous-comment-continuation`；如果 comment-guided 发现是实现型注释但当前光标不适合，会降级到 body continuation fallback 或 disabled。
3. 再处理注释中的 symbol prefix：`comment-symbol-reference`。
4. 再处理 unit test prompt：注释内是 `comment-to-test`，裸文本是 `natural-command`。
5. 再处理普通 comment-to-code。
6. 进入 unsafe inline context 检查，字符串和 C 注释体内禁用。
7. 进入 C embedded intent 分类，可能返回 `c-embedded-code`。
8. 空行尝试 C blank line plan：aggregate initializer、body continuation、top-level declaration，否则 disabled。
9. 低信号输入禁用，除非 C body/top-level context 允许低信号请求。
10. 普通 C intent 非 symbol-prefix 时走 `ordinary-code` 并携带 `cIntent`。
11. 长度至少 3 的普通 identifier 走 legacy `symbol-completion`。
12. 其余走 `ordinary-code`。

### 3. 请求协调

`CompletionRequestCoordinator` 负责交互稳定性：

- request key 相同则复用 pending 请求。
- 新 key 到来会取消 stale pending。
- 根据 `completion.debounceMs` 延迟远端请求。
- 成功结果写入最多 100 条 cache。
- cache 命中前会重新验证 edit 是否仍满足 inline display invariant。
- compatible cache 可以把旧光标位置的缓存 edit 适配到用户继续输入后的新 prefix。
- 远端结果准备好后触发 `editor.action.inlineSuggest.trigger`，让 VS Code 刷新 ghost text。

request key 包含 URI、language id、provider、profile、direct provider 下的 document version、行列、当前整行文本和 plan 关键属性。

provider 还会构造一个 local fallback。它只用于极轻量模板，例如 brace language 中把 `while` 变成 while block。local fallback 也必须通过 edit validation 才能返回。

### 4. 后端路径

`openai-compatible`：

- 不要求 OpenCode connected。
- 使用 `CompletionModelClient`。
- `generic-chat` 调 `/chat/completions`。
- `qwen-coder-fim` 调 raw `/completions`，并带 Qwen FIM stop tokens。
- API key 通过 `Authorization: Bearer ...` 发送。

`opencode`：

- 需要 active `RemoteOpenCodeClient`。
- 使用独立 inline completion session，标题来自 `INLINE_COMPLETION_SESSION_TITLE`。
- session not found 时清空 session id，重建并重试一次。
- 发送模型使用 `parseModel(settings.defaultModel)`，为空时由远端服务使用默认模型。

## CompletionPlan 场景矩阵

| 场景 | 触发条件 | Plan kind | Insert mode | 检索 | 路由 |
| --- | --- | --- | --- | --- | --- |
| 普通代码续写 | 默认代码上下文 | `ordinary-code` | `insert-at-cursor` | C intent 可能检索 | Qwen FIM |
| C/C++ embedded intent | C/C++ 中 member/call/initializer/state/error/mmio/symbol 等结构信号 | `c-embedded-code` | `insert-at-cursor` | symbol + intent evidence | Qwen FIM |
| C/C++ 注释驱动代码 | 上一非空行是实现型注释，当前行是空白或短 identifier，且在 C body context | `comment-guided-c-code` | 视当前行选择 insert/replace | intent evidence，可带 target symbol | Qwen FIM |
| C/C++ 函数体空行续写 | 空行、在 block 内、邻近代码行有信号 | `body-continuation` | `insert-at-cursor` | 取决于 C intent | Qwen FIM |
| C/C++ 顶层声明 | top-level gap 或手动触发顶层空行 | `top-level-declaration` | `insert-at-cursor` | 默认不强制 symbol | Qwen FIM |
| legacy 符号补全 | 非 C embedded 路径下当前词长度至少 3 | `symbol-completion` | `replace-current-word` | symbol snippets | 高置信 deterministic，否则小预算 FIM |
| 注释里补符号前缀 | 单行注释中当前词像 symbol prefix | `comment-symbol-reference` | `replace-current-word` | symbol snippets | deterministic；exact/fallback 后转 instruction；无候选则 none |
| 注释转测试 | `// unit test for X` 等 | `comment-to-test` | `insert-after-line` | symbol + test snippets | instruction |
| 裸测试命令 | `unit test for X` 等非注释文本 | `natural-command` | `replace-whole-line` | symbol + test snippets | instruction |
| 注释转代码 | 单行注释含 add/write/fix/return/function 等代码意图 | `comment-to-code` | `insert-after-line` | symbol/evidence | instruction |
| 上一行注释续写 | 上一非空行是注释意图，当前行空白或短文本 | `previous-comment-continuation` | 空行 insert，否则 whole-line replace | 有目标符号或测试意图时检索 | instruction |
| 禁用 | 字符串内、C 注释体内、低信号、空顶层等 | `disabled` | `insert-at-cursor` | 无 | 不请求模型 |

## 场景细节

### 普通代码：`ordinary-code`

普通代码是非特殊场景的 fallback。它使用 FIM，不使用 instruction。对非 C/C++ 通常不做符号检索；对 C/C++，如果 `classifyCCompletionIntent()` 给出 member/call/assignment/condition/error 等 intent，plan 会携带 `cIntent` 并可能开启 symbol retrieval。

路由时普通代码强制使用 `qwen-coder-fim`，`maxTokens` 被 clamp 到适合 ghost text 的小范围，temperature 限制到 `<= 0.2`。

### C/C++ embedded：`c-embedded-code`

`planCEmbeddedCompletion()` 在 C/C++ 且不是 unsafe context 时介入。它会用结构信号分类 `cIntent`：

- `member-access`：`foo->` 或 `foo.` 后补成员。
- `initializer`：designated initializer 或 aggregate 内补字段/值。
- `call-args`：普通函数调用参数中补参数或表达式。
- `assignment-rhs`：赋值右侧。
- `condition`：`if (` / `while (` 条件。
- `error-path`：`goto`、ret/err guard、cleanup label。
- `mmio-register`：寄存器宏、BIT/GENMASK/FIELD_PREP/readl/writel 等上下文。
- `state-machine` / `switch-case` / `case-body`：状态变量、enum、case 分支。
- `preprocessor`：`#define`、`#if`、`#include` 等。
- `top-level-decl`：顶层声明。
- `symbol-prefix`：当前词是 identifier。
- `body-statement`：函数体普通语句洞。

每个 intent 都会带 retrieval policy、preferred kinds、max token、confidence floor 和 domain hints。domain hints 从当前行、上下文、附近行提取 `ufs`、`ssd`、`nand`、`ftl`、`rpmb` 等领域词，只作为通用加权信号。

### C/C++ 注释驱动代码：`comment-guided-c-code`

这条路径处理“上一行注释描述要做什么，下一行让补全写代码”的场景。它在 planner 中优先于 `previous-comment-continuation`，避免实现型注释误走 generic instruction。

条件：

- 语言是 C/C++。
- 上一非空行是单行注释。
- 当前行是空白、纯 identifier，或很短的 continuation line。
- 注释看起来是实现型动作，例如 init/read/write/check/wait/reset，或中文实现词。
- 光标在 C body context 中，不在注释或字符串中。

行为：

- `useFim: true`，最终仍走 Qwen FIM。
- `needsIntentRetrieval: true`。
- 如果注释中有强 symbol 线索，例如反引号/引号包裹的 identifier 或 `foo()`，才设置 `targetSymbol`。
- typed identifier only 时使用 `replace-current-word`，否则按当前行内容选择 insert 或 replace。
- 自动触发 retrieval budget 通常较短，手动触发给更长预算。

### 函数体续写：`body-continuation`

空行不总是 disabled。C/C++ 空行如果位于 block 内，且上下附近代码有真实语句信号，会进入 `body-continuation`。它继续使用 Qwen FIM，并携带 `body-statement`、`case-body` 等 C intent。

### 顶层声明：`top-level-declaration`

如果光标位于 C/C++ 顶层，附近看起来是 declaration gap，或手动触发顶层空行，则可以规划为 `top-level-declaration`。它仍使用 Qwen FIM，token 上限比普通自动补全略高，但保持小补全风格。

### 符号补全：`symbol-completion`

legacy symbol completion 用于非 C embedded 路径下的普通 identifier prefix。流程：

1. 用 `targetSymbol/currentWord` 构造 symbol query。
2. 调 `codeGraph.findSymbols()`。
3. `resolveSymbols()` 用 exact、prefix、token exact、token prefix、abbrev、subsequence、same file、nearby、same directory、kind bonus 排序。
4. `routeCompletionModel()` 如果发现高置信 longer prefix candidate，直接 deterministic。
5. 否则走小预算 Qwen FIM assist。

deterministic symbol 返回完整 symbol 文本，最终 edit 使用 `replace-current-word`。

### 注释中的符号引用：`comment-symbol-reference`

注释中当前词像 identifier prefix 时，planner 先不急着生成测试或代码，而是先补符号名。

`resolveCompletionPlanAfterSymbolRetrieval()` 会在检索后重判：

- 如果有 exact symbol，说明用户已经写完整符号，转为 `comment-to-test` 或 `comment-to-code` instruction。
- 如果有 longer symbol，保持 `comment-symbol-reference` 并走 deterministic。
- 如果没有候选但注释有 fallback intent，转 instruction。
- 如果没有候选也没有 fallback intent，route `none`，静默不展示。

### 测试和注释生成

`comment-to-test`、`natural-command`、`comment-to-code` 和部分 `previous-comment-continuation` 使用 instruction prompt。它们不走普通 FIM，避免把自然语言命令当成代码前缀。

edit mode：

- `comment-to-test`：在注释行后插入。
- `natural-command`：替换整行裸命令。
- `comment-to-code`：在注释行后插入。
- `previous-comment-continuation`：空行插入；当前行已有短文本时替换整行。

### 禁用：`disabled`

禁用场景包括字符串 literal、C/C++ 注释体内、空顶层低信号、标点-only 等。disabled plan 不会请求模型，也不会进入后续检索。

## 符号解析

符号候选来自本地 code graph：

```ts
codeGraph.findSymbols({
  query,
  relatedPath,
  limit,
})
```

检索 limit：

- `comment-symbol-reference`：50。
- test retrieval：30。
- `c-embedded-code` / `comment-guided-c-code` / 普通 completion symbol snippets：通常更小，按 plan 和 preferred kinds 排序。

`resolveSymbols()` 不使用具体业务函数名硬编码，而是通用打分：

| 信号 | 说明 |
| --- | --- |
| exact | 查询和符号名规范化后完全相等。 |
| prefix | 符号名以查询开头。 |
| token exact | snake/camel token 逐段精确命中。 |
| token prefix | query token 是 name token 前缀。 |
| token abbrev | query token 是 name token 子序列缩写。 |
| subsequence | query 是去下划线 name 的子序列。 |
| source rank | open document、code graph、workspace、retrieved snippet 有不同加分。 |
| same file / same directory | 当前文件和目录相关性加分。 |
| nearby above | 注释符号引用偏好光标上方最近符号。 |
| kind bonus | unit test target 偏好 function/method。 |

候选最终通过 `completionSnippetFromSymbol()` 转成 `RetrievedCompletionSnippet`。路径或名称像 test/spec/mock/fixture 时，会被 context pack 识别为类似测试。

## C/C++ evidence 原理

`retrieveCompletionAnalysisEvidence()` 只在这些条件满足时执行：

- 有 `deps.codeGraph`。
- `settings.codeGraph.enabled`。
- 当前语言是 C/C++。
- 能从 plan 和 cursor 构造非空 evidence question。

对普通 C embedded、comment-guided C code 和 symbol-prefix，核心入口是 `buildCEmbeddedCompletionEvidence()`。

### 非 comment/symbol-prefix intent

对 `member-access`、`call-args`、`initializer`、`error-path`、`state-machine`、`mmio-register` 等强 intent：

1. 先用 `retrievalMode: "graph-only"` 调 `codeGraph.queryEvidence()`。
2. 根据 intent 选择 evidence kinds，例如 `c-base-type`、`c-callee-signature`、`c-call-example`、`c-register-macro`。
3. 用 `minimumUsefulEvidence()` 判断 graph evidence 是否够用。
4. 不够用且没超时时，回退 `retrievalMode: "hybrid"`，让 RAG/vector/rerank 参与。
5. `selectPromptEvidenceItems()` 按 intent priority 选有限条 evidence。
6. `formatCEmbeddedEvidenceText()` 格式化为 `C evidence: ...` 的 code-like prompt 文本。

### Comment-guided `qa-exact`

`comment-guided-c-code` 默认通过 `retrieveRepositoryEvidenceForIntent()` 走 shared repository evidence core：

- `task: "comment-guided-code"`。
- `mode: "completion"`。
- 默认 retrieval shape 是 `qa-exact`。
- query 以 source comment、current file/function、nearby calls、nearby message text 和 cursor context 为语义中心。
- completion 只拿 `completionPack.evidence`，不会把 QA prose 塞进补全 prompt。

最终 evidence 会被标注角色：

- `callable-helper`：可直接调用的 helper。
- `style-example`：相似代码风格样例。
- `local-flow`：当前函数附近流程。
- `weak-target-symbol` / `weak-context`：弱证据，优先级更低。

`generationModeHint` 用来告诉 FIM 更偏向：

- `prefer-existing-helper`。
- `synthesize-from-style`。
- `continue-local-code`。

### Symbol-prefix `qa-semantic`

`c-embedded-code` 且 `cIntent === "symbol-prefix"` 时，补全不是只找 prefix-compatible 符号。它会走 `qa-semantic`：

1. 用当前函数、附近调用、visible locals/identifiers、附近注释/日志文本构造 semantic query。
2. 并行执行 hybrid semantic retrieval 和 graph-only question。
3. 合并 semantic TopK 与 graph TopK。
4. `completionProjectionItems()` 按语义证据、函数形态、same module、current-function token、cursor context、call fit、typed prefix compatibility 排序。
5. `packQaSemanticSymbolPrefixEvidence()` 优先选择 semantic function/code evidence；必要时才用 prefix-compatible fallback 或 local-flow fallback。
6. 最终 FIM 仍根据 prompt evidence 生成代码；typed prefix 继续约束 edit 和可接受文本。

这条路径避免把 prefix 当作生产硬匹配。typed prefix 是弱兼容提示和 edit 约束：语义检索先回答“这个位置最相关的 helper/代码是什么”，projection 再判断哪些 evidence 能安全进入 completion prompt。

### Body-statement shared evidence

`body-statement` 使用同一个 repository evidence orchestrator，但 retrieval shape 是 default。它重点排序当前函数 flow、附近调用序列、same-module helper、local style example 和 visible locals，避免空函数体或普通语句洞只被邻近函数污染。

## QA/Completion evidence alignment

`retrieveRepositoryEvidenceForIntent()` 是 QA 和 completion 共享 evidence 的核心。设计目标是：

- QA 和 completion 尽量共享检索、rerank、candidate pool 和 trace 解释。
- completion 不共享 QA 的自然语言回答文本。
- completion 用 `completionProjectionItems()` 和 `packCompletionRepositoryEvidence()` 把 shared evidence 投影成 FIM 可用的小 evidence pack。

QA path 通常看：

```text
buildChatPrompt()
  -> retrieveRepositoryEvidenceForIntent({ mode: "qa", ... })
  -> codeGraph.queryEvidence()
  -> evidence pack for answer prompt
```

Completion path 通常看：

```text
completionRetrievalPlan()
  -> buildCEmbeddedCompletionEvidence()
  -> retrieveRepositoryEvidenceForIntent({ mode: "completion", ... })
  -> completion projection
  -> packCompletionContext()
  -> Qwen FIM prompt
```

高价值 audit 字段：

- `qaRetrievalTopK`：QA-style/full retrieval TopK。
- `completionRetrievalTopK` / `completionProjectionTopK`：completion projection 后的候选。
- `qaAlignedEvidence` / `alignmentReason`：两边是否对齐以及为什么没对齐。
- `actualPromptEvidenceNames` / `selectedPromptEvidenceNames`：最终真的进入 prompt 的 evidence。
- `droppedProjectedEvidenceNames`：projection 选中但被 token/context pack 丢掉的 evidence。

## Typed-prefix 与 symbol-prefix

typed prefix 相关逻辑有两层：

### Retrieval/projection 层

`repository-evidence.ts` 中的 symbol-prefix projection 会计算：

- `symbolPrefixSemanticTopK`：semantic retrieval 的 top names。
- `symbolPrefixGraphTopK`：graph-only question 的 top names。
- `symbolPrefixMergedTopK`：合并候选。
- `typedPrefixCompatibleCandidates`：名字与当前 prefix 兼容的候选。
- `typedPrefixCompatiblePromptNames`：最终 prompt 中 prefix-compatible 的候选。
- `symbolPrefixSemanticVsPrefixDiverged`：semantic top 和 prefix-compatible top 是否分歧。
- `symbolPrefixSelectionReason`：最终为什么选择 semantic、prefix fallback 或 local-flow fallback。

projection score 会综合：

- semantic evidence 来源。
- name 是否 prefix-compatible。
- current function tokens 是否重合。
- same module。
- cursor context scores。
- call-site 参数是否可能满足。
- 是否 broad utility / summary-like evidence。

短 prefix 或候选模糊时，router 可能压制 deterministic symbol，让 Qwen FIM 基于 richer evidence 生成。

### Edit 层

`completion-edit.ts` 的 `typedPrefixSuffixReplacement()` 处理这种情况：

```text
用户输入: ct_
模型/证据候选首词: controller_init_common(...)
symbol hints: ct_controller_init_common
最终 edit: 用 ct_controller_init_common 替换当前词 range
```

这不是 `filterText` 粉饰。它必须满足：

- 当前词是合法 identifier。
- 行 suffix 为空或安全。
- leading identifier 能和 `symbolHints` 中的真实符号后缀匹配。
- 最终 `insertText`、`replaceRange`、`filterText` 通过 `adaptAndValidateInlineCompletionEdit()`。

telemetry 会记录 `typedPrefixAdapted`、`typedPrefixAdaptReason`、`typedPrefixCurrentWord`、`typedPrefixMatchedSymbol`、`typedPrefixOriginalFirstLine`、`typedPrefixFinalFirstLine`。

## 上下文检索与打包

### Symbol snippets

`retrieveCompletionSnippets()` 负责轻量 symbol snippets：

- 如果没有 code graph 或 plan 不需要 snippets，直接返回空。
- `completionRetrievalPlan()` 产出最多 4 个 query。
- 每个 query 调 `findSymbols()`，再用 `resolveSymbols()` 排序。
- `rankRetrievedCompletionSnippets()` 根据 preferred kinds 和 score 选有限 snippets。

它默认把 telemetry `retrievalMode` 合并为 `graph-only`，避免普通 inline completion 在索引或 embedding/rerank 未就绪时被重型 hybrid 路径卡住。

### Analysis evidence

`retrieveCompletionAnalysisEvidence()` 负责更重的 C/C++ evidence：

- 对 `c-embedded-code` 和 `comment-guided-c-code` 调 `buildCEmbeddedCompletionEvidence()`。
- 其他 C/C++ plan 用 `codeGraph.queryEvidence(question, completionAnalysisEvidenceOptions())`。
- `completionAnalysisEvidenceOptions()` 默认走 graph-only 以保持 inline completion 响应性；强 C embedded evidence 不够时才按专门逻辑回退 hybrid。

### Context pack

`packCompletionContext()` 先构造 blocks，再按 plan 打包。

block kind：

- `current-prefix`
- `current-suffix`
- `target-symbol`
- `similar-test`
- `test-framework`
- `include`
- `open-tab`
- `analysis-evidence`
- `c-embedded-evidence`
- `source-comment`

普通场景使用 greedy pack：按 score 排序，能放进 token budget 就选，放不下就进 `dropped`。

C embedded 和 comment-guided 场景使用专用 pack：

1. 优先尝试选择 `current-prefix`。
2. 再选择 `current-suffix`。
3. comment-guided 选择 `source-comment`。
4. 再按 evidence limit 和 evidence token limit 选择 `c-embedded-evidence` / `analysis-evidence`。
5. 最后补 open tabs、includes、其他上下文。

prompt evidence 限制：

- `comment-guided-c-code` 最多 3 条 evidence，且 evidence token limit 约 450。
- 强 intent 如 member-access、call-args、initializer、error-path、state-machine、mmio-register 最多 4 条。
- 其他 C embedded 通常最多 2 条。

如果 evidence 被 token budget 丢弃，telemetry 会记录 `evidenceDroppedReason: "token-budget"`、`droppedEvidenceKinds`、`droppedProjectedEvidenceNames`。

## 模型路由

`routeCompletionModel()` 根据 resolved plan 和 snippets 产出 `CompletionModelRoute`。

### Deterministic symbol

适用于：

- `symbol-completion`
- `comment-symbol-reference`
- `c-embedded-code` + `cIntent === "symbol-prefix"`

基本条件：

- candidate name 长于 target。
- candidate name lower-case 以 target lower-case 开头。
- snippet score 不低于阈值。

对 C embedded symbol-prefix 还会做额外压制：

- prefix 太短：`deterministicSymbolSuppressReason = "short-prefix"`。
- prefix-compatible 候选分数接近且不唯一：`ambiguous-prefix`。

被压制后转 FIM，让模型结合 semantic evidence 和 cursor context 生成。

### Qwen FIM route

走 FIM 的 plan：

- `ordinary-code`
- `c-embedded-code`
- `comment-guided-c-code`
- `body-continuation`
- `top-level-declaration`
- deterministic 不成立的 `symbol-completion`

普通代码、C embedded、body continuation、top-level declaration 强制 `modelProfile/textProfile = "qwen-coder-fim"`。`comment-guided-c-code` 使用当前 configured completion profile，但设计上仍是 FIM prompt style。

### Instruction route

走 instruction 的 plan：

- `comment-to-test`
- `natural-command`
- `comment-to-code`
- `previous-comment-continuation`

instruction route 使用 `generic-chat`，temperature 为 0，输出必须是代码，不允许 Markdown 或解释。

### None route

典型场景是 unresolved `comment-symbol-reference`：没有高置信符号候选，也没有可转换的 fallback intent。provider 记录 no-completion，不展示 ghost text。

## Prompt 构造

### Qwen Coder FIM prompt

`buildQwenCoderFimPrompt()` 使用 Qwen FIM token：

```text
<|repo_name|>...
<|file_sep|>path
// intent: ...
<repo_context>...</repo_context>
// language / completion rules
<|fim_prefix|>...
<|fim_suffix|>...
<|fim_middle|>
```

prompt 包含：

- repo name。
- 当前文件路径。
- C intent block：`// intent: ...`、source comment、已选 context block 数。
- `formatRepoContext(pack)` 输出的 context blocks。
- 语言规则。
- prefix/suffix 文本。

C evidence 使用 `C evidence:` 文本格式，避免 XML-like wrapper 把 FIM 模型诱导成 tool/protocol 输出。

### Instruction prompt

`buildInstructionCompletionPrompt()` 用于 comment-to-code/test 和 natural command：

- 明确任务：生成 unit test 或根据注释生成代码。
- 禁止重复用户当前行。
- 禁止 Markdown 和解释。
- 输出 only code。
- 注入 target symbol、similar tests、test framework、local analysis evidence、current file。
- 对 comment code，说明插入点应在 source comment 之后、suffix 之前。

### Direct provider transport

`CompletionModelClient` 根据 profile 选择 endpoint：

- `generic-chat`：`/chat/completions`，messages 中 system 指令约束 inline completion。
- `qwen-coder-fim`：raw `/completions`，发送 `prompt`，使用 Qwen FIM stop tokens。

如果 direct FIM endpoint 对 `/completions` 返回 404/405，会记录 `direct-fim-endpoint-unsupported`，提示该 profile 需要 raw completions endpoint。

## 模型响应与候选流水线

`runCompletionCandidatePipeline()` 是从模型返回到 edit 的共享边界：

1. `completionInsertText()` 从 OpenCode/direct response 中提取最终可见文本，reasoning 不直接插入。
2. `postprocessCompletion()` 清理原始输出。
3. `fallbackCompletionText()` 或 symbol fallback 在必要时提供兜底。
4. `trimCompletionForCIntent()` 对 member access、call args、initializer、condition、error path 等 C intent 做短补全截断。
5. `buildInlineCompletionEditResult()` 按 insert mode 构造 edit。
6. `adaptAndValidateInlineCompletionEdit()` 验证 VS Code inline display 和接受语义。

后处理会处理：

- Qwen FIM special tokens。
- `<think>` / reasoning。
- fenced code。
- leading meta lines。
- explanatory lead-in。
- protocol artifact，例如 `<tool_call>` 或 function call JSON。
- 当前行 echo。
- line prefix echo。
- suffix overlap。
- middle-of-line suffix duplication。
- common indent normalization。
- instruction 输出开头重复注释。
- explanation-only / low-confidence output。

如果 candidate 为空或被拒绝，会返回明确 reason，例如 `empty-output`、`echoed-prefix`、`repeated-comment`、`suffix-duplicated-output`、`protocol-artifact-output`、`low-confidence-output`。

## Inline edit 构造

`CompletionInsertMode` 决定 edit 形状。

| Insert mode | 行为 |
| --- | --- |
| `replace-current-word` | 替换当前词 range，常用于 symbol prefix 和 typed comment-guided prefix。 |
| `insert-at-cursor` | 零宽插入，常用于 FIM 普通续写。 |
| `insert-after-line` | 插入到当前整行末尾之后，常用于注释转代码/测试。 |
| `replace-whole-line` | 替换当前行非空白到行尾，常用于裸自然语言命令。 |

关键规则：

- 所有 `replaceRange` 必须单行。
- `filterText` 必须以 range text 开头。
- 对当前词替换，`insertText` 必须保留或合理扩展当前词。
- `selectedCompletionInfo` 存在时，range 必须对齐 VS Code 当前 selected completion，insertText 必须以 selected text 开头。
- whole-line replacement 只能在预期整行范围内适配。

不要通过改 `filterText` 来掩盖坏 edit。`adaptAndValidateInlineCompletionEdit()` 的目标是接受后得到正确代码，而不只是让 ghost text 暂时显示。

## C/C++ embedded 质量门禁

普通 edit validation 通过后，C/C++ 会进入 `scoreCEmbeddedCompletionQuality()`。

运行时 fixture 会检查：

- VS Code edit contract。
- edit 应用后文本是否变化。
- C syntax/format。
- Markdown 或解释。
- placeholder / TODO / scaffold-only。
- dangerous C API。
- buffer write/copy 是否缺少边界保护。
- ISR 中阻塞调用。
- busy loop 缺少 timeout/yield/break/return。
- MMIO/register 场景是否丢失 `volatile` 等安全信号。
- hallucinated high-risk project symbol。
- 自动触发下补全是否适合 auto-show。

hard reject 会以 `quality:<issue kind>` 作为 reason，不展示补全。部分 quality rejection 可触发 fallback 或 retry。

## Retry 与 quality fallback

`completionOutcomeWithRetry()` 最多重试一次。

会重试：

- `quality:placeholder`
- `quality:C parse/compile`
- `quality:markdown/explanation`
- comment code instruction 的 `low-intent-output`
- comment code instruction 的 `suffix-duplicated-output`
- generic instruction 的 `misaligned-leading-newline`
- generic instruction 的 `low-confidence-output`

不会因为低置信度重试 FIM：`textProfile === "qwen-coder-fim"` 时，低置信度不重试。

quality fallback 在模型输出被 C quality gate 拒绝后尝试 `fallbackCompletionText()`，再重新走 candidate pipeline 和 edit validation。fallback 也必须满足 VS Code 契约和 C quality gate。

## 接受后的格式化

provider 返回 `InlineCompletionItem` 时会附带 `completionFormatCommand`。用户接受补全后，扩展尝试对刚插入的小范围调用 VS Code formatter；没有 formatter 或格式化失败时安全跳过。

format range 来自 edit builder，避免对整个文件做无关重排。

## 日志与遥测

日志写入 `OpenCode Remote` output channel。

`info` 级别常见日志：

| 日志 | 含义 |
| --- | --- |
| `triggered` | VS Code 触发 provider。 |
| `scheduled` | 请求进入 debounce。 |
| `reuse-pending` | 同 key 复用 pending。 |
| `cancelled` | stale key、clear 或 VS Code token 取消。 |
| `cache-hit-exact` / `cache-hit-compatible` | 命中缓存或 compatible cache。 |
| `sent` / `received` | prompt 发送和模型返回。 |
| `empty` | 候选为空或被 postprocess/edit 拒绝。 |
| `edit-ready` | 构造出可用 edit。 |
| `quality-rejected` | C/C++ quality gate 拒绝。 |
| `retry-sent` / `retry-received` | 触发一次 retry。 |
| `returned` | provider 返回 `InlineCompletionItem`。 |

`debug` 级别会额外输出：

- route 类型和原因。
- symbol retrieval 数量和 query。
- context selected/dropped kinds 和 token budget。
- raw/postprocess first line。
- inline invariant：range、rangeText、insertFirstLine、filterText、displayRisk。
- `[completion-telemetry]` JSON。

关键 telemetry 字段：

| 字段 | 含义 |
| --- | --- |
| `requestId` / `completionId` | `cc-...` 请求 id。 |
| `extensionVersion` / `plannerRevision` | 扩展版本和 planner revision。 |
| `languageId` / `filePathHash` | 语言和路径 hash。 |
| `triggerKind` | automatic、invoke 等。 |
| `planKind` / `cIntent` / `insertMode` | planner 结果。 |
| `currentWord` / `targetSymbol` | 当前词和目标符号。 |
| `retrievalMode` | `none`、`graph-only`、`hybrid` 或合并结果。 |
| `symbolCandidates` | symbol resolver top candidates。 |
| `evidenceKinds` / `evidencePromptKinds` | 选中 evidence 类型。 |
| `selectedContextBlocks` / `droppedContextBlocks` | 进入或被丢弃的 context blocks。 |
| `qaRetrievalTopK` | QA-style/full retrieval TopK。 |
| `completionRetrievalTopK` / `completionProjectionTopK` | completion retrieval/projection TopK。 |
| `actualPromptEvidenceNames` / `selectedPromptEvidenceNames` | 最终 prompt 中的 evidence names。 |
| `droppedProjectedEvidenceNames` | projection 选中但 prompt 未保留的 evidence。 |
| `cursorContextScope` / `currentFunctionBodyIsEmpty` | retrieval 使用的 cursor scope 和函数体状态。 |
| `scopedPreviousStatementCalls` / `scopedNextStatementCalls` | 当前函数内邻近调用。 |
| `retrievalShape` / `symbolPrefixRetrievalShape` | `default`、`qa-exact`、`qa-semantic`。 |
| `semanticTopK` / `graphTopK` / `mergedTopK` | semantic/graph/merged retrieval 候选。 |
| `typedPrefixCompatibleCandidates` / `typedPrefixCompatiblePromptNames` | prefix-compatible 候选与 prompt 保留项。 |
| `symbolPrefixSelectionReason` | symbol-prefix 最终选择原因。 |
| `typedPrefixAdapted` / `typedPrefixMatchedSymbol` | edit 层 typed-prefix 适配情况。 |
| `modelRoute` / `promptKind` | `fim`、`instruction`、`deterministic-symbol` 或 `none`。 |
| `rawOutputLength` / `normalizedOutputLength` | 模型原始和后处理文本长度。 |
| `trimReason` / `finalInsertLength` | 截断/最终插入长度。 |
| `finalRange` / `filterText` | 最终 VS Code edit 信息。 |
| `accepted` / `rejectReason` | 是否展示及拒绝原因。 |
| `latencyMs` | planning、symbol、context、model、postprocess、edit、total 耗时。 |
| `fullRetrievalProbeDumpPath` | live retrieval debug dump 文件路径。 |

## 常见场景走向示例

### 裸测试命令

```text
unit test for epr_ppn_raw_wr
```

预期路径：

1. planner 识别 `natural-command`。
2. `targetSymbol` 是用户输入中的 symbol prefix。
3. symbol resolver 用通用 prefix/token/abbrev/subsequence 解析真实项目符号。
4. router 走 instruction。
5. context pack 注入 target symbol、similar tests、test framework。
6. edit 使用 `replace-whole-line`。
7. echoed command 或重复注释会被拒绝。

### 注释测试命令

```text
// unit test for epr_ppn_raw_write_cb_dfx()
```

预期路径：

1. 如果光标还在 symbol prefix 上，先走 `comment-symbol-reference`。
2. 检索发现 exact symbol 后转为 `comment-to-test`。
3. router 走 instruction。
4. edit 插入到注释行后，不重复生成原注释。

### C symbol-prefix 语义补全

```text
nf|
```

预期路径：

1. C embedded planner 识别 `c-embedded-code` + `cIntent: "symbol-prefix"`。
2. retrieval shape 是 `qa-semantic`。
3. semantic query 用当前函数 flow、附近调用、visible locals、附近注释/日志，而不是只靠 `nf`。
4. projection 结合 semantic evidence 和 typed prefix compatibility。
5. 若 deterministic symbol 被 short/ambiguous prefix 压制，router 走 FIM。
6. edit 层仍保证 typed prefix 接受语义。

### 注释驱动 C 代码

```text
// wait for controller reset done
|
```

预期路径：

1. planner 先命中 `comment-guided-c-code`。
2. `extractCommentGuidedCursorContext()` 收集当前函数范围内的邻近调用、visible locals 和 message text。
3. repository evidence 走 `qa-exact`，选 helper/style/local-flow evidence。
4. context pack 保留 source comment、prefix/suffix 和最多 3 条 evidence。
5. router 走 FIM，输出只插入代码，不重复注释。

### 中行补条件表达式

```text
if (status == |
```

预期路径：

1. C embedded planner 识别 `condition`。
2. retrieval 查状态/enum/flag/guard style。
3. FIM route 生成短条件片段。
4. postprocess 用 `trimConditionCompletion()` 截断到表达式边界。
5. suffix overlap 防止重复 `)`、`;` 等当前 suffix。

### 空白 C 函数体

```c
static int init_device(struct dev *dev)
{
    |
}
```

预期路径：

1. planner 可能命中 `body-continuation` 或 `c-embedded-code` + `body-statement`。
2. retrieval cursor scope 应优先限制在当前函数，避免邻近函数流程污染。
3. context pack 保留 current prefix/suffix 和少量 local evidence。
4. FIM 生成短语句或小块代码。

## 测试地图

修改生产逻辑前应先新增或更新对应测试；文档-only 变更通常只需 package 验证。

| 测试文件 | 覆盖点 |
| --- | --- |
| `test/completion-plan.test.ts` | plan kind、insert mode、C embedded、comment-guided、top-level、禁用场景。 |
| `test/completion-c-embedded-intent.test.ts` | C/C++ intent 分类、retrieval policy、domain hints。 |
| `test/completion-retrieval.test.ts` | retrieval plan、evidence question、preferred kinds。 |
| `test/completion-c-embedded-evidence.test.ts` | C evidence 构建、QA alignment、symbol-prefix qa-semantic、trace 字段。 |
| `test/repository-evidence.test.ts` | shared repository evidence、projection、pack、alignment trace。 |
| `test/completion-router.test.ts` | deterministic symbol、FIM、instruction、none route、retry 策略。 |
| `test/completion-symbol.test.ts` | 符号 exact/prefix/abbrev/subsequence 排序。 |
| `test/completion-context.test.ts` | context pack、Qwen FIM prompt、instruction prompt、analysis evidence。 |
| `test/completion-postprocess.test.ts` | echo、重复注释、suffix overlap、protocol artifact、C intent trim。 |
| `test/completion-edit.test.ts` | insert modes、range/filterText 契约、selectedCompletionInfo、typed prefix adaptation。 |
| `test/completion-request-coordinator.test.ts` | pending 复用、取消、cache、compatible cache、local fallback validation。 |
| `test/completion-model-client.test.ts` | direct `/chat/completions`、raw `/completions`、URL 和错误处理。 |
| `test/completion-c-embedded-quality.test.ts` | C/embedded hard reject、质量分、门禁阈值。 |
| `test/completion-quality-benchmark.test.ts` | prompt/evidence dump、benchmark report、XML-like evidence regression。 |
| `test/completion/phase10-e2e.test.ts` | 补全流水线端到端 fixture。 |
| `test/completion-telemetry.test.ts` | request id、路径 hash、telemetry sanitize 和 route 映射。 |

常用验证命令：

```bash
bun test test/completion-plan.test.ts test/completion-retrieval.test.ts test/completion-c-embedded-evidence.test.ts test/completion-context.test.ts test/completion-edit.test.ts test/completion-router.test.ts
bun run package
```

本仓库交付前要求执行 `bun run package`。它会跑 type checking、linting 和 TypeScript compilation。

## 维护注意事项

- 不要只通过 prompt tweaking 修补补全质量问题。优先检查 planner、symbol resolver、retrieval/evidence、context pack、router、postprocess、edit builder 和质量门禁。
- 不要在生产逻辑中硬编码具体函数名、变量名、注释句子、业务字符串或单个回归样例文本。
- 已知回归只能用测试 fixture 验证通用规则覆盖，不能加生产特判。
- 普通代码补全必须继续保留 Qwen FIM。
- 自然语言命令和 comment-to-test 不得走普通 FIM。
- Symbol completion 必须优先 deterministic symbol resolution。
- typed prefix 不等于硬过滤；它是 retrieval projection 和 edit acceptance 的约束。
- completion 与 QA 可以共享 evidence core，但 completion prompt 只能接收 projected evidence/context blocks，不能接收 QA prose。
- inline completion range 必须保持单行。
- 任何返回给 VS Code 的 edit，接受后必须得到正确代码；不要用 `filterText` 粉饰坏 edit。
- C/C++ embedded 场景如果修改质量门禁，要同步更新质量 fixture 或相关测试。
- 如果新增 context block 类型，需要同步处理 token budget、selected/dropped telemetry 和 prompt 格式化。

## 排障速查

| 现象 | 优先检查 |
| --- | --- |
| 没有任何补全日志 | `completion.enabled`、文档是否是 `file` scheme、provider 是否注册。 |
| 只有 `triggered` 没有 `sent` | debounce 期间被取消、plan disabled、provider 配置缺失。 |
| `route=none` | 常见于 unresolved `comment-symbol-reference`，说明没有高置信符号候选。 |
| C 注释后一行走了 instruction 而不是 FIM | 看 `planKind` 是否为 `comment-guided-c-code`，以及 `commentGuidedSkipReason`。 |
| C symbol-prefix 选错 helper | 看 `symbolPrefixSemanticTopK`、`typedPrefixCompatibleCandidates`、`completionProjectionTopK`、`actualPromptEvidenceNames`。 |
| QA 能找到 helper 但 completion 没进 prompt | 看 `qaRetrievalTopK`、`completionProjectionTopK`、`droppedProjectedEvidenceNames`、`selectedContextBlocks`。 |
| evidence 找到了但 prompt 没有 | 看 token budget、`evidenceDroppedReason`、`droppedEvidenceKinds`、`actualPromptEvidenceNames`。 |
| 空函数体被邻近函数污染 | 看 `cursorContextScope`、`currentFunctionBodyIsEmpty`、`scopedPreviousStatementCalls`、`cursorContextFallbackReason`。 |
| `empty reason=echoed-prefix` | 模型只重复了当前 prefix。 |
| `empty reason=repeated-comment` | comment-to-code/test 只重复了用户注释。 |
| `suffix-duplicated-output` | 中行补全会重复当前 suffix。 |
| `protocol-artifact-output` | 模型输出 `<tool_call>`、function call JSON 或类似协议文本。 |
| `rangeText-not-prefix-of-filterText` | edit 违反 VS Code inline display 契约。 |
| `insertText-does-not-preserve-rangeText` | edit 接受后不能安全保留被替换文本。 |
| `selectedCompletionInfo-range-mismatch` | VS Code 当前已有 selected completion，edit range 没有对齐。 |
| `quality:placeholder` | C/C++ 输出包含 TODO、placeholder 或 scaffold-only 文本。 |
| `quality:C parse/compile` | C/C++ 应用后静态语法或 clang 检查失败。 |
| `quality:hallucinated API` | C/C++ 输出使用了上下文中不可见的高风险项目符号。 |

打开 `opencode.remote.completion.logLevel = "debug"` 后，优先看：

- `planKind`、`cIntent`、`insertMode` 是否符合当前场景。
- `modelRoute` 和 `promptKind` 是否是预期的 FIM、instruction、deterministic symbol 或 none。
- `retrievalShape` / `symbolPrefixRetrievalShape` 是否符合预期。
- `qaRetrievalTopK`、`completionProjectionTopK`、`actualPromptEvidenceNames` 是否对齐。
- `selectedContextBlocks` 是否保留了 current prefix/suffix/source comment/evidence。
- `rawFirstLine` / `postprocessFirstLine` 是否显示 echo、解释、suffix 或 protocol artifact。
- `replaceRange`、`rangeText`、`filterText`、`typedPrefix*` 是否满足 VS Code 接受语义。
