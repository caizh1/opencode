# 代码补全模块 README

这份文档说明当前仓库 VS Code inline completion 的真实实现。它面向维护者和开发者，重点解释一次补全请求从 VS Code 触发，到模型/确定性解析，再到最终 ghost text 返回的完整流水线，以及不同场景下的分支处理。

相关入口主要在这些文件中：

| 文件 | 主要职责 |
| --- | --- |
| `src/extension.ts` | 注册 inline completion provider 和补全相关命令。 |
| `src/completion.ts` | VS Code provider 主入口，串联规划、检索、路由、prompt、模型调用、后处理、编辑构造、质量门禁和遥测。 |
| `src/completion-plan.ts` | 判断当前补全场景，产出 `CompletionPlan`。 |
| `src/completion-symbol.ts` | 对 code graph 返回的符号候选做确定性匹配、缩写解析和排序。 |
| `src/completion-context.ts` | 把符号、测试、open tabs、当前文件、分析证据等上下文按预算打包。 |
| `src/completion-router.ts` | 根据 plan 和已检索符号选择 deterministic symbol、Qwen FIM、instruction 或静默拒绝。 |
| `src/context.ts` | 构造 instruction prompt 和 Qwen Coder FIM prompt。 |
| `src/completion-model-client.ts` | 直连 OpenAI-compatible `/chat/completions` 或 `/completions`。 |
| `src/completion-candidate-pipeline.ts` | 从模型消息到候选文本、后处理、fallback、inline edit 的候选流水线。 |
| `src/completion-postprocess.ts` | 清理模型输出，处理 echo、重复注释、suffix overlap、低置信度输出等。 |
| `src/completion-edit.ts` | 根据 insert mode 构造 VS Code inline edit，并验证显示契约。 |
| `src/completion-c-embedded-quality.ts` | C/C++ embedded 场景的运行时质量门禁。 |
| `src/completion-request-coordinator.ts` | debounce、pending 复用、stale 请求取消、cache 和本地 fallback。 |
| `src/completion-telemetry.ts` | 结构化 debug telemetry。 |

## 总体架构

补全模块不是单次模型调用。当前实现保留了一条产品级流水线：

```text
VS Code inline provider
  -> CompletionPlanner
  -> SymbolResolver / ContextRetriever
  -> ContextPacker
  -> ModelRouter
  -> Prompt Builder
  -> Model Client or deterministic result
  -> Candidate Pipeline
  -> CompletionPostprocessor
  -> InlineEditBuilder
  -> VS Code display contract validation
  -> C/embedded quality gate
  -> InlineCompletionItem + telemetry
```

核心原则：

- 普通代码补全继续走 Qwen FIM。
- 自然语言命令和 comment-to-test 不走普通 FIM，走 instruction prompt。
- 符号补全优先使用确定性解析，不让模型猜项目符号。
- Inline completion 的 `replaceRange` 必须保持单行。
- 不展示 echoed prefix、重复注释、空输出、Markdown 解释、低置信度 placeholder 或 suffix-duplicated output。
- C/C++ embedded 补全在普通 inline edit 契约之后还有额外安全和质量门禁。

## 注册与配置入口

扩展启动时，`src/extension.ts` 注册：

```ts
vscode.languages.registerInlineCompletionItemProvider(
  { scheme: "file" },
  new RemoteCompletionProvider(...)
)
```

provider 总是注册，但每次触发时会先检查设置和文档类型：

- `opencode.remote.completion.enabled` 为 `false` 时直接跳过。
- 仅处理 `file` scheme 文档。
- `completion.provider === "opencode"` 时必须存在 active remote OpenCode client。
- `completion.provider === "openai-compatible"` 时必须配置 `completion.apiBaseUrl`，并且 `completion.model` 或 `defaultModel` 至少有一个可用模型名。

当前配置由 `readRemoteSettings()` 读取。以 `package.json` 和 `settings.ts` 为准，inline completion 相关字段包括：

| Setting | 用途 |
| --- | --- |
| `opencode.remote.completion.enabled` | 是否启用 inline completion。 |
| `opencode.remote.completion.provider` | `openai-compatible` 直连模型，或 `opencode` 旧兼容路径。 |
| `opencode.remote.completion.profile` | 直连补全文本协议：`generic-chat` 或 `qwen-coder-fim`。 |
| `opencode.remote.completion.apiBaseUrl` | OpenAI-compatible base URL。 |
| `opencode.remote.completion.model` | direct completion 模型名；为空时回退 `defaultModel`。 |
| `opencode.remote.completion.maxTokens` | direct completion 默认最大输出 token。 |
| `opencode.remote.completion.temperature` | direct completion 默认 temperature。 |
| `opencode.remote.completion.topP` | direct completion top-p。 |
| `opencode.remote.completion.debounceMs` | 请求远端前的 debounce。 |
| `opencode.remote.completion.logLevel` | `off`、`info` 或 `debug`。 |

直连 API key 通过命令 `OpenCode Remote: Set Inline Completion API Key` 保存到 VS Code SecretStorage，key 为 `opencode.remote.completion.apiKey`，不会写入 settings JSON。

## 一次请求的生命周期

主入口是 `RemoteCompletionProvider.provideInlineCompletionItems()`。

### 1. 采集光标上下文

provider 从当前文档和位置提取：

