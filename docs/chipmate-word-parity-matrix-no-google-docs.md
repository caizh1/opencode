# ChipMate Word Parity Matrix（不含 Google Docs）

日期：2026-06-28

## 结论

本次评估范围只覆盖离线本地 `.docx` / Word 文档生成、编辑、审阅、渲染和 QA，不包含 Google Drive 导入、native Google Docs 输出、Google Docs title sanitizer 以及相关 plugin 安装流。

当前 ChipMate 已经具备一版可用的本地 Word v1：通用 documents skill 负责规划和约束模型，通用 Word 工具负责 deterministic DOCX 生成、locator edit、结构审计、渲染、样式/字段/合并/对比等执行。和 Codex documents skill 的核心工作方式相比，能力面已基本对齐；仍存在少量实现方式差异和边界差距，主要集中在“长文档所有页面逐页图片级模型检查”和“Codex bundled helper scripts 的自由度”。

## 证据来源

- Codex documents skill：`/Users/archer/.codex/plugins/cache/openai-primary-runtime/documents/26.623.12021/skills/documents/SKILL.md`
  - 工具与最终交付纪律：lines 12-19
  - render -> inspect PNGs -> iterate gate：lines 38-52
  - preset/header/table/list/design contract：lines 57-90
  - 编辑与质量设计标准：lines 122-187
  - helper scripts / package layout：lines 260-348
  - visual review success criteria：lines 357-394
- ChipMate documents skill：`.agents/skills/documents/SKILL.md`
  - allowed tools：lines 4-22
  - model/tool ownership：lines 60-65
  - preset/header/form factor/new document flow：lines 67-98
  - existing document edit workflow：lines 106-136
  - compare/merge/style/field workflows：lines 138-166
  - quality rules：lines 172-197
- 当前实现与测试：
  - `src/direct-agent-client.ts`
  - `src/tool-runtime.ts`
  - `src/docAgent/WordDocBuilder.ts`
  - `src/docAgent/WordDocSpecValidator.ts`
  - `src/docAgent/themes/WordDesignPresets.ts`
  - `test/doc-agent.test.ts`
  - `test/direct-agent-client.test.ts`
  - `test/chat-html.test.ts`
  - `test/manifest.test.ts`

## 对齐矩阵

