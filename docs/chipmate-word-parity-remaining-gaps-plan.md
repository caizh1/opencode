# ChipMate Word Parity 剩余三项实施计划

日期：2026-06-28

## 目标

在当前已完成的本地 Word v1 基础上，继续补齐与 Codex documents 能力的关键差距。当前计划只覆盖离线本地 `.docx` 生成、编辑、渲染和 QA，不包含 Google Docs、Google Drive、在线协作或芯片详细设计文档专用流水线。

后续目标模式按本文逐项执行和打勾。执行顺序固定为：

1. 长文档全页面图片级视觉 QA。
2. Word-native `TOC` / `PAGE` / `NUMPAGES` 字段刷新。
3. 按真实缺口补 direct helper opt-in。

## 执行进度

- [x] 长文档全页面图片级视觉 QA。
- [x] Word-native `TOC` / `PAGE` / `NUMPAGES` 字段刷新。
- [x] 按真实缺口补 direct helper opt-in。

已完成：3/3；剩余：0/3。

## 全局原则

- 保持通用 Word 能力边界：模型负责文档意图、结构和修订判断；工具负责确定性 `.docx` 操作、渲染和证据产出。
- 不把详细设计文档需求写成通用 Word pipeline 的特例。
- 不把私有 provider、私有 endpoint 或本地打包默认值写入源码、文档或测试。
- 所有新增能力必须本地离线可运行；没有本地依赖时必须 fail closed 或明确披露降级。
- 完成每一项后必须更新本文 checklist，并补充已执行的验证命令和结果。

## 1. 长文档全页面图片级视觉 QA

### 当前状态

ChipMate 已支持 Word 渲染为 PDF/page PNG/page summaries，聊天 UI 可展示预览，agent 会进入 bounded visual QA checkpoint。当前差距是：长文档超过图片预算后，并非每一页都被模型以图片级证据检查，部分页面仍依赖 summaries/warnings。

### 实施内容

- [x] 在 direct agent 的 Word render artifact 后处理里增加分页批次视觉 QA 调度。
- [x] 对所有 page PNG 建立 coverage ledger，记录每页状态：`pending`、`attached`、`inspected`、`summary-only`、`skipped`、`failed`。
- [x] 每轮 QA 将 page PNG 按固定批次送入模型，默认每批 3 页；批次大小用常量或配置集中控制。
- [x] 保留当前最多 2 轮 repair 的上限；分页批次只扩展检查覆盖面，不突破 repair loop 上限。
- [x] provider 支持图片输入时，最终 verdict 必须包含所有页面的图片级检查覆盖率。
- [x] provider 不支持图片输入或拒绝图片时，必须标记为 summary-only，最终回答不得声称完成图片级逐页检查。
- [x] run summary / evidence ledger / final response 中展示覆盖率，例如 `Visual QA: 12/12 pages inspected` 或 `Visual QA: summary-only`。
- [x] 聊天 UI 的 Word render card 增加视觉 QA 覆盖状态展示。

### 验收标准

- [x] 6 页文档在每批 3 页时，模型会收到第 1-3 页和第 4-6 页两批图片证据。
- [x] 所有页面都有明确 coverage 状态，不存在未披露的漏检页面。
- [x] provider 拒绝图片输入时，最终结果明确为 summary-only。
- [x] repair loop 仍最多 2 轮，不因分页批次导致无限修复。

### 测试

- [x] 更新 `test/direct-agent-client.test.ts`：覆盖多页分页视觉 QA、provider 拒绝图片、repair 上限。
- [x] 更新 `test/chat-html.test.ts`：覆盖 Word render card 的视觉 QA 覆盖率展示。
- [x] 必要时更新 `test/doc-agent.test.ts`：确保 render artifact/page summaries 与 coverage ledger 兼容。

## 2. Word-native TOC / PAGE / NUMPAGES 字段刷新

### 当前状态

ChipMate 已支持静态 TOC、bookmark、REF/PAGEREF flatten、SEQ cached number、caption/cross-ref 等 deterministic 能力。当前差距是：真正依赖 Word 原生字段刷新能力的动态 `TOC`、`PAGE`、`NUMPAGES` 仍未完全对齐。

### 实施内容

- [x] 明确 Word field 策略：静态可物化字段继续 deterministic 处理；Word-native 动态字段进入专门 refresh/report workflow。
- [x] 增加 field refresh/report 能力，识别并报告 `TOC`、`PAGE`、`NUMPAGES`、无法刷新的字段和刷新后的字段状态。
- [x] 优先使用本地 LibreOffice/Word 可用能力刷新字段；依赖不可用时 fail closed 并给出明确原因。
- [x] 更新 Word builder/spec，使用户明确请求动态目录或页码时可表达 Word-native field intent，而不是误生成静态替代物。
- [x] 渲染 QA 后检查目录页码、页脚页码、总页数是否与实际页数一致。
- [x] final response 区分“已刷新 Word-native 字段”和“已生成静态 TOC/静态页码”。