- `lineText`：当前整行文本。
- `linePrefix`：当前行光标前文本。
- `lineSuffix`：当前行光标后文本。
- `currentWord`：光标前以 `/[A-Za-z_][A-Za-z0-9_]*$/` 匹配到的当前词。
- `currentWordRange`：当前词在本行内的 range。
- `lines`：整个文档逐行文本。
- `previousNonEmptyLine` / `nextNonEmptyLine`：当前行上下最近非空行。
- `indent`：通过 `inferCompletionIndent()` 得出的 `targetIndent` 和 `indentUnit`。

缩进推断优先级：

1. 找附近同级 block opener 的 body indent。
2. 从整个文件已有缩进推断 tab 或空格宽度。
3. 回退到当前 VS Code editor/config 的 `insertSpaces` 和 `tabSize`。

### 2. 规划 CompletionPlan

`planCompletion()` 根据当前上下文返回 `CompletionPlan`。plan 决定：

- `kind`：场景类型。
- `insertMode`：如何插入或替换。
- `targetSymbol`：需要解析的目标符号。
- 是否需要符号检索或测试检索。
- 是否使用 FIM 或 instruction。
- token budget 和 confidence floor。

规划顺序很重要：

1. 先识别上一行注释意图的续写。
2. 空行先尝试 C/C++ body continuation，否则 disabled。
3. 注释中的符号前缀优先走 comment symbol reference。
4. unit test prompt 根据是否是注释分成 comment-to-test 或 natural-command。
5. 其他代码生成注释走 comment-to-code。
6. 字符串 literal 内禁用。
7. 低信号输入禁用。
8. 长度至少 3 的 identifier 走 symbol-completion。
9. 其余走 ordinary-code。

### 3. 请求协调

`CompletionRequestCoordinator` 负责交互层面的稳定性：

- 通过 request key 识别同一位置的重复请求。
- 同 key pending 请求直接复用。
- 新 key 到来时取消 stale pending 请求。
- 根据 `completion.debounceMs` 延迟远端请求。
- 远端成功结果缓存到最多 100 条。
- cache 命中前会重新验证 edit 是否仍满足 inline display invariant。
- 远端结果准备好后触发 `editor.action.inlineSuggest.trigger` 刷新 ghost text。

request key 包含：

- document URI
- language id
- completion provider
- completion profile
- direct provider 下的 document version
- line / character
- 当前整行文本

provider 还会构造一个 `localFallback`。它主要用于当前词控制流模板等极轻量 fallback，例如在没有模型文本时把 `while` 变成 brace language 的 while block。local fallback 同样必须先通过 edit validation 才会返回。

### 4. 后端路径

补全有两条后端路径，但中间流水线基本共用。

`openai-compatible`：

- 不要求 OpenCode connected。
- 使用 `CompletionModelClient`。
- `generic-chat` 调 `/chat/completions`。
- `qwen-coder-fim` 调 raw `/completions`。
- API key 从 SecretStorage 读取后以 `Authorization: Bearer ...` 发送。

`opencode`：

- 需要 active `RemoteOpenCodeClient`。
- 使用独立 inline completion session，标题来自 `INLINE_COMPLETION_SESSION_TITLE`。
- 如果 session not found，会清空 session id 后重建并重试一次。
- 发送模型使用 `parseModel(settings.defaultModel)`，空值则由远端服务使用默认模型。

## CompletionPlan 场景矩阵

| 场景 | 触发条件 | Plan kind | Insert mode | 检索 | 路由 |
| --- | --- | --- | --- | --- | --- |
| 普通代码续写 | 默认代码上下文 | `ordinary-code` | `insert-at-cursor` | 无符号检索 | Qwen FIM |
| C/C++ 函数体空行续写 | C/C++、空行、在代码 block 内、邻近代码行有信号 | `body-continuation` | `insert-at-cursor` | 无符号检索 | Qwen FIM |
| 普通符号补全 | 当前词长度至少 3 且是 identifier | `symbol-completion` | `replace-current-word` | 符号检索 | 高置信 deterministic，否则小预算 FIM assist |
| 注释里补符号前缀 | 单行注释中当前词像 identifier 前缀 | `comment-symbol-reference` | `replace-current-word` | 符号检索 | 高置信 deterministic；完整符号或 fallback 意图转 instruction；无候选则静默 |
| 注释转测试 | `// unit test for X` 或同类 test prompt | `comment-to-test` | `insert-after-line` | 符号 + 测试检索 | instruction |
| 自然语言测试命令 | 裸文本 `unit test for X` | `natural-command` | `replace-whole-line` | 符号 + 测试检索 | instruction |
| 注释转代码 | 单行注释中有 add/write/fix/return/function 等代码意图 | `comment-to-code` | `insert-after-line` | 默认不检索 | instruction |
| 上一行注释续写 | 上一非空行是注释意图，当前行空白或短 identifier | `previous-comment-continuation` | 空行 `insert-at-cursor`，否则 `replace-whole-line` | 有目标符号时检索；测试意图检索测试 | instruction |
| 禁用 | 空顶层、字符串内、低信号、标点-only 等 | `disabled` | `insert-at-cursor` | 无 | 不请求模型 |

## 场景细节

### 普通代码：`ordinary-code`

普通代码是最低优先级 fallback。只要没有命中特殊注释、测试命令、符号补全、禁用条件，就走 `ordinary-code`。

