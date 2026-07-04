# 03 Source Exploration Rules

## 1. 探索边界

源码探索必须以 `module-scope.md` 为边界。禁止一开始无约束全仓 grep。边界外扩展必须记录扩展原因、关键词、目录、新发现是否纳入主模块。

## 2. 工具优先级

使用顺序：代码图/cgc → LSP/clangd → ast-grep/tree-sitter → rg/grep/glob/find → 读取源码原文确认。任何工具结果在写入正文或图前，都必须回到源码原文或精确位置证据确认。

## 3. 必须探索对象

必须探索：主目录、对外头文件、初始化入口、对外接口、核心控制结构体、全局变量和上下文、状态枚举和状态字段、错误码和异常分支、主调用链、上游调用者、下游依赖、构建脚本、模块注册、关键函数内部控制流、参数校验、数据读写、错误恢复、资源清理、子模块协作时序和数据传递。

## 4. 源码证据 ID

源码证据 ID 使用 `SRC-0001` 递增。`source-evidence-index.md` 模板：

```md
| 证据ID | 类型 | 路径 | 符号/行号 | 证据摘要 | 支撑结论 |
|---|---|---|---|---|---|
```

## 5. 关键函数深度分析

关键函数包括：对外 API、初始化/启动/停止/清理、状态迁移函数、错误处理入口、资源分配/释放、用户要求深度分析的函数。必须记录：函数签名、参数校验、局部变量、控制流分支、数据操作、下游调用、错误分支、状态变更、函数规模。

## 6. 子模块识别

子模块不是简单目录名。满足以下至少两项才可认定：共同处理同一业务能力、共享核心结构体或状态字段、位于同一调用链阶段、与同一状态机或事件相关、共同处理同一错误/资源/队列/缓存对象。

## 7. 输出文件

必须生成：`source-file-index.md`、`source-evidence-index.md`、`call-chain-evidence.md`、`data-structure-evidence.md`、`state-and-error-evidence.md`、`key-functions-and-submodules.md`、`function-deep-analysis.md`、`submodule-flow-analysis.md`。
