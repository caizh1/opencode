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

## 构建与发布（Windows 编译 Linux 可执行文件）

### 前置条件

- Bun（已安装）
- Python 3.11+（用于 tree-sitter 原生模块编译）
- 所有依赖已通过项目根目录 `bun install` 安装

### 关键规则（违反会踩坑）

| 规则 | 原因 |
|------|------|
| **`OPENCODE_CHANNEL=latest`** 必须在编译前设置 | 否则数据库路径为 `~/.local/share/opencode/opencode-dev.db`（非 `opencode.db`），已有对话历史全部"丢失" |
| **`minify: false` + `splitting: false`**（已写入 `build-linux.ts`） | `minify: true` 在 Windows→Linux 交叉编译时触发 TDZ `Cannot access 'w' before initialization` |
| **CSP 必须用 `'unsafe-inline'`，不能混用 hash**（已写入 `ui.ts`） | 浏览器规范：同时存在 `'unsafe-inline'` 和 `'sha256-...'` 时忽略前者，内联脚本被拦截，UI 按钮文字不显示 |
| **前端代码改了必须 `bun run build` + 重新生成 embed** | Vite 内容哈希 → 文件名变化 → 旧的 `opencode-web-ui.gen.ts` 引用不存在的文件 |
| **i18n key 必须全部在 `en.ts` 有定义** | 缺失的 key 在 UI 中显示为空文字 |
| **新 endpoint 用 `HttpApiBuilder.group`，不要用 `HttpRouter.use`** | `HttpRouter.use` 在路由树外层注册，可能被 `* /*` catch-all 拦截，且不共享中间件链 |
| **raw route（下载/删除）必须在 `fileHandlers` 内用 `router.add` 注册** | 外层注册无法获取 `InstanceRef`，报 `Service not found: @opencode/InstanceStore` |
| **handler 里不要用 `InstanceState.context`，改用 URL param `directory`** | raw route 不走 `InstanceContextMiddleware`，`InstanceRef` 不可用 |

### 构建流程

```powershell
# ======== Step 1: 构建 Web UI（仅当前端代码有改动时） ========
cd packages/app
bun run build
# 输出: app/dist/ （包含 Vite 编译后的 SolidJS 前端资源）

# ======== Step 2: 重新生成嵌入式 UI 文件列表 ========
cd packages/opencode
bun run script/gen-embed.ts
# 输出: opencode-web-ui.gen.ts（扫描 app/dist/ 生成 500+ 条 import）

# ======== Step 3: 安装 Linux 平台原生依赖（仅首次或更新版本时需要） ========
bun install --os="linux" --cpu="x64" @opentui/core@0.2.14 @parcel/watcher@2.5.1
# 下载 @opentui/core-linux-x64 和 @parcel/watcher-linux-x64-glibc 到 bun 缓存

# ======== Step 4: 编译 Linux 二进制 ========
$env:OPENCODE_CHANNEL="latest"
bun run script/build-linux.ts
# 输出: dist-linux/opencode-linux-x64/bin/opencode（约 145MB）

# ======== Step 5: 打包分发 ========
cd dist-linux
tar -czvf opencode-linux-x64.tar.gz -C opencode-linux-x64 bin/opencode
```

### 哪些情况需要重新构建

| 改动内容 | 需 rebuild app | 需 regen embed | 需 rebuild Linux |
|----------|:---:|:---:|:---:|
| 后端代码（`handlers/*.ts`, `ui.ts`, `error.ts`） | ❌ | ❌ | ✅ |
| 前端代码（`file-tree.tsx`, `en.ts`, `dialog-upload-folder.tsx`） | ✅ | ✅ | ✅ |
| 只有 `en.ts` i18n key 变更 | ✅ | ✅ | ✅ |
| 新增/修改 endpoint schema（`groups/*.ts`） | ❌ | ❌ | ✅ |
| 修改 `build-linux.ts` 配置 | ❌ | ❌ | ✅ |