行为：

- `useFim: true`
- `useInstruction: false`
- `insertMode: insert-at-cursor`
- 默认不做符号检索。
- router 强制走 `qwen-fim`，`modelProfile` 和 `textProfile` 都是 `qwen-coder-fim`。
- token 上限使用 settings 中的 `completion.maxTokens`，再 clamp 到 `128..256`。
- temperature 被限制到 `<= 0.2`，避免普通 ghost text 过于发散。

该路径使用 Qwen FIM prompt，模型只需要填充 `<|fim_middle|>`。

### C/C++ 空白函数体续写：`body-continuation`

空行不一定禁用。对 C/C++，planner 会检查：

- 当前位置是空行。
- 当前光标在 C/C++ code block 里，而不是注释、字符串、struct/union/enum aggregate。
- 上下最近非空行像真实代码，不是 include、define、注释等。

命中后：

- 走 `body-continuation`。
- 仍使用 Qwen FIM。
- 自动触发 token budget 通常是 96，manual/invoke 触发时提高到 128。
- context pack 会对 C/embedded 相关 open tabs 做额外 boost。

### 符号补全：`symbol-completion`

当当前词是长度至少 3 的 identifier 时，planner 先假设用户可能在补项目符号。

流程：

1. 用 `currentWord` 作为 `targetSymbol` 和 code graph query。
2. `codeGraph.findSymbols()` 按 related path 查候选。
3. `resolveSymbols()` 对候选做确定性匹配和排序。
4. router 如果找到高置信 longer prefix，则直接返回 deterministic symbol，不调用模型。
5. 如果没有高置信 deterministic，但仍是 symbol plan，则走小预算 Qwen FIM assist。

deterministic symbol 的条件：

- plan kind 是 `symbol-completion` 或 `comment-symbol-reference`。
- candidate name 长于 target。
- candidate name lower-case 以 target lower-case 开头。
- snippet score 不低于 `1000`。

最终 edit 使用 `replace-current-word`，只替换当前词 range。

### 注释中的符号引用：`comment-symbol-reference`

注释里的 identifier 前缀有两类可能：

- 用户还在补符号名，例如 `// unit test for epr_ppn_raw_wr|`。
- 用户已经写完符号名，此时应该转为 comment-to-code 或 comment-to-test 生成代码。

planner 先把它识别为 `comment-symbol-reference`，避免直接生成测试体导致符号还没写完就大块补全。

路由前会调用 `resolveCompletionPlanAfterSymbolRetrieval()`：

- 如果检索到 exact symbol，说明注释里的符号已经完整，转成 instruction plan。
- 如果检索到 longer high-confidence symbol，保持 `comment-symbol-reference`，走 deterministic symbol 补全。
- 如果没有 longer symbol，但原注释有 test/code fallback intent，则转成 instruction plan。
- 如果没有候选也没有 fallback intent，则 route `none`，静默不展示。

这个逻辑是已知回归用例的关键：`epr_ppn_raw_wr` 应通过通用缩写/前缀规则解析到真实项目符号，而不是硬编码具体函数名。

### 注释转测试：`comment-to-test`

典型输入：

```c
// unit test for epr_ppn_raw_write_cb_dfx()
```

行为：

- plan kind 是 `comment-to-test`。
- `insertMode: insert-after-line`，保留用户原注释，在下一行插入生成代码。
- `needsSymbolRetrieval: true`
- `needsTestRetrieval: true`
- 使用 instruction prompt，不使用 FIM。
- token budget 为 768，context token budget 为 1800。

后处理会特别处理重复注释：

- 如果模型输出第一行重复当前注释，会剥掉该注释。
- 如果输出只有重复注释，没有真实代码，会以 `repeated-comment` 拒绝。
- 如果生成的前导注释后面有真实代码，instruction plan 会剥掉这些生成注释，只保留真实代码。

### 自然语言测试命令：`natural-command`

典型输入：

```text
unit test for epr_ppn_raw_wr
```

行为：

- plan kind 是 `natural-command`。
- `insertMode: replace-whole-line`。
- 替换当前行从第一个非空字符到行尾的 range。
- 检索目标符号和相似测试。
- 使用 instruction prompt。
- 允许 whole-line replacement 不要求 insertText 以原自然语言命令开头。

这条路径用于把裸自然语言命令替换成真实代码，避免把命令本身保留在文件里。

### 注释转代码：`comment-to-code`

当单行注释不是 test prompt，但包含通用代码意图词时，例如 add/write/fix/return/function/method/class，会进入 `comment-to-code`。

行为：

- `insertMode: insert-after-line`
- 默认不做符号检索。
- 使用 instruction prompt。
- token budget 为 384。
- 后处理会拒绝纯结构输出、纯生成注释、placeholder 和解释文本。

### 上一行注释续写：`previous-comment-continuation`

如果上一非空行是注释意图，而当前行为空或只有短代码前缀，则 planner 会把当前行作为上一行注释的续写。

行为：

- 当前行空白时使用 `insert-at-cursor`。
- 当前行有短前缀时使用 `replace-whole-line`。
- 如果上一行注释里能提取目标符号，则做符号检索。
- 如果上一行是测试意图，则同时做测试检索，token budget 为 768。
- prompt 会显式包含 `Source comment` 和 `Current line prefix`。

