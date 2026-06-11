# ChipMate Inline Completion README

这份文档说明 ChipMate VS Code 扩展中的 inline completion 实现。它面向维护者和开发者，重点描述一次补全请求从 VS Code 触发，到规划、检索、模型路由、候选清洗、inline edit 构造、质量门禁和 telemetry 的完整路径。

## 总体架构

补全不是一次裸模型调用，而是一条产品级流水线：

```text
src/extension.ts
  -> inline completion provider
  -> planCompletion()
  -> retrieveCompletionSnippets()
  -> retrieveCompletionAnalysisEvidence()
  -> resolveCompletionPlanAfterSymbolRetrieval()
  -> routeCompletionModel()
  -> buildQwenCoderFimPrompt() / buildCompletionPrompt()
  -> CompletionModelClient
  -> runCompletionCandidatePipeline()
  -> postprocessCompletion()
  -> buildInlineCompletionEditResult()
  -> adaptAndValidateInlineCompletionEdit()
  -> scoreCEmbeddedCompletionQuality()
  -> InlineCompletionItem + structured telemetry
```

模型请求只走 OpenAI-compatible provider。补全和聊天共享 `chipmate.provider.apiBaseUrl` 与 SecretStorage 中的 provider API key；补全模型由 `chipmate.completion.model` 指定，未设置时回退到 `chipmate.provider.chatModel`。

## 核心原则

- 普通代码、C/C++ embedded、函数体续写和 top-level declaration 继续使用 Qwen FIM profile。
- 自然语言命令、comment-to-test 和 comment-to-code 使用 instruction prompt，不走普通 FIM。
- 符号补全优先使用确定性 symbol resolution；只有不满足高置信唯一符号时才进入模型辅助。
- typed prefix 只作为兼容性、投影和 edit 约束，不作为业务特例或生产硬匹配。
- inline completion 的 replace range 必须是单行。
- 不展示 echoed prefix、重复注释、空输出、Markdown 解释、protocol artifact、低置信度 placeholder 或 suffix-duplicated output。
- C/C++ embedded 在普通 VS Code edit 契约之后还有运行时质量门禁。

## 关键模块

| 文件 | 主要职责 |
| --- | --- |
| `src/extension.ts` | 注册 provider、命令、code graph、settings 和 workspace-host runtime。 |
| `src/completion.ts` | provider 主入口，串联规划、检索、路由、prompt、模型调用、候选流水线、质量门禁、缓存刷新和 telemetry。 |
| `src/completion-plan.ts` | 根据光标上下文产出 `CompletionPlan`，决定 plan kind、insert mode、检索需求、FIM/instruction 和 token budget。 |
| `src/completion-retrieval.ts` | 把 plan 和 cursor shape 转成 symbol query、evidence question、retrieval policy 和 preferred symbol kinds。 |
| `src/completion-symbol.ts` | 对 code graph symbol candidates 做 prefix/token/abbrev/subsequence 排序和确定性解析。 |
| `src/completion-context.ts` | 将 target symbol、tests、open tabs、current prefix/suffix、analysis evidence 按 token budget 打包进 prompt。 |
| `src/completion-router.ts` | 将 plan 和 snippets 路由到 deterministic symbol、Qwen FIM、instruction 或 none。 |
| `src/completion-model-client.ts` | 直连 OpenAI-compatible `/chat/completions` 或 raw `/completions`。 |
| `src/completion-candidate-pipeline.ts` | 从模型消息提取文本，执行 postprocess、fallback、edit builder、edit contract validation。 |
| `src/completion-postprocess.ts` | 清理模型输出，处理 echo、重复注释、suffix overlap、protocol artifact 和 C intent 截断。 |
| `src/completion-edit.ts` | 构造 VS Code inline edit，并验证 range/filterText/selectedCompletionInfo/接受语义。 |
| `src/completion-c-embedded-quality.ts` | C/C++ embedded runtime quality gate。 |
| `src/completion-telemetry.ts` | 结构化 completion debug event、路径 hash、字段截断和 route 映射。 |

## 注册与配置

扩展启动时在 workspace extension host 注册 `file` scheme 的 inline completion provider。Remote SSH 场景下，provider、code graph、RAG 和模型请求都运行在远端 Linux extension host。

常用配置：

| Setting | 用途 |
| --- | --- |
| `chipmate.completion.enabled` | 是否启用 inline completion。 |
| `chipmate.completion.profile` | 补全文本协议：`generic-chat` 或 `qwen-coder-fim`。 |
| `chipmate.completion.model` | completion 模型名；为空时回退聊天模型。 |
| `chipmate.completion.maxTokens` | completion 最大输出 token。 |
| `chipmate.completion.temperature` | completion temperature。 |
| `chipmate.completion.topP` | completion top-p。 |
| `chipmate.completion.debounceMs` | 请求模型前的 debounce。 |
| `chipmate.completion.logLevel` | `off`、`info`、`debug`。 |
| `chipmate.completion.debugFullRetrievalProbe` | 为 C embedded retrieval 写出完整 live debug dump。 |
| `chipmate.completion.debugExpectedSymbol` | debug probe 中检查目标 symbol 是否进入各阶段。 |
| `chipmate.completion.commentGuidedRetrievalMode` | comment-guided C code 的 retrieval shape。 |
| `chipmate.provider.apiBaseUrl` | OpenAI-compatible base URL。 |
| `chipmate.provider.chatModel` | 聊天模型，也是 completion model 的 fallback。 |

API key 通过 `ChipMate: Set Provider API Key` 保存到 VS Code SecretStorage，key 不写入 settings JSON。

## 请求生命周期

provider 从当前文档和光标位置提取 line prefix/suffix、current word、附近非空行、缩进、语言和文件信息。`planCompletion()` 再决定是否需要 symbol retrieval、test retrieval、repository evidence、FIM prompt 或 instruction prompt。

进入模型前，ChipMate 会把 code graph、RAG、同文件/同目录片段、测试线索和当前 cursor contract 打包进 prompt。进入模型后，候选文本必须通过后处理、edit contract、单行 range 和 C/C++ embedded quality gate，最后才会返回给 VS Code。

## 调试信号

排查补全质量时优先看这些 telemetry 字段：

- `route`、`planKind`、`insertMode`
- `selectedPromptEvidenceNames`
- `selected/dropped evidence kinds`
- `qaRetrievalTopK`、`symbolPrefixSemanticTopK`
- `targetSymbol`、`sourceComment`
- `candidateTokenCoverage`
- `postprocessReason`
- `qualityGateReason`

日志写入 `ChipMate` output channel。开启 `chipmate.completion.logLevel = "debug"` 后，再配合 code graph/RAG 日志确认检索、路由、模型输出和 edit validation 的真实路径。