| # | 能力项 | Codex 目标能力（不含 Google Docs） | ChipMate 当前能力 | 对齐状态 | 差异 / 影响 |
|---:|---|---|---|---|---|
| 1 | Skill 触发与通用定位 | documents skill 覆盖 `.docx` 读、建、改、红线、批注、可视 QA。 | `.agents/skills/documents` 覆盖通用 Word 生成、编辑、审阅、验证；明确不是芯片详细设计专用流水线。 | 对齐 | 无核心影响。 |
| 2 | 模型/工具职责边界 | 模型负责设计判断，工具和脚本负责 DOCX/OOXML 执行。 | Skill 明确模型负责文档意图，工具负责 deterministic execution。 | 对齐 | ChipMate 更产品化，少让模型直接写脚本。 |
| 3 | 新建 DOCX | 先规划文档类型、受众、结构、preset，再生成 DOCX。 | `create_word_document` 接收完整 `WordDocSpec`，支持丰富结构与渲染检查。 | 对齐 | 实现不是 Codex Python builder，而是 TS/OOXML builder。 |
| 4 | 设计 preset | Codex 要求 mandatory preset、exact token map、preset audit。 | 支持 base preset、token map、validator、style落地测试。 | 对齐 | Google Docs preset 在本矩阵不计入目标。 |
| 5 | Archetype alias | Codex 支持 RFI、decision memo、launch guide、contract brief、proposal/grant 等 alias。 | `WordPresetAlias` 和 alias token overrides 已落地。 | 对齐 | 无核心影响。 |
| 6 | First-page header pattern | Codex 非 Google Docs 文档可选 header template。 | `WordHeaderPattern` 支持 `memo_masthead`、`proposal_centerpiece`、`editorial_cover`、`customer_pack`、`workshop_agenda`、`customer_story`。 | 对齐 | Word-native 段落/表格渲染，不复用 Codex Python 模板代码。 |
| 7 | Form factor selection | Codex 强调 prose/callout/steps/checklist/table/form/source list 等。 | `WordDocSpec` 支持 prose、callout、briefCards、evidenceCards、quote、definitionList、sourceList、forms、tables、figures。 | 对齐 | 无核心影响。 |
| 8 | 真实 Word 结构 | Codex 禁止 fake headings/lists/tables。 | Builder 写真实 Heading style、numbering、fixed-layout tables、merged cells、caption、bookmark。 | 对齐 | 无核心影响。 |
| 9 | Table geometry | Codex 要求 DXA table geometry、repeated header、overflow audit。 | Builder/validator 支持 fixed layout、width ratios、alignment、merged cells、repeated header、overflow warnings。 | 对齐 | 不复用 `table_geometry.py`，用 native builder。 |
| 10 | Figures/images | Codex 要求图片关系、alt text、caption/bookmark。 | `FigureSpec` 支持 PNG image、alt、caption/bookmark；编辑支持 image inspection/alt/replace。 | 对齐 | 外部链接图像和非 PNG replacement fail closed。 |
| 11 | Captions/cross refs | Codex helper 支持 captions、bookmarks、REF/PAGEREF。 | Word builder 支持 caption、SEQ cached number、bookmark、REF/PAGEREF markers。 | 对齐 | PAGE/NUMPAGES/TOC 原生刷新仍有限制，见 gap。 |
| 12 | Static TOC/internal navigation | Codex 有 `internal_nav.py` / `insert_toc.py`。 | `layout.navigation.mode = "static-toc"` 支持静态 clickable TOC、Top/Bottom、Back-to-TOC。 | 基本对齐 | Word-native dynamic TOC refresh 不作为当前本地 headless 强项。 |
| 13 | Footnotes/endnotes | Codex 有 footnotes/endnotes task/helper。 | Builder/inspector/editor 支持 true footnote/endnote parts 与更新。 | 对齐 | 富文本 note body 仍是 v1 边界。 |
| 14 | Forms/content controls | Codex 有 SDT content controls helper。 | 支持 plain text、checkbox、dropdown、date SDT 生成/检查/填充。 | 基本对齐 | Rich/nested SDT 填充 fail closed。 |
| 15 | Protection/restrict editing | Codex 有 `set_protection.py`。 | 支持 `readOnly`、`comments`、`trackedChanges`、`forms`、`off`。 | 对齐 | 不声称 password protection。 |
| 16 | Existing DOCX inspect | Codex 先读取/审阅再定位编辑。 | `inspect_word_document` 返回 paragraphs/tables/lists/comments/images/captions/sections/fields/styles/locators。 | 对齐 | 无核心影响。 |
| 17 | Locator-based edits | Codex 避免直接乱改 OOXML，必要时 targeted patch。 | `apply_word_document_edits` 要求 returned locators，支持 insert/replace/update/patch。 | 对齐 | ChipMate 更严格，降低模型乱改风险。 |
| 18 | Rich structural insertion | Codex 支持段落、列表、表格、图、callouts 等。 | `insertSection.blocks` 支持 ordered blocks、rich paragraphs、lists、figures、tables、cards、quotes、code。 | 对齐 | 无核心影响。 |
| 19 | Comments | Codex 支持 extract/add/update/resolve/strip comments。 | 支持 addComment、updateCommentText、setCommentResolved、removeAllComments，并处理 commentsExtended/commentsIds。 | 对齐 | Headless render 不可靠展示 comments，结构检查为主，和 Codex说明一致。 |
| 20 | Tracked changes/redlines | Codex 支持 tracked replacement、accept tracked changes。 | 支持 paragraph/text/table tracked changes、accept/reject all；formatting revisions fail closed。 | 基本对齐 | Move/formatting revision 有保守边界。 |
| 21 | Privacy scrub/redaction | Codex 有 privacy scrub/redact helpers。 | 支持 metadata scrub、rsid 清理、exact/email/phone/custom redaction，comments 可选。 | 对齐 | 不做 image OCR。 |
| 22 | Watermarks/background | Codex 有 add/audit/remove watermark helpers。 | 支持 VML text watermark add，多 header parts；支持 VML/DrawingML 背景检查与 remove。 | 对齐 | 媒体关系清理保守。 |
| 23 | Hyperlinks | Codex 有 hyperlinks/fields OOXML helper。 | Inspector/editor 支持 external URL、internal anchor、tooltip、visible text 更新。 | 对齐 | 无核心影响。 |
| 24 | Sections/layout | Codex 有 section audit、mixed layout guidance。 | Inspector/editor 支持 page size、orientation、margins、first/odd-even header/footer linkage、section setup update。 | 对齐 | 无核心影响。 |
| 25 | Style lint/normalize | Codex 有 style_lint/style_normalize。 | `audit_word_document_styles` / `normalize_word_document_styles` 支持 direct formatting drift、heading-like drift、preserveRunFormatting。 | 对齐 | 无核心影响。 |
| 26 | Template/style pack | Codex 有 apply_template_styles。 | `apply_word_template_styles` 支持 styles/theme/fontTable/numbering、styleAllowlist、conflict audit。 | 基本对齐 | 不导入模板正文，只做样式包。 |
| 27 | Fields materialization | Codex 有 fields_report、fields_materialize、flatten_ref_fields。 | 支持 audit fields、flatten REF/PAGEREF、materialize SEQ cached numbers。 | 基本对齐 | 不刷新 Word-native TOC/PAGE/NUMPAGES。 |
| 28 | Compare/diff | Codex 有 render_and_diff。 | `compare_word_documents` 支持 text diff、page PNG render、pixel diff、changedRatio、visual severity。 | 对齐 | 无核心影响。 |
| 29 | Merge/append | Codex 有 merge_docx_append。 | `merge_word_documents` 支持 base-wins style/numbering、hyperlink remap、local PNG media merge、unsupported objects fail closed。 | 对齐 | Object-heavy append 默认拒绝。 |
| 30 | Spreadsheet/table helper | Codex 有 xlsx_to_docx_table、docx_table_to_csv。 | `extract_xlsx_table` 与 `export_word_table_to_csv` 已暴露。 | 基本对齐 | 不重算公式，不完整迁移 Excel styling。 |
| 31 | Render DOCX -> PNG/PDF | Codex 用 `render_docx.py` 生成 page PNG，optional PDF。 | `render_word_document` 生成 PDF/page PNG/pageVisualSummaries，聊天 UI 有 Word render card。 | 对齐 | 使用本地 LibreOffice/Poppler toolchain，不复用 Codex 脚本。 |
| 32 | Render -> inspect -> iterate | Codex 强制 render、看 PNG、修复、重渲染直到无缺陷。 | Direct agent 增加 Word visual QA checkpoint，支持 page PNG 图片上下文、text-only fallback、2 次 bounded steering。 | 基本对齐 | Codex 原生是“直到 flawless”；ChipMate 为防循环默认最多 2 次自动 steering。 |
| 33 | 全页面视觉检查 | Codex 要求最终交付前每页 100% zoom inspect。 | ChipMate 会附 page PNG 作为视觉上下文，但当前会限制同轮图像数量并依赖 provider vision；其余页面依靠 summaries/warnings。 | 部分对齐 | 长文档逐页图片级模型检查仍是主要差距。 |
| 34 | Provider 不支持图像 | Codex App 能直接打开 PNG；若 render 缺失则披露。 | ChipMate provider 拒绝 image input 时 text-only retry，并要求披露不能声称逐页图片通过。 | 对齐 | 无视觉模型时只能 summary-level QA。 |
| 35 | Helper scripts fallback | Codex 可在 JS surface 不完整时用 bundled Python/OOXML helper scripts。 | ChipMate 有 manifest v2、安全执行边界、只读诊断 helper opt-in；多数 Codex helper 映射为 native tools。 | 基本对齐 | 不是所有 Codex scripts 都可直接执行；这是安全边界和产品化选择。 |
| 36 | Final response discipline | Codex 要求只交付最终 DOCX，除非用户要求不暴露中间 PNG/PDF。 | Skill 和 direct-agent prompt 均要求 final 聚焦最终 `.docx` 与必要 warning。 | 对齐 | 无核心影响。 |
| 37 | Verification/test gate | Codex skill 强调 render QA；本地能力需要可验证。 | 本轮通过 `bun run compile`、402 tests、`bun run package`，源码私有 endpoint scan 无匹配。 | 对齐 | 未执行 VSIX 手装实测；本轮目标未要求。 |