这让用户可以先写注释，再在下一行直接触发代码生成，或者输入部分代码前缀后让补全替换当前短前缀。

### 禁用：`disabled`

以下情况不会请求模型：

- 当前是空行且不属于 C/C++ body continuation。
- 输入只有低信号标点。
- 当前词太短且不是明确上下文，例如裸 `a`、`ab`。
- 光标在支持语言的字符串 literal 内。
- planner 明确判断为 disabled。

禁用会输出 telemetry，reject reason 是 `disabled-plan` 或相关计划原因。

## 符号解析

符号候选来自本地 code graph：

```ts
codeGraph.findSymbols({
  query,
  relatedPath,
  limit
})
```

检索 limit：

- `comment-symbol-reference`：50
- test retrieval：30
- 其他 symbol retrieval：8

`resolveSymbols()` 不使用具体业务函数名硬编码，而是通用打分：

| 信号 | 说明 |
| --- | --- |
| exact | 查询和符号名规范化后完全相等，基础分最高。 |
| prefix | 符号名以查询开头。 |
| token exact | snake/camel token 逐段精确命中。 |
| token prefix | query token 是 name token 前缀。 |
| token abbrev | query token 是 name token 子序列缩写。 |
| subsequence | 整体 query 是去下划线 name 的子序列。 |
| source rank | open document、code graph、workspace、retrieved snippet 有不同加分。 |
| same file | 候选和当前文件相同加分。 |
| nearby above | 注释符号引用时偏好光标上方最近符号。 |
| same directory | 候选和当前文件同目录加分。 |
| kind bonus | unit test target 强烈偏好 function/method。 |

排序稳定性：

1. 总分高者优先。
2. match score 高者优先。
3. kind bonus 高者优先。
4. 原始输入顺序。
5. 名称字典序。

候选最终通过 `completionSnippetFromSymbol()` 转成 `RetrievedCompletionSnippet`。如果路径或名称像 test/spec/mock/fixture，会标为 `existing test`，便于 context pack 识别相似测试。

## 上下文检索与打包

### Symbol snippets

只有 plan 需要符号或测试检索时才执行 `retrieveCompletionSnippets()`。如果没有 code graph，或者 query 为空，直接返回空 snippets。

query 优先级：

1. `plan.targetSymbol`
2. `completionSymbolQuery(editInput)` 从当前 prefix 里找最后一个非 stopword identifier。

### Local analysis evidence

`retrieveCompletionAnalysisEvidence()` 只在以下条件满足时执行：

- 有 `deps.codeGraph`
- `settings.codeGraph.enabled`
- 当前语言是 C/C++
- 能构造非空 evidence question

question 包含：

- 当前语言和文件路径。
- plan kind。
- target symbol 和 retrieved snippets 里的 symbol names。
- source comment。
- 当前 cursor line。

它调用 `codeGraph.queryEvidence(question)`，把返回的 evidence pack text 作为 `analysis-evidence` context block。

### Context pack

`packCompletionContext()` 把候选上下文转成带分数和 token 估算的 blocks，再按分数排序，直到 token budget 用完。放不下的 block 会进入 `dropped`，并写入 debug telemetry。

block 类型：

- `target-symbol`
- `similar-test`
- `test-framework`
- `include`
- `open-tab`
- `analysis-evidence`
- `current-prefix`
- `current-suffix`
- `current-function`
- `recent-file`

当前实现主要使用 target symbol、similar tests、test framework、includes、open tabs、analysis evidence 和 current prefix/suffix。

token budget：

| Plan kind | Token budget |
| --- | --- |
| `symbol-completion` | 240 |
| `comment-symbol-reference` | 120 |
| `previous-comment-continuation` 测试意图 | 1800 |
| `previous-comment-continuation` 非测试 | 900 |
| `comment-to-test` / `natural-command` | 1800 |
| `ordinary-code` / `body-continuation` / `comment-to-code` | 900 |
| `disabled` | 0 |

不同场景选择的 block 也不同：

- symbol completion 只需要 target symbol 或少量 snippet。
- comment-to-test 和 natural-command 会加入 target symbol、similar tests、test framework、analysis evidence、open tabs、current file。
- ordinary/body/comment-to-code 主要加入 target、includes、analysis evidence、open tabs、current file。

## 模型路由

路由由 `routeCompletionModel()` 决定。

### Deterministic symbol

如果当前 plan 是 symbol completion 或 comment symbol reference，并且 resolved snippets 中有高置信 longer prefix symbol，则直接返回：

```ts
{
  kind: "deterministic-symbol",
  reason: "high-confidence-symbol",
  text: selected.name
}
```

这条路径不调用模型，后续仍会走 postprocess、edit builder 和 validation，保证 VS Code inline contract 一致。

### Instruction route

以下场景使用 instruction route：

- `comment-to-test`
- `natural-command`
- `previous-comment-continuation`
- `comment-to-code`

instruction route 使用：

- `promptKind: "instruction"`
- `modelProfile: "generic-chat"`
- `textProfile: "generic-chat"`
- `temperature: 0`
- `topP: settings.completion.topP`
- token clamp 到 `1..1024`

### Qwen FIM route

以下场景使用 Qwen FIM：

- `ordinary-code`
- `body-continuation`
- `symbol-completion` 的 model assist fallback

普通代码和 body continuation：

