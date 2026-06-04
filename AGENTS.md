# Project Instructions

## Response Language

- All assistant responses to the user must be written in Chinese, even when the
  user asks in another language. Code, commands, file paths, logs, API names,
  package names, and text that must be quoted verbatim may remain in their
  original language.

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