## 如何新增一个 API 端点

### 方式一：HttpApiBuilder.group（推荐，用于 JSON 请求/响应端点）

需要改 2 个文件：

**1. 定义 endpoint schema 和路径：`groups/<name>.ts`**

```ts
// packages/opencode/src/server/routes/instance/httpapi/groups/file.ts
export const MyResponse = Schema.Struct({
  ok: Schema.Boolean,
  path: Schema.String,
})

// 在 FilePaths 中添加路径：
export const FilePaths = {
  // ...
  myEndpoint: "/my/api/path",
} as const

// 在 HttpApiGroup.make("file").add() 链中添加：
HttpApiEndpoint.get("myEndpoint", FilePaths.myEndpoint, {
  query: WorkspaceRoutingQuery,   // 如果 group 有 WorkspaceRoutingMiddleware
  success: described(MyResponse, "Description"),
})
```

第一个参数 `"myEndpoint"` 必须与 `.handle("myEndpoint", ...)` 中的名称一致。

**2. 实现 handler：`handlers/<name>.ts`**

```ts
// packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts
const myEndpoint = Effect.fn("FileHttpApi.myEndpoint")(function* () {
  return { ok: true, path: "hello" } as typeof MyResponse.Type
})

return handlers
  .handle("findText", findText)
  // ...
  .handle("myEndpoint", myEndpoint)
```

### 方式二：Raw Route（用于返回原始二进制/自定义 header 的端点）

注册在 `HttpApiBuilder.group(...)` 内部，与 typed endpoints 共享同一套中间件链。

```ts
// packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts
export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const router = yield* HttpRouter.HttpRouter

    // 注册 raw route —— 和 typed endpoints 共享中间件
    yield* router.add("GET", "/file/download", handleDownload(fs))
    yield* router.add("DELETE", "/file/delete", someHandler(fs, bus))

    // ... 后续 handler 定义
    return handlers
      .handle("findText", findText)
      // ...
  }),
)
```

**raw route handler 的关键注意事项：**

1. 不能使用 `InstanceState.context`（raw route 不走 `InstanceContextMiddleware`，拿不到 `InstanceRef`）
2. 改为直接从 URL 参数读取 `directory`：
   ```ts
   const targetDir = url.searchParams.get("directory")
     ?? request.headers["x-opencode-directory"]
     ?? process.cwd()
   ```
3. 如果前端通过 `window.open(url, "_blank")` 触发（如下载），URL 必须包含 `directory=` 参数：
   ```tsx
   const url = `${sdk.url}/file/download?directory=${encodeURIComponent(sdk.directory)}&path=${encodeURIComponent(node.path)}`
   ```

### 前端右键菜单添加方法

```tsx
// packages/app/src/components/file-tree.tsx — 在 ContextMenu.Content 中添加：
<ContextMenu.Item onSelect={async () => {
  if (!window.confirm(`Delete "${node.name}"?`)) return
  const res = await fetch(`${sdk.url}/file/delete?path=${encodeURIComponent(node.path)}&directory=${encodeURIComponent(sdk.directory)}`, { method: "DELETE" })
  if (res.ok) file.tree.refresh(props.path)      // props.path = 当前目录
}}>
  <ContextMenu.ItemLabel>{language.t("session.files.delete")}</ContextMenu.ItemLabel>
</ContextMenu.Item>
```

### 选择方式的决策依据

| 特征 | HttpApiBuilder.group | Raw Route |
|------|:---:|:---:|
| 自动 OpenAPI 文档 | ✅ | ❌ |
| 中间件（Auth、Workspace、Instance） | ✅ | 不自动，需手动处理 |
| 返回原始二进制 (`Content-Disposition`) | ❌（JSON only） | ✅ |
| 需要修改 `server.ts` | ❌ | ❌（在 handler 内部注册） |