- `promptKind: "qwen-fim"`
- `modelProfile: "qwen-coder-fim"`
- `textProfile: "qwen-coder-fim"`
- 普通代码 token clamp 到 `128..256`
- body continuation token clamp 到 `96..128`
- temperature clamp 到 `<= 0.2`

symbol assist：

- token clamp 到 `64..128`
- temperature 为 0

### None route

未解析到候选的 `comment-symbol-reference` 不回退模型，直接 route `none`，reason 是 `no-symbol-candidate`。这样可以避免注释里半截符号还没写完时，模型突然生成大段代码。

## Prompt 构造

### Qwen Coder FIM prompt

`buildQwenCoderFimPrompt()` 构造 raw FIM prompt。顺序是：

```text
<|repo_name|>{repoName}
<|file_sep|>{path}

<repo_context>
...
</repo_context>

/* C/C++ inline completion contract, if language is c/cpp */
<|fim_prefix|>{prefix}
<|fim_suffix|>{suffix}
<|fim_middle|>
```

prefix 范围是当前行前最多 80 行到光标，suffix 范围是光标到最多后 60 行。文本长度受 `settings.context.maxFileBytes` 控制，suffix 使用大约一半预算。

C/C++ 会额外插入 FIM 规则，例如：

- 只返回 cursor hole 的 exact text。
- 不输出 Markdown、解释、代码围栏。
- 在 `if (` 或 `for (` 中只返回条件或 loop header fields，不重复括号和 block。
- 保留已有 suffix 的括号、分号和缩进。
- 优先使用当前文件、open tabs 和 retrieved context 中可见的变量、宏和函数。
- 不发明 embedded API 或 placeholder。

直连 `qwen-coder-fim` profile 会请求 `/completions`，并设置 Qwen FIM stop tokens。

### Instruction prompt

`buildInstructionCompletionPrompt()` 用于 comment-to-code、comment-to-test、natural-command 和 previous-comment-continuation。

prompt 包含：

- 任务描述：生成 unit test 或根据当前注释生成代码。
- previous-comment-continuation 的 source comment 和 current line prefix。
- 规则：不重复用户当前行、不输出 Markdown、不解释、只输出代码、使用目标符号和相似测试。
- 语言规则。
- `formatInstructionContext()` 输出的 target symbol、similar tests、test framework、analysis evidence、current file。
- 当前文件 prefix/suffix。

直连 `generic-chat` profile 会把这个 prompt 包进 OpenAI-compatible chat messages：

- system：说明这是 inline code completion engine，final visible output 只能是插入文本。
- user：完整 prompt。

## 模型响应提取

模型返回统一转成 `OpenCodeMessage`，再由 `completionInsertText()` 提取可见文本。

处理规则：

- `splitThinkingFromParts()` 会把 reasoning 和 visible text 拆开。
- `generic-chat` 优先使用 text part，清理 code fence、Qwen special token、meta lead-in、prompt leak 行。
- `qwen-coder-fim` 走更保守清理，主要删除特殊 token、围栏和元文本。
- reasoning 默认不会插入；只有 reasoning 中出现 fenced code，或 `Final:` / `Answer:` / `Completion:` 这类明确 final marker 时才作为兜底提取。
- prompt leak 行会被当作 meta line 清掉。

## Candidate pipeline

`runCompletionCandidatePipeline()` 把 raw output 转成最终可用 edit。

流程：

1. 得到 `rawText`。
2. 调 `postprocessCompletion()`。
3. 根据 postprocess reject reason 尝试 test fallback 或 symbol fallback。
4. 用 `buildInlineCompletionEditResult()` 构造 edit。
5. 用 `adaptAndValidateInlineCompletionEdit()` 验证 VS Code inline display contract。
6. 返回 accepted/rejected、raw/postprocess/candidate/edit 文本、reason 和耗时。

### 后处理规则

`postprocessCompletion()` 负责防止坏 ghost text 展示。

主要步骤：

- 统一换行，删除 Qwen special tokens 和 `</s>`。
- 提取第一段 fenced code。
- 去掉 wrapping fence。
- C-style inline code 如果整个输出被单个反引号包裹，解开反引号。
- 去掉 leading meta lines，例如 `Sure`、`Here is the completion:`、代码围栏标记。
- 去掉解释性 lead-in。
- 剥离重复当前整行的 echo。
- 检测 prefix echo：
  - exact echo 直接拒绝。
  - `insert-at-cursor` 下，如果模型返回了完整当前行，会转成 delta。
  - replace 模式下保留 full candidate 交给 edit builder。
- 对 current-word replacement 保留以当前词开头的候选。
- 处理 suffix overlap：
  - 中行补全只保留第一行。
  - 如果输出从 closing punctuation suffix 开始，拒绝为 `suffix-duplicated-output`。
  - 对 `;`、`,`、`]` 等重复 suffix 做剥离。
  - 对 `)`、`]`、`}` 会看 delimiter imbalance，避免把必要 closing paren 错剥掉。
- 归一化多行公共缩进。
- instruction plan 中，如果生成了前导注释但后面有真实代码，剥掉前导生成注释。
- 拒绝 explanation-only。
- 拒绝低置信度 placeholder、`TODO`、`your code here`、纯结构代码片段等。

常见 postprocess reject reason：

