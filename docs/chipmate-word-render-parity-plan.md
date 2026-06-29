# ChipMate 通用 Word 能力下一步计划：先补 Codex 核心渲染闭环

日期：2026-06-28

## Summary

- 先不做 Google Docs，也不推进复杂边角项；下一步只补最影响“离线本地 Word 完全可用”的 Codex 核心体验：独立渲染工具、PNG 可视质检证据、模型路由和 documents skill 约束。
- 目标是让 ChipMate 能像 Codex 一样处理常见 Word 请求：生成、编辑、审阅、渲染检查、发现布局风险、必要时再修一轮。
- 详细设计文档 skill 暂后，等通用 Word 渲染和质检闭环稳定后再基于它实现。

## Execution Checklist

进度：已完成 18 项，剩余 0 项。

- [x] 新增一等工具 `render_word_document`，可从工具运行时直接调用。
- [x] `render_word_document` 只读源 `.docx`，把 PDF / page PNG / visual summary 落盘到 `.chipmate/docs/rendered/...`。
- [x] 扩展工具输出和 artifact payload，返回 `pdfArtifactPath`、`pagePngPaths`、`pageVisualSummaries`、`issues` 和 `renderCheckResult`。
- [x] 更新模型工具路由，让“渲染 / 检查 / 视觉 QA / 页面 PNG / 排版风险”类请求可直接使用 `render_word_document`。
- [x] 更新 Word 工具提示约束，要求模型检查 `renderCheckResult`，不能只看工具成功状态。
- [x] 把 Word render artifact 接入聊天消息，展示路径、页数、视觉摘要和 warning。
- [x] 聊天卡片提供 PDF / 首个 PNG 的打开与显示入口。
- [x] 聊天内联页面 PNG 缩略预览。当前会把 `.chipmate/docs` 下的 page PNG 转为 webview URI 并显示前几页缩略图。
- [x] 更新 `documents` skill，把 `render_word_document` 定义为独立 visual QA 工具。
- [x] 保持 Google Docs、Codex helper scripts、宏 / OLE / ActiveX / 任意二进制 OOXML patch 不在本阶段范围内。
- [x] 增加 / 更新 `test/doc-agent.test.ts` 覆盖 render artifact、fail-soft 和 `.chipmate/docs/rendered/...` 路径。
- [x] 增加 / 更新 `test/direct-agent-client.test.ts` 覆盖工具 schema、权限、中文 visual QA 路由和 render artifact 注入。
- [x] 增加 / 更新 `test/chat-html.test.ts` 覆盖 Word render artifact 卡片、路径、页数和 warning。
- [x] 执行 `bun run compile`。
- [x] 执行 `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/chat-html.test.ts test/manifest.test.ts`。
- [x] 执行 `bun run package`。
- [x] 执行 `bun run vsix`。
- [x] VSIX 后执行私有 provider/RAG 字符串扫描，确认源码无泄漏。

## Key Changes

- 新增一等工具 `render_word_document`：
  - 输入：`path`、可选 `artifactNameBase`、可选 `timeoutMs`。
  - 行为：复用现有 `renderWordDocument`，把 `.docx` 渲染为 PDF 和 page PNG，落盘到 `.chipmate/docs/rendered/...`。
  - 输出：`pageCount`、`pagePngPaths`、`pdfArtifactPath`、`pageVisualSummaries`、`issues`、`sofficePath`、`pdfToPngPath`。
  - 只读源 `.docx`，不改原文档。

- 更新模型工具路由：
  - 用户说“渲染/检查/视觉 QA/看看 Word 排版/导出页面 PNG/确认有没有溢出”时，模型可直接调用 `render_word_document`。
  - `create_word_document` / `apply_word_document_edits` / `merge_word_documents` / style/field 工具返回 render artifacts 后，模型必须检查 `renderCheckResult`，不能只看成功状态。
  - 如果 render 有明确风险：空白页、边缘墨迹、表格溢出、PNG 缺失、LibreOffice 失败，模型要说明风险或继续用已有 edit 工具修复。

- 把 PNG 证据接入聊天：
  - 工具结果中 page PNG 路径作为可见 artifact 返回。
  - 聊天内展示页面 PNG 链接/预览和视觉摘要；大文档默认展示前几页和有风险页，其余列 artifact 路径。
  - 不把 PNG 当最终交付物，除非用户要求；最终仍以 `.docx` 为主。

- 更新 documents skill：
  - 明确 `render_word_document` 是独立 QA 工具。
  - 新建、编辑、模板、合并、字段稳定化后，优先检查 render result。
  - 如果渲染不可用，只能说“结构生成完成但视觉 QA 未完成”，不能声称已视觉通过。

- 保持边界不变：
  - 不开放 Codex helper scripts 的直接执行。
  - 不做 Google Docs import。
  - 不放开宏、OLE、ActiveX、外部对象、任意二进制 OOXML patch。
  - 不启动详细设计文档 skill 改造。

## Test Plan

- `test/doc-agent.test.ts`
  - 增加工具级测试：`render_word_document` 可渲染本地 `.docx`，生成 PDF、page PNG、visual summaries。
  - 覆盖 LibreOffice/pdftoppm 不可用时的 fail-soft 输出：结构可报告，但视觉 QA 不应被标记为通过。
  - 覆盖 page PNG artifact 路径在 `.chipmate/docs/rendered/...` 下。

- `test/direct-agent-client.test.ts`
  - 断言“检查/渲染 Word 排版”的中文请求会加载 documents skill，并允许/调用 `render_word_document`。
  - 断言生成 Word 后模型提示里包含必须检查 render result 的路由规则。
  - 断言 `render_word_document` 在权限列表和工具 schema 中可见。

- `test/chat-html.test.ts`
  - 断言 render tool 返回的 page PNG artifact 不会落入普通 fallback 文本卡。
  - 断言聊天里能显示 Word render artifact 路径、页数、主要 warning。

- 验证命令：
  - `bun run compile`
  - `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/chat-html.test.ts test/manifest.test.ts`
  - `bun run package`
  - `bun run vsix`
  - VSIX 后执行私有 provider/RAG 字符串扫描，确认源码无泄漏。

## Assumptions

- 下一步优先目标是“离线本地 Word 可用版本”，不是 Codex documents 全量复制。
- Google Docs、直接执行 Codex Python helper scripts、复杂 OOXML 边角项暂不做。
- `render_word_document` 是补齐 Codex 核心体验的第一优先级；完成后再进入“详细设计文档 skill”。
- Word 动态字段限制保持现状：`TOC/PAGE/NUMPAGES` 不做 headless 强刷新，优先使用 static TOC 或明确提示需要 Word/LibreOffice 更新字段。
