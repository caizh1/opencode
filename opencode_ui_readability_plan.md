# OpenCode Remote UI 可读性计划状态

> 内部计划文档，不应随 VSIX 发布。当前 `.vscodeignore` 已排除本文件。
> 更新时间：2026-05-31

## 当前已完成基线

当前工作树已经把上一版计划里的高优先级可读性任务落到实现中，后续开发不应再把这些内容当作未开始事项：

- 舒适阅读排版：助手回答使用更接近 VS Code 默认字号的正文、较高 `line-height`、更清楚的段落/列表/代码块间距；用户消息保持相对紧凑。
- 安全 Markdown 子集：标题、段落、无序/有序列表、引用、分隔线、粗体、斜体、行内代码、代码块都通过 DOM API 创建节点，不用 `innerHTML` 注入 AI 输出。
- 代码块：保留代码头、语言标签、复制按钮、横向滚动，并增加轻量语法高亮。
- Composer 区域：底部已合并为单行 `composerStatusBar`，`Panel / Ctx / Indexed / Guard / Usage` 通过状态浮层显示细节；输入区可折叠以释放对话空间。
- Markdown 导出：支持按钮、`/export`、`/export last`，并支持模型辅助识别自然语言导出请求；本地保存仍由 VS Code 插件完成。
- 表格渲染最小闭环：支持 Markdown table、CSV、TSV、plain aligned table、key-value block；表格横向滚动，提供 `Copy Markdown`、`Copy CSV`、`Raw` fallback。
- 消息动作栏：支持 `Copy answer`、`Copy Markdown`、`Collapse / Expand`、`Jump to code/table`。
- 长回答保护：当回答包含多个 heading/code/table 或内容很长时，显示 mini outline，并对大内容默认限高，可用 `Full / Limit` 切换。
- 可访问性与主题：新增控件有明确 `aria-label` / `aria-expanded` / `aria-pressed`；`Esc` 可关闭主要浮层；新增高对比模式 CSS 保护。

## 当前验收口径

这些能力的基础验收已经覆盖在现有 smoke tests 中：

- `test/chat-html.test.ts`
- `test/chat-history.test.ts`

交付前仍需按仓库要求运行：

```bash
bun test
bun run compile
bun run package
```

若需要本地 VS Code 安装测试包，且仓库根目录已有 `opencode-remote-*.vsix`，先递增 `package.json` patch 版本，再运行：

```bash
bun run vsix
```

## 后续可继续优化

这些是可以做但不应阻塞当前 UI 可读性目标的增强：

- 表格渲染更强测试：把 table detector、CSV serializer、Markdown table serializer 抽出为纯函数并补 fixture 单元测试。
- 大表格性能：对超大表格增加行数摘要、分页或虚拟滚动，而不是一次性渲染全部 DOM。
- 消息动作增强：后续可为用户消息增加 `Copy question`、`Edit and resend`。
- 菜单键盘体验：进一步完善 model/agent menu 的 roving tabindex 与屏幕阅读器提示。
- 流式渲染性能：继续观察长 streaming 回复时的滚动稳定性与重绘成本。
- 渐进模块化 `src/chat-html.ts`：值得做，但不作为表格渲染、消息动作栏这类用户可感知改进的前置条件。

## 暂不做

- 暂不新增 `opencode.remote.ui.*` settings，继续使用内部默认，等真实反馈稳定后再暴露配置。
- 暂不引入 `markdown-it`、DOMPurify、Prism、Shiki、Highlight.js 或 VS Code Webview UI Toolkit。
- 暂不新增 `Open CSV`、`Insert at cursor`、`Apply patch` 等高权限或跨边界操作。
- 不恢复旧的多行 `guard / usage / codeGraph / chips` 默认 UI；后续只在当前 `composerStatusBar` 和浮层基础上增强。
