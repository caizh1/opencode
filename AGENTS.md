# Project Instructions

## Response Language

- All assistant responses to the user must be written in Chinese, even when the
  user asks in another language. Code, commands, file paths, logs, API names,
  package names, and text that must be quoted verbatim may remain in their
  original language.

## Git / Push

- 推送 GitHub 远程时使用 SSH。当前网络下 GitHub SSH 22 端口可能不可用；如果
  `git@github.com` 连接失败，使用 SSH-over-443：
  `ssh://git@ssh.github.com:443/caizh1/opencode.git`。
- 优先通过 `~/.ssh/config` 将 `Host github.com` 映射到 `ssh.github.com` 的
  `443` 端口，这样普通 `git push origin <branch>` 也会自动走 443。

## 项目目标

- 本仓库包含一个用于 AI inline code completion 的 VS Code 扩展。

## AI Inline Completion

### 核心规则

- 不要只通过 prompt tweaking 解决补全质量问题。必须实现并保留产品级 completion pipeline：

1. `CompletionPlanner`
2. `SymbolResolver`
3. `ContextRetriever`
4. `ContextPacker`
5. `ModelRouter`
6. `CompletionPostprocessor`
7. `InlineEditBuilder`
8. Eval Fixtures
9. Structured Telemetry

### 泛化规则

- 设计、修复或评估 AI inline completion 规则时，不得用具体函数名、变量名、注释句子、业务字符串或单个示例文本做生产逻辑硬匹配。函数名、注释、自然语言意图和项目符号写法都是开放集合，必须用可泛化的结构性规则处理。
- 允许在测试 fixture、回归用例和文档说明中使用具体示例；但生产逻辑不得以这些示例字符串作为特殊分支、白名单、黑名单或正则锚点。
- 严禁在生产逻辑中 hardcode 单个现场问题或回归样例里的具体字符串，包括但不限于用户已输入的 typed prefix、函数名、变量名、路径、完整注释文本、业务域词、日志片段或单个 benchmark fixture。此类字符串只允许出现在测试 fixture、回归断言、文档说明、benchmark/report 输出中。生产逻辑必须通过通用结构信号实现，例如 `currentWord` 与模型输出的 prefix/suffix 关系、真实 codegraph/RAG/evidence symbol hints、C identifier 语法、cursor prefix/suffix、token coverage、semantic similarity、graph proximity、edit contract 校验等。
- 补全规则应优先基于通用信号：语言语法、identifier/token 结构、当前位置上下文、代码图符号解析、前缀/缩写匹配、同文件/同目录距离、已有测试形态、prefix/suffix 安全检查，以及模型输出的结构化后处理。
- 对注释意图补全，不要硬匹配某句自然语言。应先识别注释中的通用代码符号或符号前缀，并通过项目符号解析确认其真实性；自然语言意图本身交给 instruction prompt 和上下文理解。
- 对已知回归用例，只能验证“泛化规则能覆盖该例子”，不能把回归样例里的函数名、注释文本或路径写成专门逻辑。

### 必须保留

- 普通代码补全必须继续使用 Qwen FIM。
- 自然语言命令不得使用普通 FIM。
- Comment-to-test 不得使用普通 FIM。
- Symbol completion 必须优先使用确定性解析。
- Inline completion range 必须保持单行。
- 不要展示 echoed prefix、重复注释、空输出或 suffix-duplicated output。

### 已知回归用例

- `unit test for epr_ppn_raw_wr` 必须泛化解析到项目符号 `epr_ppn_raw_write_with_cb_dfx`，不要硬编码。
- `// unit test for epr_ppn_raw_write_cb_dfx()` 不得重复生成这行注释。

### 测试要求

- 修改生产逻辑前，先新增或更新测试。
- 每次变更后，按 `package.json` 中的真实命令执行验证；当前仓库通常使用 `bun test`、`bun run lint`、`bun run compile`。
- 最终交付前必须执行 `bun run package`，并确保通过。

## Development

- Use `bun install` to install dependencies.
- Use `bun run compile` for a quick local compile check.
- Use `bun test` when changing behavior covered by tests.
- Before development is considered complete, always run `bun run package`.

`bun run package` is the required final packaging/verification step. It runs
type checking, linting, and TypeScript compilation, and should pass before work
is handed off.

## Local Packaging

To produce a local VS Code extension package, run:

```bash
bun run vsix
```

This runs the package step first, then creates the `.vsix` artifact.

Before creating a local `.vsix`, check whether an `opencode-remote-*.vsix`
artifact already exists in the repository root. If a packaged `.vsix` already
exists locally, increment the patch version in `package.json` by 1 before
running `bun run vsix`, so the newly generated package has a fresh version
number.

After completing any bug fix or behavior change that should be tested in VS
Code, create a fresh local extension package before handing off the work. Follow
the same versioning rule above: if an `opencode-remote-*.vsix` already exists,
increment the patch version first, then run `bun run vsix` and report the new
`.vsix` filename.