| Reason | 含义 |
| --- | --- |
| `empty-output` | 模型输出为空或清理后为空。 |
| `echoed-prefix` | 输出只是重复当前 prefix。 |
| `repeated-comment` | comment-to-code/test 输出只重复了当前注释。 |
| `explanation-only` | 输出只有解释，没有代码。 |
| `low-confidence-output` | 输出是 placeholder、纯结构片段或其他低置信度内容。 |
| `suffix-duplicated-output` | 中行补全会重复当前 suffix。 |

### Fallback

fallback 有两类。

test fallback：

- 仅用于 `natural-command`、`comment-to-test`、或带 test intent 的 `previous-comment-continuation`。
- 必须已有 reject reason。
- 优先从高分 retrieved snippets 中选择非 test symbol。
- C-style 生成：

```c
static void test_symbol(void)
{
    (void)symbol();
}
```

- 非 C-style 生成：

```ts
test("symbol", () => {
    symbol()
})
```

symbol fallback：

- 如果 plan 要替换当前词，且 retrieved snippets 中有以当前词开头的更长 name，则使用该 name。

## Inline edit 构造

`buildInlineCompletionEditResult()` 按 plan 的 `insertMode` 选择策略。

### `replace-current-word`

用于 symbol completion 和 comment symbol reference。

行为：

- 优先 `currentWordLinePrefixReplacement()`，处理模型返回整行 prefix + 补全符号的情况。
- 否则 `currentWordReplacement()`，要求候选以当前词开头。
- replace range 是当前词的单行 range。
- `filterText` 是完整 replacement text。
- `formatRange` 覆盖插入后的范围，接受后局部格式化。

### `insert-at-cursor`

用于 ordinary-code、body-continuation、空行 previous-comment-continuation。

行为：

- range 是光标处 zero-width range。
- 不允许在非 block/comment prompt 上下文中返回 misaligned leading newline。
- `formatCompletionInsertText()` 会根据 block opener、comment prompt、空白缩进行做语言感知格式化。

### `insert-after-line`

用于 comment-to-code 和 comment-to-test。

行为：

- 插入位置是当前整行末尾，即 `linePrefix.length + lineSuffix.length`。
- `formatCompletionBlock()` 会把模型代码放到下一行，并按当前行 indent 格式化。
- 当前注释保留，生成代码在下一行出现。

### `replace-whole-line`

用于 natural-command，以及带短前缀的 previous-comment-continuation。

行为：

- replace range 从当前行第一个非空字符到当前行末尾。
- `filterText` 默认是 insertText。
- 对 `natural-command`，validation 允许 insertText 不保留原自然语言命令。
- 对其他 whole-line replacement，仍会尽量保持安全替换语义。

## VS Code inline display 契约

所有 edit 在返回前必须通过 `adaptAndValidateInlineCompletionEdit()`。

硬性要求：

- `replaceRange` 必须是单行 range。
- `filterText` 必须以被替换 range 的文本开头。
- 如果 range 非空，insertText 必须以安全方式保留或扩展 range text。
- `selectedCompletionInfo` 存在时：
  - edit range 必须匹配 VS Code 给出的 selected range，或能安全收缩成该 range。
  - insertText 必须以 selected text 开头。

适配逻辑：

- `selectedCompletionInfo` 优先，避免 VS Code 已有选择态被破坏。
- current word replacement 可以从更宽 range 收缩到 current word range。
- whole-line replacement 可以在安全时调整 `filterText` 为 range text。
- 无法满足契约时拒绝，不返回 ghost text。

这些约束是为什么 inline completion range 始终保持单行，即使 insertText 本身可以是多行。

## 接受后的格式化

`inlineItem()` 创建 `vscode.InlineCompletionItem` 时，如果 edit 带 `formatRange`，会挂上 `completionFormatCommand()`。

接受补全后，该命令尝试只格式化刚插入的小范围：

- 有 formatter provider 时执行 range formatting。
- 没有 formatter 或失败时安全跳过。
- 这避免把整个文件格式化，也避免补全接受后产生大范围不相关 diff。

## C/C++ embedded 运行时质量门禁

普通 edit validation 通过后，如果语言是 `c` 或 `cpp`，provider 会调用 `scoreCEmbeddedCompletionQuality()`。

运行时 fixture 特点：

- 自动触发最多 4 行。
- 手动触发最多 12 行。
- 检查维度包括 VS Code edit contract、C syntax/format、embedded semantics、project context、safety、auto-show suitability、stability、latency。

运行时启用的 checks：

- `checkVscodeContract`
- `checkApplyEditResult`
- `checkCParseOrCompile`
- `checkNoMarkdownOrExplanation`
- `checkNoPlaceholder`
- `checkNoDangerousC`
- `checkNoHallucinatedSymbol`
- `checkEmbeddedSafety`

常见 hard reject：

- replace range 跨行。
- edit 应用后文档不变。
- 自动触发下 C parse/compile 明显失败。
- Markdown、解释、反引号。
- TODO、placeholder、`your code here`。
- `sprintf`、`strcpy`、`strcat`、`gets` 等危险调用。
- 没有边界检查的 buffer write/copy。
- ISR 上下文中阻塞调用。
- busy loop 没有 timeout/yield/break/return。
- MMIO/register 场景丢失 `volatile`。
- 未在上下文中出现的高风险项目 API 或宏。

