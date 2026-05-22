===============================================================================
  🏷️  AGENTS.MD LOADED — TAG: opencode-agents-v1
===============================================================================

- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## Linux 交叉编译流程（Windows 构建 Linux 可执行文件）

前置条件：Bun、Python 3.11+（用于 node-gyp 原生模块编译）、依赖已通过 `bun install` 安装。

### 1. 构建 Web UI（SolidJS 前端）

```powershell
cd packages/app
bun run build
```

输出在 `packages/app/dist/`，后续构建脚本会将其嵌入二进制。

### 2. 安装 Linux 平台原生依赖

```powershell
cd packages/opencode
bun install --os="linux" --cpu="x64" @opentui/core@0.2.14 @parcel/watcher@2.5.1
bun install --os="linux" --cpu="arm64" @opentui/core@0.2.14 @parcel/watcher@2.5.1
```

这会在 bun 缓存中下载 Linux 平台的 `@opentui/core-linux-*` 和 `@parcel/watcher-linux-*-glibc/musl` 原生包，供交叉编译使用。

### 3. 编译 Linux 二进制

```powershell
# 必须设 channel 为 latest（否则数据库路径变为 opencode-dev.db 导致历史丢失）
$env:OPENCODE_CHANNEL="latest"

# 跳过分发版原生包安装（已在 Step 2 手动完成），构建所有 6 个 Linux 变体
bun run script/build.ts --skip-install
```

### 4. 若构建因 darwin/win32 中断，临时修改 build.ts

全量 `allTargets` 包含 darwin/win32 目标，它们缺少对应的原生包会报错退出。只保留 linux 目标：

```ts
// packages/opencode/script/build.ts:83 处暂时删除 darwin/win32
const allTargets = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
]
```

构建完毕后恢复 darwin/win32 条目。

### 5. 输出产物

全部在 `packages/opencode/dist/` 下：

| 目录 | 二进制路径 | 适用环境 |
|------|-----------|---------|
| `opencode-linux-x64` | `bin/opencode` | Linux x64 glibc |
| `opencode-linux-x64-baseline` | `bin/opencode` | x64 无 AVX2 glibc |
| `opencode-linux-x64-musl` | `bin/opencode` | Alpine x64 musl |
| `opencode-linux-x64-baseline-musl` | `bin/opencode` | Alpine x64 无 AVX2 |
| `opencode-linux-arm64` | `bin/opencode` | ARM64 glibc |
| `opencode-linux-arm64-musl` | `bin/opencode` | ARM64 musl |

### 6. 关键注意事项

| 事项 | 说明 |
|------|------|
| `$env:OPENCODE_CHANNEL="latest"` | **必须**，否则数据库路径为 `~/.local/share/opencode/opencode-dev.db` 而非 `opencode.db`，导致已有历史记录无法加载 |
| `--skip-install` | 跳过 Step 2 已完成的原生包安装流程 |
| build.ts allTargets | 临时移除 darwin/win32 避免构建中断 |
| 启动命令 | `./opencode web --host --port` |