实现说明：当前 v1 主产物优先保留 live `TOC` / `PAGE` / `NUMPAGES` 字段并启用 `updateFields`。如果本地 LibreOffice 保存出的 `.docx` 会把 live fields 静态化，则不采用该静态化 `.docx` 作为主产物，而是输出保留 live fields 的 render-verified copy，并在 warning / evidence 中披露 `refreshMode`。

### 验收标准

- [x] 生成包含动态 TOC 的文档后，刷新并渲染，TOC 页码与实际章节页码一致。
- [x] 文档页脚 `PAGE` / `NUMPAGES` 渲染后显示正确当前页和总页数。
- [x] 本地刷新依赖不可用时，不生成冒充刷新成功的文档。
- [x] 静态 TOC 与 Word-native TOC 在输出说明和 evidence 中可区分。

### 测试

- [x] 更新 `test/doc-agent.test.ts` 或新增 field refresh 测试：检查 `.docx` field XML、refresh report、渲染证据。
- [x] 增加依赖缺失/fail closed 测试。
- [x] 增加静态 TOC 不被误标为 Word-native refreshed TOC 的回归测试。

## 3. 按真实缺口补 direct helper opt-in

### 当前状态

ChipMate 已有 manifest v2 direct helper fallback 安全边界，并已有只读诊断 helper 试点。当前策略不是一次性搬运 Codex 全部 helper scripts，而是在 native Word tools 覆盖不了真实缺口时逐项 opt-in。

### 实施内容

- [x] 基于当前工具矩阵列出 native Word tools 覆盖不了的真实缺口，不为“看起来 Codex 有脚本”而新增 helper。
- [x] 每个新增 helper 必须满足 manifest v2 opt-in：active skill、allowed tool、helper-level `directExecution: true`、本地脚本路径、离线网络策略、超时、输出大小限制。
- [x] 优先补只读/诊断类 helper；会写文档的 helper 必须有明确输入 schema、输出 artifact、失败回滚和测试覆盖。
- [x] helper 输入 schema 必须限制 workspace 路径、允许扩展名、必填字段、枚举和最大长度。
- [x] helper 输出必须进入 `.chipmate/docs/skill-script-artifacts` 或等价受控 artifact 目录，并写入 evidence refs。
- [x] final response 必须披露 helper fallback 被使用、产物路径和任何限制。

### 验收标准

- [x] 只有 manifest 明确 opt-in 的 helper 可以执行。
- [x] 未授权 helper、越界路径、非离线网络策略、超时或 schema 不匹配都 fail closed。
- [x] 新增 helper 不破坏现有 native Word tools 主路径。
- [x] 至少覆盖一个真实 native gap，且测试能证明该 gap 通过 helper 得到补齐。

### 测试

- [x] 更新 `test/direct-agent-client.test.ts`：覆盖 helper allow/deny、schema 校验、artifact/evidence。
- [x] 更新 `test/manifest.test.ts`：覆盖 manifest v2 helper opt-in 约束。
- [x] 必要时增加 helper script 自身 fixture 测试。

## 统一验证

每完成一项后至少执行：

```bash
bun run compile
bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/chat-html.test.ts test/manifest.test.ts test/skills-permissions.test.ts
bun run package
```

需要交付新的本地 VSIX 时执行：

```bash
bun run vsix
```

VSIX 后必须执行私有 provider/RAG 字符串扫描，确认源码无泄漏。具体私有 endpoint、host、model 名称只允许来自本地 ignored defaults 文件或打包脚本运行时上下文，不写入 tracked 文档。

## 本次执行记录

日期：2026-06-28

- 已完成：3/3；剩余：0/3。
- `bun run compile`：通过。
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/chat-html.test.ts test/manifest.test.ts test/skills-permissions.test.ts`：通过，`406 pass / 0 fail`。
- `bun run package`：通过。
- 本次未执行 `bun run vsix`，未生成新的本地 VSIX；因此未执行 VSIX 后私有 provider/RAG 字符串扫描。

## 完成定义

- [x] 三项 checklist 全部完成。
- [x] 最新对齐矩阵更新，说明三项是否已完全对齐 Codex 离线本地 Word 能力。
- [x] 所有相关测试、`bun run package` 通过。
- [x] 如生成 VSIX，报告新 `.vsix` 文件名，并确认源码私有 provider/RAG 扫描无匹配。
- [x] 若仍存在不对齐项，必须写清影响、限制和后续优先级。