如果 hard reject，provider 返回 `quality:<issue kind>`，不会展示补全。

## Retry 策略

`completionOutcomeWithRetry()` 最多重试一次。

会重试：

- `quality:placeholder`
- `quality:C parse/compile`
- `quality:markdown/explanation`
- generic instruction 的 `misaligned-leading-newline`
- generic instruction 的 `low-confidence-output`

不会因为低置信度重试 FIM：

- `textProfile === "qwen-coder-fim"` 时，低置信度不重试。

retry prompt：

- instruction route 会在原 prompt 后追加 `<completion-feedback>`。
- FIM route 会把 C-style feedback comment 插入到 `<|fim_prefix|>` 前。

feedback 会明确告诉模型上一次为何被拒绝，例如 placeholder、C parse/compile、Markdown/explanation 或 leading newline misalignment。

## 日志与遥测

日志写入 `OpenCode Remote` output channel。

`info` 级别常见日志：

| 日志 | 含义 |
| --- | --- |
| `triggered` | VS Code 触发 provider。 |
| `scheduled` | 请求进入 debounce。 |
| `reuse-pending` | 同 key 复用已有 pending。 |
| `cancelled` | stale key、clear 或 VS Code token 取消。 |
| `sent` | prompt 已发给后端。 |
| `received` | 后端返回。 |
| `empty` | 候选为空或被 postprocess/edit 拒绝。 |
| `edit-ready` | 已构造可用 edit。 |
| `quality-rejected` | C/C++ 质量门禁拒绝。 |
| `retry-sent` / `retry-received` | 触发一次 retry。 |
| `retry-edit-ready` / `retry-edit-rejected` | retry 后 edit 成功或失败。 |
| `returned` | provider 返回 `InlineCompletionItem`。 |

`debug` 级别会额外输出：

- route 类型和原因。
- symbol retrieval 数量。
- context selected/dropped kinds 和 token budget。
- raw first line、postprocess first line。
- prefixMode、stripReason。
- replaceRange、rangeText、insertFirstLine、filterText。
- displayRisk。
- `[completion-telemetry]` JSON。

telemetry 关键字段：

| 字段 | 含义 |
| --- | --- |
| `requestId` | `cc-...` 格式请求 id。 |
| `languageId` | VS Code language id。 |
| `filePathHash` | 文件路径 hash，避免直接暴露绝对路径。 |
| `triggerKind` | automatic、invoke 或其他 VS Code trigger kind。 |
| `planKind` | planner 输出的场景。 |
| `insertMode` | edit 插入策略。 |
| `currentWord` | 当前词，已截断。 |
| `targetSymbol` | 目标符号，已截断。 |
| `symbolCandidates` | top symbol candidates。 |
| `selectedContextBlocks` | 被选入 prompt 的 context blocks。 |
| `droppedContextBlocks` | 因 token budget 被丢弃的 blocks。 |
| `modelRoute` | `fim`、`instruction`、`deterministic-symbol` 或 `none`。 |
| `rawOutputLength` | 原始输出长度。 |
| `normalizedOutputLength` | 后处理后输出长度。 |
| `finalRange` | 最终 inline edit range。 |
| `filterText` | VS Code filter text，已截断。 |
| `accepted` | 是否展示。 |
| `rejectReason` | 未展示原因。 |
| `latencyMs` | planning/symbol/context/model/postprocess/edit/total 耗时。 |

## 常见场景走向示例

### 输入裸测试命令

```text
unit test for epr_ppn_raw_wr
```

预期路径：

1. planner 识别为 `natural-command`。
2. `targetSymbol` 是 `epr_ppn_raw_wr`。
3. symbol resolver 使用通用 prefix/token/abbrev/subsequence 规则解析真实函数。
4. router 走 instruction。
5. context pack 注入 target symbol、similar tests、test framework。
6. edit 使用 `replace-whole-line`。
7. 若模型 echo 原命令，会被拒绝或 fallback，不展示 echoed prefix。

### 输入注释测试命令

```c
// unit test for epr_ppn_raw_write_cb_dfx()
```

预期路径：

1. planner 识别为 `comment-to-test`。
2. router 走 instruction。
3. edit 使用 `insert-after-line`。
4. 原注释保留。
5. 如果模型重复注释，postprocess 剥离重复注释。
6. 只有真实测试代码会插入下一行。

### 注释里补符号前缀

```c
// unit test for epr_ppn_raw_wr|
```

预期路径：

1. planner 先识别为 `comment-symbol-reference`。
2. symbol resolver 找 longer high-confidence symbol。
3. router 返回 deterministic symbol，不调用模型。
4. edit 使用 `replace-current-word`，只把当前前缀补成完整符号。

### 中行补条件表达式

```c
if (|)
```

预期路径：

1. 通常走 `ordinary-code` 或相关 code path。
2. Qwen FIM prompt 中 suffix 包含 `)`。
3. C/C++ FIM 规则要求只返回 condition expression。
4. postprocess 若发现输出以 `)` 或其他 suffix echo 开头，会拒绝。
5. suffix overlap 会避免重复 `);`、`)`、`]` 等 closing punctuation。

### 空白 C 函数体内自动补全

```c
void tick(void)
{
    |
}
```

预期路径：