## 已实现但与 Codex 原生方式不同的地方

1. ChipMate 用产品化 native Word tools 替代大量 Codex Python helper scripts。
   - 影响：普通用户路径更稳定、权限更可控；代价是新 helper 的临时自由度低于 Codex。

2. ChipMate 的视觉 QA 是 bounded checkpoint，不是无上限自动循环。
   - 影响：避免模型/工具陷入无限 render/edit；代价是复杂长文档可能需要用户继续要求“再做一轮视觉 QA”。

3. ChipMate 对 provider vision 做运行时适配。
   - 影响：支持图像时接近 Codex 的“看 page PNG”；不支持图像时只能用 visual summaries/warnings，并必须披露不能声称图片级通过。

4. ChipMate 的 direct helper fallback 是 manifest v2 opt-in。
   - 影响：不会因为 active skill 存在就执行任意脚本；对 Codex 某些临时 helper workflow 的灵活性弱一些。

5. ChipMate 的 Word field 支持偏 deterministic render。
   - 影响：REF/PAGEREF flatten、SEQ materialize 已有；Word-native TOC/PAGE/NUMPAGES 完整刷新仍不是当前强项。

## 剩余差距（不含 Google Docs）

| 优先级 | 差距 | 影响 | 建议 |
|---|---|---|---|
| P0 | 长文档全页面图片级模型检查未完全等同 Codex。 | 超过当前图片预算的页面主要依赖 summaries/warnings，不能完全等价于“每页 100% zoom 看图”。 | 增加分页批次视觉 QA：每批 N 页，直到所有 page PNG 被模型检查或用户选择停止。 |
| P1 | direct helper fallback 没有把 Codex 全部 scripts 逐个 executable 化。 | Native tools 覆盖主路径；极少数边角 helper 需要新增 native tool 或逐项 opt-in。 | 按真实缺口逐个 opt-in，只选只读/诊断或 fail-closed helper。 |
| P1 | Word-native TOC/PAGE/NUMPAGES 刷新仍有限。 | 需要动态页码/TOC 字段完全刷新时，仍依赖 Word/LibreOffice 或后续专门 workflow。 | 增加 field refresh/report 专项，不把静态 TOC 误称为 Word-native TOC refresh。 |
| P2 | Rich/nested content controls、富文本 note body 等边角仍是 v1+ 边界。 | 普通表单/脚注尾注可用；复杂模板填充需要披露或后续增强。 | 保持 fail closed，按客户模板样本补 fixture 和工具能力。 |

## 当前可视为完成的本地 Word v1

- 通用文档生成：可根据提示词规划文档类型、preset/header、结构块、表格/图/引用/表单/脚注等，并生成 `.docx`。
- 通用文档编辑：可 inspect -> locator edit -> render QA，支持评论、红线、字段、样式、合并、对比、表格和图片等主路径。
- 视觉 QA：可生成 PDF/page PNG/page summaries，聊天 UI 展示预览，agent 自动进入 bounded visual QA checkpoint。
- 安全 fallback：已有 manifest v2 和只读 helper 试点，默认仍优先 native Word tools。
- 验证：`bun run compile`、402 项测试、`bun run package` 均通过；源码私有 provider/RAG 扫描无匹配。