1. 空行、C/C++、在 code block 内，命中 `body-continuation`。
2. 使用 Qwen FIM。
3. context pack 注入当前 prefix/suffix、open tabs、analysis evidence。
4. 自动触发下 C/embedded quality gate 限制大块输出和危险代码。

### 上一行注释后续写

```ts
// add validation for payload
|
```

预期路径：

1. planner 识别 `previous-comment-continuation`。
2. 空行使用 `insert-at-cursor`。
3. instruction prompt 包含 source comment。
4. 输出代码而不是重复注释。

## 测试地图

补全模块有比较完整的测试覆盖。修改生产逻辑前应先新增或更新对应测试。

| 测试文件 | 覆盖点 |
| --- | --- |
| `test/completion-plan.test.ts` | plan kind、insert mode、注释/测试/符号/空行/禁用场景。 |
| `test/completion-router.test.ts` | deterministic symbol、FIM、instruction、none route、retry 策略。 |
| `test/completion-symbol.test.ts` | 符号 exact/prefix/abbrev/subsequence 排序、同文件和附近优先。 |
| `test/completion-context.test.ts` | context pack、Qwen FIM prompt、instruction prompt、analysis evidence、test framework。 |
| `test/completion-postprocess.test.ts` | Markdown、echo、重复注释、suffix overlap、低置信度、indent normalization。 |
| `test/completion-edit.test.ts` | insert modes、range/filterText 契约、selectedCompletionInfo、缩进、控制流 fallback。 |
| `test/completion-request-coordinator.test.ts` | pending 复用、取消、cache、local fallback validation。 |
| `test/completion-model-client.test.ts` | direct `/chat/completions`、raw `/completions`、URL、参数 override、错误处理。 |
| `test/completion-c-embedded-quality.test.ts` | C/embedded hard reject、质量分、门禁阈值。 |
| `test/completion/phase1-regression-eval.test.ts` | 已知回归和泛化规则。 |
| `test/completion/phase10-e2e.test.ts` | 补全流水线端到端 fixture。 |
| `test/completion-command.test.ts` | provider wiring、日志字段、format command、direct provider decoupling。 |
| `test/completion-telemetry.test.ts` | request id、路径 hash、telemetry sanitize 和 route 映射。 |

常用验证命令：

```bash
bun test test/completion-plan.test.ts test/completion-router.test.ts test/completion-symbol.test.ts test/completion-context.test.ts test/completion-postprocess.test.ts test/completion-edit.test.ts
bun test test/completion/phase1-regression-eval.test.ts test/completion/phase10-e2e.test.ts
bun run package
```

本仓库交付前要求执行 `bun run package`。它会跑 type checking、linting 和 TypeScript compilation。

## 维护注意事项

- 不要通过 prompt tweaking 单独修补补全质量问题。优先调整 planner、symbol resolver、context packer、router、postprocess、edit builder 或质量门禁。
- 不要在生产逻辑中硬编码具体函数名、变量名、业务字符串或单个回归样例文本。
- 新增回归必须验证通用结构性规则覆盖该例，而不是为该例加特判。
- 普通代码补全必须继续保留 Qwen FIM。
- 自然语言命令和 comment-to-test 不得走普通 FIM。
- 符号补全必须优先 deterministic symbol resolution。
- inline completion range 必须保持单行。
- 任何返回给 VS Code 的 edit 都必须满足 `filterText` 和 range text 的前缀契约。
- C/C++ embedded 场景如果修改质量门禁，要同步更新质量 fixture 或相关测试。
- 如果新增 context block 类型，需要同步考虑 token budget、telemetry selected/dropped 显示和 prompt 格式化。

## 排障速查

| 现象 | 优先检查 |
| --- | --- |
| 没有任何补全日志 | `completion.enabled`、文档是否是 `file` scheme、provider 是否注册。 |
| 只有 `triggered` 没有 `sent` | debounce 期间被取消、plan disabled、provider 配置缺失。 |
| `route=none` | 多见于 unresolved `comment-symbol-reference`，说明没有高置信符号候选。 |
| `empty reason=echoed-prefix` | 模型只重复了当前 prefix。 |
| `empty reason=repeated-comment` | comment-to-code/test 只重复了用户注释。 |
| `suffix-duplicated-output` | 中行补全会重复当前 suffix。 |
| `rangeText-not-prefix-of-filterText` | edit 违反 VS Code inline display 契约。 |
| `selectedCompletionInfo-range-mismatch` | VS Code 当前已有 selected completion，edit range 没有对齐。 |
| `quality:placeholder` | C/C++ 输出包含 TODO、placeholder 或 scaffold-only 文本。 |
| `quality:C parse/compile` | C/C++ 应用后的代码静态语法或 clang 检查失败。 |
| `quality:hallucinated API` | C/C++ 输出使用了上下文中不可见的高风险项目符号。 |

打开 `opencode.remote.completion.logLevel = "debug"` 后，重点看：

- `planKind` 和 `insertMode` 是否符合预期。
- `symbolCandidates` 是否命中真实目标。
- `selectedContextBlocks` 是否包含目标符号和相似测试。
- `modelRoute` 是否是预期的 `fim`、`instruction` 或 `deterministic-symbol`。
- `rawFirstLine` / `postprocessFirstLine` 是否显示模型 echo、解释或 suffix。
- `replaceRange`、`rangeText`、`filterText` 是否满足 VS Code 契约。
