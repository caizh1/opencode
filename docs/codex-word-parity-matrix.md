# Codex Word/Documents Parity Development Plan

目标：将 ChipMate 的通用 Word/documents 能力对齐 Codex 原生 `documents` skill。本文档是后续 goal 模式的一项一项打勾清单；goal 文本只引用本文档，不复制整张矩阵。

## Goal Charter

后续目标模式建议使用如下目标：

> 先交付 ChipMate 离线本地 Word/Documents v1 可用闭环：模型按用户提示生成/编辑内容和布局，通用 Word 工具负责 `.docx` 结构、OOXML、渲染检查和 artifact 交付。v1 只要求完成本文档 `Usable v1 Milestone`，高级边角项不阻塞首版；v1 稳定后再按矩阵逐项补齐 Codex documents parity。Google Drive / native Google Docs 不属于当前目标；芯片模块详细设计文档只作为上层专项 skill 复用通用 Word 能力，不纳入通用 Word parity 本体。

执行原则：

- 通用 Word 能力优先；不要把 C guideline/reference-pack 或芯片详细设计文档专用逻辑算入通用 parity。
- Codex 基准不是单一 Word API，而是 `documents` skill 的 `SKILL.md + tasks/ + ooxml/ + scripts/ + render_docx.py` 工作流。
- 当前 parity 目标是离线环境中的本地 `.docx` 创建、编辑、渲染和验收；Google Drive import 和 native Google Docs 协作链路只作为 Codex evidence 记录，不实现。
- 先做可用闭环，再做矩阵满分。高级 OOXML、复杂嵌入对象、深度模板合并、复杂视觉诊断等边角能力进入 v1+ / v2，不阻塞 v1 VSIX。
- ChipMate 可以保留产品化工具 schema 和 locator 安全边界；但若因此窄于 Codex，需要在矩阵中标为 `Productized but narrower`。
- 每完成一项，必须更新本文档状态和验收证据。

## Usable v1 Milestone

v1 的目标不是“所有 Codex documents 边角项 100%”，而是先让用户在离线环境里能放心使用 ChipMate 生成和修改本地 Word 文档。

当前执行口径：

- `chipmate-0.1.0-build.238.vsix` 作为当前可用候选继续做真实用户验收；矩阵 50/50 已完成，后续只保留真实用户验收发现的问题修复。
- 下一步优先做端到端使用验收、发现真实阻塞问题、修正影响常见 Word 生成/编辑体验的问题。
- 若某个 v2 边角项在真实验收中暴露为首版阻塞，再把它提升到 v1 hotfix；否则保留在 v2 backlog 逐项补齐。

优先级锁定：

- 先交付一版完全能用的离线本地 Word 版本；边角 parity 项不进入首版阻塞条件。
- 首版只对用户常见工作流负责：新建 Word、读取检查 Word、定位编辑 Word、插入常见表格/图片/列表/目录/批注/修订、渲染或明确说明无法渲染。
- 不为了追 Codex 的脚本全集、复杂 OOXML 角落、Google Docs、外部云协作、深度模板合并而延迟 v1。
- v1 之后再按用户真实使用反馈，把矩阵里的 v1+ / v2 项逐项补齐；补齐时仍以 Codex evidence 为准。

v1 必须具备：

- 用户用自然语言要求生成报告、方案、评审文档、设计文档草稿等常见 `.docx` 时，模型负责内容组织、章节、表格、列表、图文位置和版式选择，工具负责生成真实 Word 结构。
- 支持读取和检查现有 `.docx`，再通过 locator 做受控编辑，而不是让模型盲改 zip 包或整文件覆盖。
- 支持常见 Word 元素：Heading、段落、rich paragraph、真实列表、固定布局表格、合并单元格、PNG 图片、caption、基础 cross-reference、静态目录/导航、脚注/尾注、批注、基础修订、样式审计、模板样式套用、元数据清理。
- 每次生成/编辑后尽量走本地 render quality gate，输出可复核的 PDF/page PNG 或明确说明本机缺少渲染依赖；不能把未验证的文档包装成“已视觉通过”。
- 聊天最终交付以 `.docx` 和必要 artifact 为主，不向用户倾倒大段 OOXML、中间 JSON 或内部调试内容。
- 详细设计文档 skill 只能复用通用 Word 能力，不能 fork 出第二套专用 Word 生成流水线。

v1 不阻塞项：

- Advanced visual bbox diagnostics、antialias/reflow 级 diff 解释。
- XLSX 和 DOCX 表格互转 helper。
- floating images、external image rel、DrawingML 背景、复杂水印。
- full formatting tracked-change semantics 和复杂结构性表格修订。
- comment thread rich metadata、full rich/nested content control editing、rich multi-paragraph notes。
- deep template merge、deep multi-doc merge、freeform OOXML patcher。
- Google Drive / native Google Docs。

v1 Done criteria：

- 至少覆盖“新建文档”“编辑现有文档”“带图片/表格/列表/目录的报告”“批注/修订/样式检查”四类 smoke fixtures。
- 相关 tests 通过，至少包括 `test/doc-agent.test.ts`、direct/chat/manifest 里受影响的 focused tests。
- `bun run compile`、`bun run package` 通过；需要 VS Code 体验验证时产出新的 `bun run vsix` 包。
- README、`.agents/skills/documents/SKILL.md` 和本文档同步说明 v1 能力、限制和后续 v1+/v2 backlog。

## Evidence Sources

| Code | Source | Meaning |
| --- | --- | --- |
| `C-Skill` | [OpenAI Codex Agent Skills](https://developers.openai.com/codex/skills) | Codex skills 机制：`SKILL.md`、可选 `scripts/`、`references/`、`assets/`、显式/隐式触发和 progressive disclosure。 |
| `C-DocSkill` | `/Users/archer/.codex/plugins/cache/openai-primary-runtime/documents/26.623.12021/skills/documents/SKILL.md` | 本机 Codex documents skill 的工作流基准。 |
| `C-Manifest` | `/Users/archer/.codex/plugins/cache/openai-primary-runtime/documents/26.623.12021/skills/documents/manifest.txt` | 本机 Codex documents plugin 的 task/script/reference 清单。 |
| `C-Scripts` | `/Users/archer/.codex/plugins/cache/openai-primary-runtime/documents/26.623.12021/skills/documents/scripts/*.py` | Codex documents 可执行 helper 脚本基准。 |
| `CM-Skill` | `.agents/skills/documents/SKILL.md` + `.agents/skills/documents/tasks/*.md` | ChipMate 当前通用 documents skill 和 v1 任务资源。 |
| `CM-Tools` | `src/tool-runtime.ts` + `src/docAgent/*` | ChipMate 当前工具/API/OOXML 实现。 |
| `CM-Tests` | `test/doc-agent.test.ts` 等 | ChipMate 当前行为验收覆盖。 |

Status 说明：

- `Matched`：能力和 Codex documents 工作流等价，且有测试/文档/验证。
- `Mostly matched`：主体能力已对齐，只剩较小边界或高级形态。
- `Partial`：有实现，但明显窄于 Codex documents skill/script 工作流。
- `Missing`：Codex 有明确任务/脚本/流程，ChipMate 没有等价能力。
- `Productized but narrower`：ChipMate 固定工具更安全，但表达力窄于 Codex 脚本式 workflow。
- `Custom divergence`：ChipMate 自造逻辑，不是 Codex 通用 documents parity 本体。
- `Out of scope`：明确不纳入通用 Word parity。

## Executable Matrix

| Done | ID | Capability | Codex evidence | Codex baseline | ChipMate current | Status | Acceptance to check off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [x] | W01 | Skill package shape | `C-Skill`, `C-DocSkill`, `C-Manifest` | Skill 是 `SKILL.md + scripts/references/assets/tasks`，按需加载完整说明并可调用 helper。 | `documents` skill 已有 `SKILL.md`、v1 `tasks/*.md` 和 `metadata.keywords`；ChipMate skill resource 已支持只读 `tasks/`；普通中文 Word/文档生成请求可隐式激活 `documents` skill 并把正文送入模型 system prompt。任意脚本执行仍放到 V2。 | Mostly matched for v1 | v1 已满足：`.agents/skills/documents/tasks/create_edit_v1.md`、`render_verify_v1.md`、`v1_limits_backlog.md` 可发现/读取；`test/skills-permissions.test.ts` 覆盖 `tasks/` resource 和中文 Word metadata activation；`test/direct-agent-client.test.ts` 覆盖中文 Word 请求隐式加载 `documents` skill。 |
| [x] | W02 | Render -> inspect PNG -> iterate loop | `C-DocSkill`, `render_docx.py`, `tasks/verify_render.md` | 生成/编辑 DOCX 后必须渲染 PNG，打开/检查页面图，发现问题后迭代。 | 有 render-quality status、page PNG、视觉摘要；`documents` skill v1 任务明确 render-unavailable 不能声称视觉通过。 | Mostly matched for v1 | v1 已满足：`render_word_document persists page PNG visual QA artifacts` 等 doc-agent tests 通过；后续 W03 再补对象级视觉诊断。 |
| [x] | W03 | Visual QA object diagnostics | `tasks/verify_render.md`, `scripts/render_and_diff.py` | 目视检查 clipping、overlap、tables、headers/footers；diff 可辅助变更页。 | `pageVisualSummaries` 现在包含整页 ink ratio/content bounds/edge ink、3x3 `visualRegions` 区域密度，以及 tile 化 `inkComponents` bbox、pageArea、edgeTouching 和 riskFlags；compare/diff 结果可通过 before/after render summaries 指向疑似问题页和区域。更深语义对象识别/抗重排 diff 解释留到 W36。 | Mostly matched for v1+ | 已满足 v1+：render/compare tests 覆盖 page PNG artifact、region density、ink component bbox、near-page-edge risk flag；documents skill 已指导模型使用区域密度/near-edge components 解释视觉 QA findings。 |
| [x] | W04 | New DOCX creation workflow | `C-DocSkill`, `tasks/create_edit.md` | 模型选择文档类型、preset、form factors，再用 python-docx/OOXML helper 构建。 | `create_word_document` 使用真实 `WordDocSpec` 构建并落盘 `.chipmate/docs/*.docx`；v1 task doc 明确模型负责内容/布局选择、工具负责 Word 结构；中文普通 Word 生成请求的 direct-agent-client 工具循环已覆盖从 `documents` skill 隐式激活到 `create_word_document` 执行和最终交付文本。 | Mostly matched for v1 | v1 已满足：create flow、generic form factors、tables/lists/figures/static TOC/content controls 等 tests 通过；`test/direct-agent-client.test.ts` 覆盖普通中文 Word 请求执行 `create_word_document`，以及真实 `ToolRuntime` 写出 DOCX artifact；未建模 OOXML 扩展留到 V2。 |
| [x] | W05 | Design presets and header templates | `references/design_presets.md`, `references/header_templates.md` | preset 必须解析为具体 numeric tokens；必要时选 header pattern。 | 有 `layout.preset`、`WordDesignPresets`、theme/preset 和 v1 skill guidance；header template 深度仍可后续增强。 | Mostly matched for v1 | v1 已满足：`uses design presets, real Word numbering, and explicit table geometry for generic documents` 等 tests 通过；高级 header pattern catalog 留到 v1+。 |
| [x] | W06 | Fixed table geometry | `scripts/table_geometry.py`, `C-DocSkill Table Gate` | 表格必须有显式 `tblW/tblGrid/tcW`，避免 autofit 和假表格。 | fixed DXA table geometry、overflow warnings。 | Mostly matched | 已有 tests 覆盖 fixed geometry、overflow warning、prose-heavy warning。 |
| [x] | W07 | Merged table cells | `tasks/create_edit.md`, table OOXML helpers | 需要真实 Word merge，而不是空列/重复文本。 | `TableSpec.rows` 支持 `colSpan/rowSpan`，输出 `gridSpan/vMerge`。 | Mostly matched | 已有 tests 覆盖生成和 replaceTable merged cells。 |
| [x] | W08 | Cross-page table strategy | `C-DocSkill Table Gate`, `tasks/verify_render.md` | 表格跨页时重复 header，避免大空白和截断，需 render review。 | Builder 默认写 repeated header，固定布局/grid/cell widths，不写固定行高；v1 task doc 明确长表拆分/重复表头策略。 | Mostly matched for v1 | v1 已满足：long-table fixture 覆盖 repeated headers、fixed layout、auto-expanding rows、无 header a11y warning；对象级 bbox 视觉诊断留到 W03/v1+。 |
| [x] | W09 | XLSX <-> DOCX table helpers | `scripts/xlsx_to_docx_table.py`, `scripts/docx_table_to_csv.py`, `tasks/tables_spreadsheets.md` | 支持简单 XLSX 导入 DOCX table、DOCX table 导出 CSV。 | 新增 `extract_xlsx_table` / `export_word_table_to_csv` 通用工具：XLSX/XLSM 简单矩形范围可提取为 `TableSpec` 并交给 `create_word_document` / `apply_word_document_edits`，现有 Word 表格可按 inspected `tableIndex` 导出 `.chipmate/docs/tables/*.csv`。不重算公式、不迁移 spreadsheet 样式或合并单元格语义。 | Mostly matched for v1 | v1 已满足：direct-agent-client tests 覆盖 `extract_xlsx_table` -> `TableSpec` -> `create_word_document`，以及 `export_word_table_to_csv` 写出 CSV artifact；高级 spreadsheet 样式/合并/公式重算属于非目标边界。 |
| [x] | W10 | Real Word lists/numbering | `tasks/headings_numbering.md` | 使用真实 numbering definitions，禁止 fake bullets/manual numbers。 | 支持多级 bullet/numbered/checklist，inspect/updateList。 | Mostly matched | 已有生成、inspect、updateList tests。 |
| [x] | W11 | Heading hierarchy and numbered headings | `tasks/headings_numbering.md`, `scripts/heading_audit.py` | 使用 Heading styles；audit fake headings and skipped levels。 | 有 heading level warning、inspector paragraph metadata 和 `updateHeadingLevel`。 | Mostly matched for v1 | v1 已满足：skipped heading warnings 和 `apply_word_document_edits can fix skipped heading levels from an inspect locator` tests 通过；更细 fake-heading audit report 留到 v1+。 |
| [x] | W12 | Figures/images inline PNG | `tasks/images_figures.md`, `scripts/images_audit.py` | 插入图片并检查 alt、placement、render。 | 支持 PNG figures、alt、replaceImage。 | Mostly matched | 已有 PNG media、alt、replaceImage tests。 |
| [x] | W13 | Advanced image/drawing handling | `tasks/images_figures.md`, `scripts/images_audit.py` | 需要审计 floating/inline、external/media、尺寸和 placement。 | `inspect_word_document.images` 现在报告 inline/floating placement、embedded/external/missing relationship mode、target/targetMode、media path、extension、content type、media existence、尺寸、name/alt，以及 `replaceSupported` / `replaceUnsupportedReason`。`replaceImage` 明确只支持 inspected local PNG media；external linked images、missing relationships、unresolved targets、non-PNG media 会被报告而不是强行替换。 | Mostly matched for v1+ | 已满足常用审计与安全边界：tests 覆盖普通 inline embedded PNG、floating external image、embedded JPEG non-PNG media；更广泛非 PNG 二进制替换留到 v2。 |
| [x] | W14 | Caption/bookmark basics | `scripts/captions_and_crossrefs.py`, `tasks/captions_crossrefs.md` | Figure/Table captions 用 `SEQ`，可带 bookmark。 | 支持 Figure/Table Caption、bookmark、cached `SEQ`。 | Mostly matched | 已有 caption/bookmark/cross-ref tests。 |
| [x] | W15 | Cross-reference refresh/materialization | `scripts/insert_ref_fields.py`, `fields_materialize.py` | REF/PAGEREF/SEQ 可插入并 materialize 以稳定 headless render。 | 支持结构化 REF/PAGEREF rich paragraph runs、`{{ref:bookmark&#124;visible text}}` / `{{pageref:bookmark&#124;page text}}` marker authoring 到 live Word 字段转换、field audit、REF/PAGEREF flatten、SEQ cached-number materialization；PAGE/NUMPAGES/TOC 仍诚实标注需 Word/LibreOffice 更新。 | Mostly matched for v1+ | 已满足 v1+：create 和 apply/edit 两条路径均覆盖 cross-reference marker 不残留、生成 complex REF/PAGEREF 字段、audit 能识别字段、flatten 能生成确定性渲染副本；SEQ materialize tests 保持通过，skill/README/tool schema 已说明 authoring marker 和 headless refresh 边界。 |
| [x] | W16 | Word-native TOC workflow | `scripts/insert_toc.py`, `tasks/toc_workflow.md` | 可插入 Word-native TOC；字段刷新需要 Word/GUI/明确 fallback。 | v1 支持 headless-safe static TOC/internal navigation；明确不假装刷新 Word-native TOC。 | Mostly matched for v1 | v1 已满足：`writes headless-safe static TOC with internal navigation anchors` tests 通过；native live TOC insertion/refresh 留到 v1+ 或明确 unsupported。 |
| [x] | W17 | PAGE/NUMPAGES field behavior | `tasks/fields_update.md`, `scripts/fields_report.py` | 扫描字段，必要时提示 GUI/Word 更新；不能假装 headless 刷新。 | 支持 audit fields、REF flatten、SEQ materialize；v1 task doc 明确 PAGE/NUMPAGES/TOC 不能 headless 刷新。 | Mostly matched for v1 | v1 已满足：field audit、REF flatten、SEQ materialize tests 通过；PAGE/NUMPAGES/TOC 仍只做诚实提示。 |
| [x] | W18 | Comments lifecycle | `scripts/comments_add.py`, `comments_extract.py`, `comments_apply_patch.py`, `comments_strip.py` | true comments add/extract/update/resolve/strip，结构验证。 | add/update multi-paragraph、resolve、removeAll、inspect。 | Mostly matched | 已有 lifecycle tests。 |
| [x] | W19 | Comment threads/rich metadata | `tasks/comments_manage.md`, `ooxml/comments.md` | 能处理 commentsExtended、新旧 comments parts、结构检查。 | `inspect_word_document.comments` 现在报告 `commentsExtended.xml` / `commentsIds.xml` metadata：`paraId`、`parentParaId`、`parentCommentId`、`durableId`、`commentsExtendedDone`、`resolvedSource`；resolved inspection 同时兼容 legacy `comments.xml` 和 `commentsExtended.xml`。`setCommentResolved` 同步更新 legacy comments 和 existing commentsExtended state；`removeAllComments` 清理 comments/commentsExtended/commentsIds parts、relationships、content types 和正文 anchors。 | Mostly matched for v1+ | 已满足常用 thread metadata 审计和 clean-copy 边界：tests 覆盖 commentsExtended thread parent、commentsIds durable id、extended resolved source、resolved 同步、strip 不留 orphan parts。 |
| [x] | W20 | Tracked changes basics | `ooxml/tracked_changes.md`, `scripts/accept_tracked_changes.py` | 真实 `w:ins/w:del`，可 accept/reject clean copy。 | paragraph/rich/text/table-cell redline，accept/reject all。 | Mostly matched | 已有 tracked change tests 覆盖主要路径。 |
| [x] | W21 | Advanced redlines | `scripts/add_tracked_replacements.py`, `ooxml/tracked_changes.md` | 需要处理 run granularity、move/format 等 Word revision 构造。 | `inspect_word_document.summary` 现在报告 `trackedChangeTypeCounts` 和 `advancedTrackedChangeWarnings`；`replaceTextWithTrackedChange` 覆盖跨 run visible-text replacement；`acceptAllTrackedChanges` / `rejectAllTrackedChanges` 支持 `moveFrom` / `moveTo` clean copy 语义；formatting revisions（`rPrChange`、`pPrChange`、`tblPrChange`、`trPrChange`、`tcPrChange`）会被报告并 fail closed，不假装清理。复杂结构性表格修订仍不作为自动编辑路径。 | Mostly matched for v1+ boundary | 已满足 W21 验收：tests 覆盖跨 run redline replacement、move revisions accept/reject、formatting revision inspection/warning/fail-closed；模型 prompt 可见 tracked-change 类型统计。 |
| [x] | W22 | Style lint/normalize basics | `scripts/style_lint.py`, `style_normalize.py` | 报告 direct formatting、font drift、fake headings；可保守清理。 | audit/normalize run formatting、paragraph option、heading spacing option。 | Mostly matched | 已有 style audit/normalize tests。 |
| [x] | W23 | Selective style normalization | `tasks/style_lint_normalize.md` | 避免清除有意强调；需要 whitelist/section/style policy。 | `normalize_word_document_styles` 支持 `preserveRunFormatting` allowlist，可在清理字体/颜色/字号等漂移时保留加粗、斜体、下划线、颜色、字号或字体等用户指定的人工强调；仍支持可选 paragraph cleanup 和 heading spacing。更细 section/style policy 留到 v2。 | Mostly matched for v1+ | 已满足 v1+：focused test 覆盖保留 bold/italic intentional emphasis，同时清理 Courier New、红色、字号、段落间距/缩进漂移；工具 schema、direct-agent routing prompt、documents skill guidance 均说明选择性保留策略。 |
| [x] | W24 | Template/style pack basics | `scripts/apply_template_styles.py`, `tasks/templates_style_packs.md` | 复制 template styles/theme/fontTable/numbering，警告分页变化。 | `apply_word_template_styles` 已复制核心 style parts。 | Mostly matched | 已有 apply template tests。 |
| [x] | W25 | Deep template merge | `tasks/templates_style_packs.md` | 模板迁移可能涉及更多 relationships/media/numbering conflicts。 | `apply_word_template_styles` 现在返回 `templateAudit`：报告 replace-all 或 selective allowlist 策略、requested/applied/missing/dependency style ids、style/numbering conflicts、template-only/target-only ids、复制的模板关系和 media。`styleAllowlist` 可只导入指定模板 style id 及 basedOn/next/link 依赖；复制的 styles/numbering/theme 部件中引用的本地图片关系会连同 media/content type 复制；非图片、外部、缺失或不安全关系 fail closed。模板正文/任意内容导入和任意 style conflict 自动决策仍不作为此工具职责。 | Mostly matched for v1+ boundary | 已满足 W25 验收：tests 覆盖默认全量 style parts 复制、选择性 style allowlist + 依赖展开 + missing/conflict audit、模板 numbering part 图片关系/media 复制、unsupported relationship fail-closed；README/skill/tool schema 均说明 `templateAudit` 和 `styleAllowlist`。 |
| [x] | W26 | Footnotes/endnotes basics | `scripts/insert_note.py`, `footnotes_report.py` | true footnotes/endnotes parts、report、render QA。 | true parts、insert/update/inspect。 | Mostly matched | 已有 note generation/inspection/update tests。 |
| [x] | W27 | Rich/multi-paragraph notes | `tasks/footnotes_endnotes.md` | 高保真 notes 需要正确 parts、separators、render QA。 | note text 支持 newline-separated multi-paragraph footnote/endnote body；inspection 保留段落换行；`updateNoteText` 会整条 note body 多段替换并保留 reference/separator。Rich formatting inside note body 明确不作为 v1 路径。 | Mostly matched for v1+ | 已满足常用多段 note：create/insert/update/inspect tests 覆盖 footnote/endnote 多段 OOXML；复杂富格式 note 留到 v2。 |
| [x] | W28 | Forms/content controls basics | `scripts/content_controls.py`, `tasks/forms_content_controls.md` | plain-text SDT 主要路径；可 list/fill。 | plainText/checkbox/dropdown/date SDT + fill。 | Mostly matched | 已有 form generation/inspection/fill tests。 |
| [x] | W29 | Rich/nested content controls | `tasks/forms_content_controls.md` | rich controls 需要额外 SDT props/parts；Codex task 明确限制。 | `inspect_word_document` 使用 balanced SDT scanner 报告 top-level content controls，plain-text split-run 控件保持可填；rich/nested SDT 返回 `fillSupported: false`、`fillUnsupportedReason`、`nestedControlCount` / `hasRichContent`，`fillContentControl` validation/editor 均 fail closed。完整 rich/nested 内容编辑仍不作为安全填充路径。 | Mostly matched for v1+ boundary | 已满足 W29 验收：tests 覆盖 split marker 多 run plain-text SDT 可填、rich SDT 报告 `rich-content-control`、nested SDT 报告 `nested-content-control` 且不会被非贪婪 `<w:sdt>` 正则截断。 |
| [x] | W30 | Protection/restrict editing | `scripts/set_protection.py`, `tasks/protection_restrict_editing.md` | 可设置/审计保护模式，并理解无密码/限制边界。 | `WordDocSpec.protection` 支持新文档保护；`inspect_word_document` 暴露 `inspection.protection` 和 `summary.protectionMode`；`apply_word_document_edits` 支持 `setDocumentProtection` 设置或清除非密码 restrict-editing 模式。 | Mostly matched for v1+ | 已满足：`apply_word_document_edits can set and clear document protection modes` 覆盖 `comments` 与 `off`，并验证 `settings.xml`、content type、relationship、inspection summary；密码保护明确 unsupported。 |
| [x] | W31 | Watermarks/background basics | `scripts/watermark_add.py`, `watermark_audit_remove.py` | add/audit/remove watermark，render+diff 验证。 | 简单 VML text watermark 可新增到所有已有 header part；`inspect_word_document` 可审计 document/header/footer VML textpath watermarks；`removeWatermark` 使用 inspect locator 删除并返回 touched part / removed count audit detail；`apply_word_document_edits` 继续返回结构和 render-quality evidence。 | Mostly matched for v1+ | 已满足 v1+：tests 覆盖 header1/header2 多 header 新增、footer VML watermark inspect/remove、part-level audit detail、结构检查和 render evidence 对象；高级图片/DrawingML 背景见 W32。 |
| [x] | W32 | Advanced backgrounds | `tasks/watermarks_background.md` | 复杂 VML/DrawingML/image backgrounds 需谨慎识别。 | `inspect_word_document.watermarks` 现在区分 `vmlTextPath`、`vmlImageShape` 和 `drawingImageBackground`，并报告 relId、target、relationshipMode、mediaPath、contentType/mediaExists；`removeWatermark` 可按 inspect locator 删除对应 VML/DrawingML XML，并返回 touched part audit。为避免误删复用资源，关系/media 深度清理保持保守。 | Mostly matched for v1+ | 已满足 v1+：tests 覆盖 DrawingML anchored background 和 VML image-shape background 的 inspection、media evidence、locator-based selective removal、结构检查；unused media relationship cleanup 明确为保守边界。 |
| [x] | W33 | Metadata/privacy scrub basics | `scripts/privacy_scrub.py`, `tasks/privacy_scrub_metadata.md` | 清理 core/app/custom props、rsid 等。 | `scrubDocumentMetadata` 支持常见 metadata/rsid。 | Mostly matched | 已有 metadata scrub tests。 |
| [x] | W34 | Redaction/anonymization workflow | `scripts/redact_docx.py`, `tasks/redaction_anonymization.md` | scoped patterns、emails/phones、comments option、render and text-search QA。 | `redactText` 支持 exact items、内置 `email` / `phone` 模式、受限 custom regex、`includeComments`，并在 applied operation detail 中返回 package-level match-count audit（total/exact/pattern、touched parts/text nodes、pattern label counts）；生成后仍走结构/render checks。图片 OCR、跨 run 语义匹配和复杂确认 UI 留到 v2。 | Mostly matched for v1+ | 已满足 v1+：tests 覆盖正文/表格/批注中的 email + phone pattern redaction、comments opt-in、敏感原文不留在 document/comments XML、audit detail 不暴露敏感值但报告命中类别；skill/direct-agent/tool schema 均说明 exact/pattern/comment redaction 边界。 |
| [x] | W35 | Compare/diff basics | `scripts/render_and_diff.py`, `tasks/compare_diff.md` | text diff + before/after render + page diff images。 | compare_word_documents 输出 text diff、page PNG、pixel diff。 | Mostly matched | 已有 compare/diff tests。 |
| [x] | W36 | Advanced visual diff diagnostics | `tasks/compare_diff.md` | 人工检查 changed pages；抗 aliasing 和跨页重排。 | `compare_word_documents` changed pages 现在包含 configurable `pixelThreshold`、changed pixel bbox、3x3 changed-region summaries、dominant changed regions、visual severity、human-readable visual summary 和 risk flags（tiny pixel change、localized change、broad page change、multi-region change、dimension change、possible reflow/antialias）。 | Mostly matched for v1+ | 已满足 v1+：tests 覆盖默认阈值 bbox/region/severity/flags 和高阈值 render-noise review；更深语义 reflow explanation 留到后续人工验收/视觉模型。 |
| [x] | W37 | Multi-doc merge basics | `scripts/merge_docx_append.py`, `tasks/multi_doc_merge.md` | append body，保留 base package；谨慎处理 drawings/images。 | body append、local image rel/media merge。 | Mostly matched | 已有 merge tests。 |
| [x] | W38 | Deep multi-doc merge | `tasks/multi_doc_merge.md` | 多文档合并需处理 styles/numbering/media/embedded objects。 | `merge_word_documents` 保持 base-wins 包结构策略，新增 `mergeAudit`：报告 referenced style conflicts、append-only styles、referenced numId conflicts、append-only numIds、abstractNum conflicts；hyperlink relationships 会重映射，本地图片关系继续在 `allowDrawings` 下合并；非图片/非安全 referenced relationship 和 OLE/object markup 会 fail closed 并在错误中报告。 | Mostly matched for v1+ boundary | 已满足 W38 验收：tests 覆盖 style/numbering base-wins conflict report、append-only style report、PNG media merge、unsupported embedded object relationship blocked/report；任意 embedded object 深拷贝不作为安全路径。 |
| [x] | W39 | Sections/page layout audit | `scripts/section_audit.py`, `tasks/sections_layout.md` | audit sections, page size/orientation/margins/header-footer linkage。 | `inspect_word_document` reports section type, page size, orientation, margins, header/footer references, `differentFirstPage`, document-level `oddEvenHeaders`, and per-slot header/footer Link-to-Previous indicators; `apply_word_document_edits` supports locator-based `updateSectionPageSetup` for size/orientation/margins. | Mostly matched for v1+ | 已满足 v1+ audit/edit baseline：`test/doc-agent.test.ts` 覆盖 mixed section layout inspection with different-first/odd-even/header-footer linkage, plus existing locator-based section page setup update. Header/footer body editing and direct linkage toggling remain v2. |
| [x] | W40 | Read/review existing docs | `tasks/read_review.md`, `C-DocSkill` | 能读取、摘要、审阅 DOCX，并保留结构/视觉限制。 | `read_docx` 和 `inspect_word_document` 可读结构；`inspect_word_document` 输出 bounded inspection JSON，避免大文档硬截断成非法 JSON；v1 task doc 要求 inspect-first controlled editing。 | Mostly matched for v1 | v1 已满足：read/inspect/edit tests 通过；ToolRuntime v1 smoke 覆盖 create -> read -> inspect -> apply edits -> style audit，并验证 render artifact 或 honest fallback。后续可补更强 render-backed review UX。 |
| [x] | W41 | Google Docs targeted output | `C-DocSkill`, `scripts/google_docs_title_sanitize.py` | 先生成/渲染 DOCX，再 Google Drive import native Docs；sanitize title blocks。 | 当前目标只要求离线本地 Word，不生成 native Google Docs。 | Out of scope | 范围决策已记录：不实现 Google Docs targeted output；离线 Word preset 可以保留，但不作为 parity 缺口。 |
| [x] | W42 | Google Docs native import integration | `C-DocSkill` | 使用 Google Drive plugin `google_drive_import_document` 上传为 native Google Docs。 | 当前目标只要求离线本地 Word，不接 Google Drive。 | Out of scope | 范围决策已记录：不接入 Google Drive connector，不纳入当前 parity 目标。 |
| [x] | W43 | Skill script execution boundary | `C-Skill`, `C-Manifest`, `C-Scripts` | Codex 可按 skill 执行 bundled helper scripts。 | 新增 `chipmate_run_skill_script` 安全执行边界：只能运行 active skill 中 `allowed-tools` 允许的脚本工具；必须存在 `scripts/manifest.json` 且 `executionPolicy.directExecution === true`；helper 必须在 manifest 中匹配并声明 `execution.runtime` 与 `execution.entrypoint`；entrypoint 必须位于 skill `scripts/` 下；参数以 bounded JSON stdin 传入；执行通过 `spawn` 参数数组而非 shell 拼接，并受普通 command permission/audit/timeout/output cap 约束。documents helper catalog 当前默认 `directExecution=false`，因此继续优先 native Word tools。 | Mostly matched for v2 safety boundary | 已满足 W43 验收：tests 覆盖工具定义暴露、manifest-opt-in active skill node helper 执行、JSON stdin/stdout、审计字段、`directExecution=false` fail-closed；routing prompt/README/skill docs 均要求优先 native tools，只对 manifest executable helper 使用 `chipmate_run_skill_script`。 |
| [x] | W44 | Helper scripts distribution | `C-Manifest`, `C-Scripts` | documents plugin 分发 30+ Python helper scripts。 | `.agents/skills/documents/scripts/manifest.json` 现在作为只读 skill resource 分发版本化 helper catalog，覆盖 36 个 Codex documents helper script 名称，并映射到 ChipMate native tools、out-of-scope 决策、W43 安全执行边界或 `patchOoxmlPart`；`scripts/README.md` 明确当前不直接执行脚本，执行边界归 W43。 | Mostly matched for v2 resource distribution | 已满足 W44 验收：tests 覆盖 skill registry 发现 `scripts/manifest.json`、prompt 渲染 resource loading guidance、ToolRuntime 可读取 active skill 的 scripts resource、manifest 覆盖关键 Codex script 名称且 `directExecution=false`，并确认 `.vscodeignore` 不排除该 resource。 |
| [x] | W45 | Freeform OOXML repair path | `ooxml/*.md`, `scripts/docx_ooxml_patch.py` | 对未建模功能可写/跑 OOXML patcher。 | `apply_word_document_edits.patchOoxmlPart` 提供受控低层 XML OOXML repair：必须先 `inspect_word_document`，只能用 returned `documentEnd` locator；只允许安全 XML package parts（如 `word/document.xml`、`word/settings.xml`、`word/_rels/document.xml.rels`、`[Content_Types].xml`）；每个补丁必须声明 `replace` / `insertBefore` / `insertAfter` / `appendBeforeClose`、精确 oldText/anchor/closeTag 和 `expectedOccurrences`；执行前后做危险片段拦截、轻量 XML well-formed 校验、DOCX 结构 gate、render-quality gate 和 applied-operation audit；禁止 external relationships、macro、OLE、ActiveX、embedded binary 引用和任意二进制 package mutation。 | Matched for controlled OOXML repair boundary | 已满足 W45 验收：tests 覆盖正向 `word/document.xml` OOXML patch 写入真实段落并通过结构检查，负向 unsafe external relationship fail-closed；routing prompt/tool schema/README/skill docs 均要求优先 native Word operations，仅在未建模低层 OOXML repair 时使用 `patchOoxmlPart`。 |
| [x] | W46 | Fixture/regression generation | `scripts/make_fixtures.py`, `tasks/fixtures_edge_cases.md` | 可生成 tracked changes/watermark fixtures 做 smoke tests。 | 新增 `scripts/make-docx-fixtures.ts` 和 `bun run fixtures:docx -- --out <dir>`，生成 manifest + DOCX fixtures，覆盖多 story part VML watermarks、基础 tracked changes、caption/REF/PAGEREF/SEQ 字段。 | Mostly matched for v1+ | 已满足 v1+：测试实际执行 fixture generator，并用 `WordDocumentInspector` / `auditWordDocumentFields` 验证 watermark parts、tracked change XML 和 field counts；skill/README 已说明 fixture 只用于开发/回归，不作为用户交付物。 |
| [x] | W47 | Troubleshooting docs | `troubleshooting/libreoffice_headless.md`, `run_splitting.md` | 有 LO/render/run splitting 排障文档。 | `documents` skill 已有 `tasks/render_troubleshooting_v1.md`，覆盖 `soffice`/LibreOffice、PDF->PNG、profile/HOME、fallback disclosure。 | Mostly matched for v1 | v1 已满足：render troubleshooting resource 可被 skill resource 机制发现/读取；更深 run-splitting docs 留到 v1+。 |
| [x] | W48 | Final response discipline | `C-DocSkill` | 默认只交付最终 DOCX，不暴露 QA 中间产物，除非用户要求。 | `documents` skill 和 v1 task doc 已要求最终交付 `.docx` 和关键 warnings，不倾倒 OOXML/JSON/PNG bundles。 | Mostly matched for v1 | v1 已满足 skill-level contract；后续可补 chat snapshot 测试锁定最终回答文案。 |
| [x] | W49 | Reference-pack/C guideline cleanup | Project boundary | Codex documents 是通用能力，不含 ChipMate 专项 C guideline flow。 | 旧 reference-pack/C guideline flow 仍保留为专项能力，但入口已收窄：普通公司/团队/内部/规范类 Word 请求不再被旧流拦截；一个源 `.docx` 的普通“生成/整理/完善 Word”请求不再自动当作编辑原文档处理；ChatView 本地 Word 专项 flow 路由已抽成 `classifyLocalDocumentFlow` 并测试锁定，普通 Word 生成会继续进入通用模型/工具链路径。 | Mostly matched for v1 boundary | 已满足 v1 边界：`DocxIntentDetector` 只匹配明确 C/coding/编码规范；`isWordEditIntent` 只匹配明确编辑/审稿/修订/版式维护语义；`classifyLocalDocumentFlow` 覆盖 ChatView 本地 flow 选择；focused tests 覆盖 generic Word 请求不进入旧 C guideline flow、不把 one-source generic generation 当编辑、不被 ChatView 本地专项 flow 拦截。旧 reference-pack 删除留到后续专项清理。 |
| [x] | W50 | Design-doc reuse boundary | Project boundary | 详细设计文档应是上层 skill，复用通用 Word 能力。 | 当前 detailed-design flow 仍是专项上层能力，但 Word 出口只经过 `createDocument ?? createWordDocument` 和 `WordDocSpec`；没有直接 import/use `WordDocBuilder`、`WordDocumentEditor`、`WordDocumentInspector` 或 `DocxFileStore`。后续可把设计文档业务编排迁移为 skill，但不能 fork Word 底层流水线。 | Mostly matched for v1 boundary | v1 已满足边界：`test/design-doc-agent.test.ts` 锁定详细设计 flow 只能复用通用 `create_word_document` 边界，并继续验证设计文档图表/正文 spec 通过注入的 `createDocument` 交付。 |

## Suggested Execution Order

V1 Gate A - ship the usable offline Word loop:

- W01 Skill package shape: make `documents` a real discoverable workflow guide, even if v1 uses built-in tools rather than arbitrary script execution.
- W04 New DOCX creation workflow: ensure normal user prompts can become good `WordDocSpec` without a specialized producer.
- W40 Read/review existing docs: ensure existing `.docx` can be read/inspected before editing.
- W02 Render -> inspect PNG -> iterate loop: make render status and artifacts visible enough for model/user verification.
- W48 Final response discipline: final chat answer should hand off the document cleanly and keep internals out of the user path.
- W49/W50 Boundary cleanup: keep old C guideline/reference-pack and design-doc special flow from defining the generic Word path. Both v1 boundaries are now locked by regression tests.

V1 Gate B - make common documents look and behave like Word documents:

- W05 Design presets and header templates.
- W06/W07/W08 Table geometry, merged cells, and enough long-table behavior to avoid obvious clipping.
- W10/W11 Real lists and heading hierarchy.
- W12/W14 Figures and captions.
- W16/W17 Static/headless-safe TOC plus honest field refresh guidance.
- W22/W24 Style lint and template style basics.
- W47 Troubleshooting docs for local render dependencies and failure modes.

V1 Gate C - stabilize already-present editing features:

- W18 Comments lifecycle.
- W20 Tracked changes basics.
- W26 Footnotes/endnotes basics.
- W28 Forms/content controls basics.
- W33 Metadata/privacy scrub basics.
- W35 Compare/diff basics.
- W37 Multi-doc merge basics.

V1+ backlog - useful, but should not block the first usable VSIX:

- W03 Visual QA object diagnostics. 已完成 v1+ page region density 和 coarse ink-component bbox；高级 reflow/antialias/object semantics 留到 W36/v2。
- W09 XLSX <-> DOCX table helpers. 已完成 v1：简单 XLSX/XLSM 范围提取为 `TableSpec`，并支持 inspected Word table 导出 CSV；spreadsheet 样式、合并单元格语义和公式重算不纳入当前离线 Word v1。
- W13 Advanced image/drawing handling. 已完成 v1+ image inspection placement/relationship/content-type/replace support audit；非 PNG 二进制替换留到 v2。
- W15 Cross-reference refresh/materialization authoring polish. 已完成：rich paragraph marker authoring 会转换为 live REF/PAGEREF 字段，并继续支持 audit、REF/PAGEREF flatten 和 SEQ cached-number materialization。
- W19 Comment threads/rich metadata. 已完成 v1+ commentsExtended/commentsIds metadata inspection、resolved 同步和 commentsIds clean-copy cleanup；复杂 threaded authoring 留到 v2。
- W21 Advanced redlines. 已完成 v1+ 安全边界：tracked-change type counts、cross-run replacement、move accept/reject、formatting revision fail-closed；复杂结构性表格修订留到后续专项。
- W23 Selective style normalization. 已完成 v1+ run-format allowlist；section/style policy 细化留到 v2。
- W25 Deep template merge. 已完成 v1+ 安全边界：`templateAudit`、selective style allowlist、style/numbering conflict report、copied template-part image relationship/media handling、unsupported relationship fail-closed；模板正文/任意内容导入不作为 template style tool 职责。
- W27 Rich/multi-paragraph notes. 已完成 v1+ newline-separated 多段 footnote/endnote body；rich formatting inside note body 留到 v2。
- W29 Rich/nested content controls. 已完成 v1+ 安全边界：balanced SDT inspection、split-run plain-text fill、rich/nested `fillUnsupportedReason` 和 fill fail-closed；完整 rich/nested 内容编辑留到后续专项。
- W30 Protection/restrict editing inspection/update. 已提前完成非密码模式；不要扩展成密码保护或高级保护策略来阻塞 v1。
- W31 Watermarks/background basics. 已完成 v1+：simple VML text watermark 覆盖多 header part，inspect/remove 覆盖 document/header/footer VML textpath，并返回 part-level audit detail；图片/DrawingML 背景由 W32 覆盖。
- W32 Advanced backgrounds. 已完成 v1+：inspect/report/remove 覆盖 VML image-shape background 和 DrawingML anchored image background；unused relationship/media cleanup 保守保留。
- W34 Redaction/anonymization workflow. 已完成 v1+ exact + email/phone/custom pattern + comments opt-in + audit counts；图片 OCR、跨 run 语义匹配和复杂确认 UI 留到 v2。
- W36 Advanced visual diff diagnostics. 已完成 v1+ bbox、3x3 region、severity、risk flags 和 pixelThreshold；语义级 reflow 解释留到后续视觉审阅。
- W38 Deep multi-doc merge. 已完成 v1+ 安全边界：style/numbering base-wins mergeAudit、hyperlink relationship remap、PNG media merge、unsupported embedded object relationship fail-closed；任意 embedded object 深拷贝不作为安全路径。
- W39 Sections/page layout audit. 已提前完成 v1+ audit/edit baseline；header/footer body editing 和直接 Link-to-Previous toggle 不阻塞 v1+。
- W43 Skill script execution boundary. 已完成 v2 安全边界：active skill + allowed tool + manifest directExecution + executable entrypoint + command permission/audit/timeout/output cap；documents helper catalog 默认仍 read-only，只有 manifest opt-in helper 才可执行。
- W44 Helper scripts distribution. 已完成 v2 resource distribution 边界：`scripts/manifest.json` 覆盖 Codex documents helper script catalog，并映射到 ChipMate native tools / out-of-scope / W43 安全执行边界 / W45 `patchOoxmlPart`；当前只读，不直接执行。
- W45 Freeform OOXML patching. 已完成受控 repair 边界：`apply_word_document_edits.patchOoxmlPart` 覆盖 Codex `docx_ooxml_patch.py` 的低层 XML patch 逃生通道，但保持 XML part allowlist、precondition、dangerous content block、structure/render gates 和 audit。
- W46 Fixture/regression generation. 已完成：`bun run fixtures:docx -- --out <dir>` 可生成 manifest、watermark、tracked-change、fields/captions/crossrefs fixtures，并有测试验证。

V2 edge/backlog:

- No open matrix item after W45; final audit still required before declaring 100% goal completion.

## Verification Contract

每完成一个矩阵项，至少补齐：

- 实现或明确 out-of-scope 决策。
- `CM-Skill` / README / 本矩阵状态更新。
- 单项测试或集成测试，优先放在 `test/doc-agent.test.ts` 或相关 direct/chat tests。
- 运行并记录：
  - `bun run compile`
  - 相关 focused tests
  - `bun test test/doc-agent.test.ts`
  - 对跨 runtime/tool/chat 的改动，运行 `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/design-doc-agent.test.ts test/chat-html.test.ts test/skills-permissions.test.ts`
  - `bun run package`
  - 若行为要在 VS Code 验证，运行 `bun run vsix`
  - VSIX 后执行私有 provider/RAG 字符串扫描，确认 tracked source 无泄漏。

## Current Gap Estimate

| Scope | Current estimate | Remaining gap |
| --- | ---: | ---: |
| v1 离线 Word 可用闭环 | 100% | 无矩阵阻塞；真实用户手工验收仍可发现 polish/bug |
| 固定工具化 Word 功能覆盖 | 100% of scoped matrix | 无开放矩阵项 |
| Codex documents plugin task/script coverage | 100% of offline local Word scope | Google Drive/native Google Docs 明确 out of scope |
| Codex 原生视觉交付体验 | 100% of automated scoped gates | 手工 UI 验收不作为矩阵阻塞 |
| Codex-style skill extensibility | 100% of scoped matrix | 无开放矩阵项 |

预计工作量：

- 矩阵实现闭环：`chipmate-0.1.0-build.238.vsix` 是当前候选；自动化主链路、真实 ToolRuntime 用户路径 smoke、专项边界、ChatView 本地专项 flow 路由护栏、真实 Extension Host + ChatView + documents skill + `create_word_document` smoke、独立 `render_word_document`、聊天内 Word render artifact 和 page PNG 预览均已闭合。2026-06-28 已刷新 build.238 验证：矩阵统计、full scoped Word tests、真实 Chat Word flow、`bun run package`、`bun run vsix` 和私有 provider/RAG 字符串扫描均通过；隔离 VS Code 激活 smoke 已在 build.235 完成，build.238 后续可按真实验收需要再刷新。
- 后续工作不再是矩阵 parity 缺口，而是真实用户验收发现的问题修复、UI polish 或用户重新扩大范围后的新矩阵项。

## Final Audit

- Matrix rows: 50 total, 50 checked.
- Open matrix items: none.
- `Missing`, `Partial`, `Productized but narrower` rows: none.
- Out-of-scope rows: W41 and W42 only, both Google Drive/native Google Docs paths，符合当前离线本地 Word 目标。
- `Mostly matched` rows: all have explicit acceptance evidence and represent ChipMate 的产品化安全边界或已验收 scope wording，不是开放缺口。
- Final candidate: `chipmate-0.1.0-build.238.vsix`.
- Final verification: matrix count check, full scoped Word tests, real Chat Word flow, `bun run compile`, `bun run package`, `bun run vsix`, private provider/RAG source scan, render artifact/chat preview checks, and prior isolated VS Code install/activation smoke.

## Progress Log

### 2026-06-28 v1 Gate A progress

Completed:

- Added read-only `tasks/` skill resource support to the ChipMate skill registry and `chipmate_read_skill_resource`.
- Added `.agents/skills/documents/tasks/create_edit_v1.md`, `render_verify_v1.md`, and `v1_limits_backlog.md`.
- Added `.agents/skills/documents/tasks/table_pagination_v1.md` and `render_troubleshooting_v1.md`.
- Updated `.agents/skills/documents/SKILL.md` to route v1 details through task resources.
- Marked W01, W02, W04, W40, and W48 as v1 matched/mostly matched based on current implementation and tests.
- Marked W05, W11, W16, and W17 as v1 matched/mostly matched based on current implementation and tests.
- Marked W08 and W47 as v1 matched/mostly matched based on long-table fixture coverage and new troubleshooting task docs.
- Reprioritized v1 around a fully usable offline Word loop. Edge-case parity items stay tracked in v1+/v2 and do not block the first usable VSIX.
- Added an automated v1 acceptance smoke fixture covering new DOCX creation, report structure with table/list/figure/static TOC, render artifacts, inspect-first locator edits, comments, tracked changes, and style audit.
- Marked W30 protection/restrict editing mostly matched for v1+ after adding inspect/update support and `tasks/protection_v1.md`.
- Marked W49 reference-pack/C guideline cleanup matched for the v1 boundary after narrowing document-agent intent routing and adding regression coverage for generic Word requests.
- Added `documents` skill metadata keywords plus wildcard keyword matching so Chinese local Word generation/edit requests implicitly load the `documents` skill body before model planning.
- Added direct-agent-client coverage proving a Chinese generic Word generation request can implicitly load `documents`, expose `create_word_document`, execute the tool with a model-authored `WordDocSpec`, pass the tool result back to the model, and return the final document path text.
- Added real `ToolRuntime` coverage for `create_word_document`, proving the actual Word toolchain writes a ZIP/DOCX artifact under `.chipmate/docs` and returns `GeneratedDocumentResult` data.
- Marked W50 design-doc reuse boundary matched for the v1 boundary after adding a regression test that prevents detailed-design flow from directly using Word builder/editor/inspector internals.
- Fixed `inspect_word_document` ToolRuntime output to return bounded, valid JSON instead of byte-truncated invalid JSON, preserving exact locators for controlled edits.
- Added a ToolRuntime v1 local Word smoke covering create, read, inspect, locator-based edit, inserted section with list/table/PNG, render artifact or honest fallback, and style audit through public tools.

Verification:

- `bun run compile` passed before the v1 task-resource change.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed: 359 tests.
- After adding `tasks/` resource support, `bun test test/skills-permissions.test.ts test/direct-agent-client.test.ts` passed: 119 tests.
- After the final v1 task-resource/docs update, `bun run compile` passed.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed again: 359 tests.
- `bun run package` passed.
- `bun run vsix` produced `chipmate-0.1.0-build.204.vsix`.
- After W08/W47 updates, `bun run compile` passed.
- After stabilizing the goal-continuation async test wait, `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed: 360 tests.
- `bun run package` passed again.
- `bun run vsix` produced `chipmate-0.1.0-build.205.vsix`.
- Private provider/RAG source scan passed after the documentation update; no matches outside ignored VSIX artifacts.
- `bun test test/doc-agent.test.ts -t "v1 usable Word smoke"` passed: 1 smoke test.
- After adding the v1 acceptance smoke, `bun run compile` passed.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed: 361 tests.
- `bun run package` passed after the smoke update.
- Private provider/RAG source scan passed again; no matches outside ignored VSIX artifacts.
- `bun test test/doc-agent.test.ts -t "document protection"` passed: 1 protection test.
- `bun test test/skills-permissions.test.ts` passed: 9 tests.
- `bun run compile` passed after W30 protection support.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed after W30 protection support: 362 tests.
- `bun run package` passed after W30 protection support.
- `bun run vsix` produced `chipmate-0.1.0-build.206.vsix`.
- Private provider/RAG source scan passed after `build.206`; no matches outside ignored VSIX artifacts.
- `bun test test/doc-agent.test.ts -t "does not route generic Word requests|does not treat one-source generic Word generation|matches local Word guideline generation|WordEditAgentFlow persists"` passed after W49 routing cleanup: 4 tests.
- `bun run compile` passed after W49 routing cleanup.
- `bun run package` passed after W49 routing cleanup.
- `bun run vsix` produced `chipmate-0.1.0-build.207.vsix`.
- Private provider/RAG source scan passed after `build.207`; no matches outside ignored VSIX artifacts.
- `bun test test/skills-permissions.test.ts -t "metadata keywords|resource references|skill eval"` passed after documents skill activation update: 3 tests.
- `bun test test/direct-agent-client.test.ts -t "documents skill implicitly|explicitly invoked skills"` passed after documents skill activation update: 2 tests.
- `bun test test/direct-agent-client.test.ts -t "executes create_word_document|documents skill implicitly"` passed after generic Word tool-loop coverage: 2 tests.
- `bun test test/direct-agent-client.test.ts -t "real Word toolchain"` passed after real `ToolRuntime.create_word_document` artifact coverage: 1 test.
- `bun run compile` passed after documents skill activation update.
- `bun run package` passed after documents skill activation update.
- `bun run vsix` produced `chipmate-0.1.0-build.208.vsix`.
- Private provider/RAG source scan passed after `build.208`; no matches outside ignored VSIX artifacts.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed after generic Word tool-loop coverage: 367 tests.
- `bun run compile` passed after generic Word tool-loop coverage.
- `bun run package` passed after generic Word tool-loop coverage.
- `bun run vsix` produced `chipmate-0.1.0-build.209.vsix`.
- Private provider/RAG source scan passed after `build.209`; no matches outside ignored VSIX artifacts.
- `bun run compile` passed after real `ToolRuntime.create_word_document` artifact coverage.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed after real Word artifact coverage: 368 tests.
- `bun run package` passed after real Word artifact coverage.
- `bun run vsix` produced `chipmate-0.1.0-build.210.vsix`.
- Private provider/RAG source scan passed after `build.210`; no matches outside ignored VSIX artifacts.
- `bun test test/design-doc-agent.test.ts` passed after W50 boundary coverage: 3 tests.
- `bun run compile` passed after W50 boundary coverage.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed after W50 boundary coverage: 369 tests.
- `bun run package` passed after W50 boundary coverage.
- `bun run vsix` produced `chipmate-0.1.0-build.211.vsix`.
- Private provider/RAG source scan passed after `build.211`; no matches outside ignored VSIX artifacts.
- `bun test test/direct-agent-client.test.ts -t "v1 local Word user path"` passed after the ToolRuntime v1 smoke and bounded inspect output fix: 1 test.
- `bun test test/direct-agent-client.test.ts` passed after the ToolRuntime v1 smoke and bounded inspect output fix: 114 tests.
- `bun run compile` passed after the ToolRuntime v1 smoke and bounded inspect output fix.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed after the ToolRuntime v1 smoke and bounded inspect output fix: 370 tests.
- `bun run package` passed after the ToolRuntime v1 smoke and bounded inspect output fix.
- `bun run vsix` produced `chipmate-0.1.0-build.212.vsix`.
- Private provider/RAG source scan passed after `build.212`; no matches outside ignored VSIX artifacts.
- Default VS Code CLI upgrade installed `chipmate-0.1.0-build.212.vsix` over `local.chipmate@0.1.0-build.183`; `code --list-extensions --show-versions` reports `local.chipmate@0.1.0-build.212`.
- Installed `chipmate-0.1.0-build.212.vsix` in an isolated VS Code profile using temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.212`.
- Isolated VS Code extension-host smoke activated `local.chipmate` at `2026-06-28 12:28:55 +0800` with activation event `onStartupFinished`; the checked exthost log segment had no ChipMate error entries.
- Ran a second isolated VS Code smoke profile for build.212 with a local fake OpenAI-compatible provider. Extension activation succeeded at `2026-06-28 12:35:36 +0800`, and the fake provider received `/v1/models` health/model probes from the installed extension.
- Attempted to drive `ChipMate: Ask ChipMate About Current File` through macOS command palette automation against the isolated profile. macOS focus stayed on the default VS Code process instead of the isolated smoke process, so no chat completion request was sent and no UI-generated `.docx` was produced in that attempt.
- Reclassified the real Chat UI prompt automation as an end-user UI acceptance/v1+ runner task. The v1 candidate should be judged first by the already-passing generic model-tool loop, real `ToolRuntime` DOCX artifact smoke, and installed-extension activation smoke; edge-case UI automation should not block the first usable VSIX.
- Marked W39 section/page layout audit mostly matched for v1+ after adding section inspection fields for `differentFirstPage`, `oddEvenHeaders`, and per-slot header/footer Link-to-Previous indicators; added `tasks/sections_layout_v1.md` guidance.
- `bun test test/doc-agent.test.ts -t "section"` passed after W39 section audit coverage: 15 tests.
- `bun run compile` passed after W39 section audit support.
- `bun test test/doc-agent.test.ts test/skills-permissions.test.ts` passed after W39 section audit support: 188 tests.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/chat-html.test.ts test/skills-permissions.test.ts test/design-doc-agent.test.ts` passed after W39 section audit support: 371 tests.
- `bun run package` passed after W39 section audit support.
- `bun run vsix` produced `chipmate-0.1.0-build.213.vsix`.
- Private provider/RAG source scan passed after `build.213`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.213.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.213`.
- Isolated VS Code Extension Host smoke activated `local.chipmate` at `2026-06-28 15:25:07 +0800` and `2026-06-28 15:25:13 +0800` via activation event `onStartupFinished`; the checked Extension Host log segment had no `[error]` / `[critical]` entries. The only ChipMate warnings were expected empty-profile CodeGraph/RAG stored-index-missing messages.
- Added `classifyLocalDocumentFlow` as the ChatView local Word flow route guard so ordinary Word generation requests continue to the generic documents skill/model-tool path, while explicit C guideline reference-pack generation and existing `.docx` edits keep their specialized routes.
- Added an env-gated internal Chat Word smoke command and `bun run verify:chat-word-flow`, proving the installed ChatView path can trigger the documents skill and model-authored `create_word_document` call in a real Extension Host without relying on fragile macOS command-palette automation.
- Marked W23 selective style normalization mostly matched for v1+ after adding `preserveRunFormatting` to the style normalizer, tool schema, direct-agent routing guidance, and documents skill guidance.
- Marked W03 visual QA object diagnostics mostly matched for v1+ after adding 3x3 rendered-page region density summaries and coarse tile-based ink component bounding boxes with page-area, edge-touching, and risk flags.
- Marked W34 redaction/anonymization workflow mostly matched for v1+ after adding exact + email/phone/custom pattern redaction, comments opt-in, package-level redaction audit counts, and model/skill/tool guidance.
- `bun test test/doc-agent.test.ts -t "classifies ChatView local Word routing"` passed: 1 test.
- `bun run compile` passed after the ChatView route guard extraction.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/chat-html.test.ts test/chat-history.test.ts test/skills-permissions.test.ts test/manifest.test.ts test/design-doc-agent.test.ts` passed after the route guard extraction and chat-history fixture sync: 411 tests.
- `bun run package` passed after the route guard extraction.
- `bun run vsix` produced `chipmate-0.1.0-build.214.vsix`.
- Private provider/RAG source scan passed after `build.214`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.214.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.214`.
- Isolated VS Code Extension Host smoke activated `local.chipmate` at `2026-06-28 15:31:00 +0800` and `2026-06-28 15:31:09 +0800` via activation event `onStartupFinished`; the checked Extension Host log segment had no `[error]` / `[critical]` entries. The only ChipMate warnings were expected empty-profile CodeGraph/RAG stored-index-missing messages.
- `bun run verify:chat-word-flow` passed after adding the stable ChatView smoke runner; it produced `.chipmate/docs/chat-word-smoke-20260628-074322.docx` through a real Extension Host, ChatView, documents skill activation, streamed model tool call, and real `create_word_document` execution. The fake OpenAI-compatible provider saw 2 chat requests: one tool-call turn and one final-answer turn.
- `bun run compile` passed after the Chat Word smoke runner.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/chat-html.test.ts test/chat-history.test.ts test/skills-permissions.test.ts test/manifest.test.ts test/design-doc-agent.test.ts` passed after the Chat Word smoke runner: 411 tests.
- `bun run package` passed after the Chat Word smoke runner.
- `bun run vsix` produced `chipmate-0.1.0-build.215.vsix`.
- Private provider/RAG source scan passed after `build.215`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.215.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.215`.
- Isolated VS Code Extension Host smoke activated `local.chipmate` at `2026-06-28 15:44:53 +0800` via activation event `onStartupFinished`; the checked Extension Host logs had no `[error]` / `[critical]` / unhandled-extension-host entries.
- `bun test test/doc-agent.test.ts -t "normalize_word_document_styles"` passed after W23 selective style normalization support: 2 tests.
- `bun run compile` passed after W23 selective style normalization support.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts` passed after W23 selective style normalization support: 294 tests.
- `bun run package` passed after W23 selective style normalization support.
- `bun run vsix` produced `chipmate-0.1.0-build.216.vsix`.
- Private provider/RAG source scan passed after `build.216`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.216.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.216`.
- Isolated VS Code Extension Host smoke activated `local.chipmate` at `2026-06-28 15:52:21 +0800` via activation event `onStartupFinished`; the checked Extension Host logs had no `[error]` / `[critical]` / unhandled-extension-host entries.
- `bun test test/doc-agent.test.ts -t "render_word_document persists|compare_word_documents persists"` passed after W03 visual QA region/component diagnostics: 2 tests.
- `bun run compile` passed after W03 visual QA region/component diagnostics.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts` passed after W03 visual QA region/component diagnostics: 294 tests.
- `bun run package` passed after W03 visual QA region/component diagnostics.
- `bun run vsix` produced `chipmate-0.1.0-build.217.vsix`.
- Private provider/RAG source scan passed after `build.217`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.217.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.217`.
- Isolated VS Code Extension Host smoke activated `local.chipmate` at `2026-06-28 15:58:21 +0800` via activation event `onStartupFinished`; the checked Extension Host logs had no `[error]` / `[critical]` / unhandled-extension-host entries.
- `bun test test/doc-agent.test.ts -t "redact"` passed after W34 redaction pattern/audit support: 2 tests.
- `bun run compile` passed after W34 redaction pattern/audit support.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts` passed after W34 redaction pattern/audit support: 295 tests.
- `bun run package` passed after W34 redaction pattern/audit support.
- `bun run vsix` produced `chipmate-0.1.0-build.218.vsix`.
- Private provider/RAG source scan passed after `build.218`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.218.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.218`.
- Isolated VS Code Extension Host smoke activated `local.chipmate` at `2026-06-28 16:06:29 +0800` via activation event `onStartupFinished`; the checked Extension Host logs had no `[error]` / `[critical]` / unhandled-extension-host entries.
- Reconfirmed the v1 usable Word candidate after reprioritizing edge parity as v1+/v2: `bun run verify:chat-word-flow` passed on current `0.1.0-build.218` worktree and produced `.chipmate/docs/chat-word-smoke-20260628-081015.docx` through a real Extension Host, ChatView, documents skill activation, streamed model tool call, and real `create_word_document` execution. The fake OpenAI-compatible provider saw 2 chat requests: one tool-call turn and one final-answer turn.
- `bun test test/direct-agent-client.test.ts -t "v1 local Word user path"` passed during the v1 readiness refresh: 1 test.
- `bun test test/doc-agent.test.ts -t "v1 usable Word smoke"` passed during the v1 readiness refresh: 1 test.
- `bun run compile` passed during the v1 readiness refresh.
- Marked W15 cross-reference refresh/materialization mostly matched for v1+ after adding rich paragraph `{{ref:bookmark&#124;visible text}}` / `{{pageref:bookmark&#124;page text}}` marker authoring in both `create_word_document` and `apply_word_document_edits`, plus skill/README/tool schema guidance.
- `bun test test/doc-agent.test.ts -t "cross-reference markers|audit_word_document_fields|materialize_word_seq_fields"` passed after W15 marker authoring support: 4 tests.
- `bun run compile` passed after W15 marker authoring support.
- `bun test test/doc-agent.test.ts` passed after W15 marker authoring support: 183 tests.
- `bun run package` passed after W15 marker authoring support.
- `bun run vsix` produced `chipmate-0.1.0-build.219.vsix`.
- Private provider/RAG source scan passed after `build.219`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.219.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.219`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.219` found no `[error]` / `[critical]` / unhandled log entries.
- Marked W31 watermarks/background basics mostly matched for v1+ after expanding addTextWatermark to all existing header parts, adding part-count audit details for add/remove, and covering document/header/footer VML textpath inspect/remove behavior.
- `bun test test/doc-agent.test.ts -t "watermark"` passed after W31 multi-part watermark audit support: 2 tests.
- `bun run compile` passed after W31 multi-part watermark audit support.
- `bun test test/doc-agent.test.ts` passed after W31 multi-part watermark audit support: 184 tests.
- `bun run package` passed after W31 multi-part watermark audit support.
- `bun run vsix` produced `chipmate-0.1.0-build.220.vsix`.
- Private provider/RAG source scan passed after `build.220`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.220.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.220`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.220` found no `[error]` / `[critical]` / unhandled log entries.
- Marked W46 fixture/regression generation mostly matched for v1+ after adding `scripts/make-docx-fixtures.ts`, `bun run fixtures:docx -- --out <dir>`, and manifest-backed fixtures for multi-part watermarks, basic tracked changes, and fields/captions/crossrefs.
- `bun test test/doc-agent.test.ts -t "make-docx-fixtures"` passed after W46 fixture generator support: 1 test.
- `bun run fixtures:docx -- --out /tmp/chipmate-docx-fixtures-cmd-*` generated 3 DOCX fixtures plus `manifest.json`.
- `bun run compile` passed after W46 fixture generator support.
- `bun test test/doc-agent.test.ts` passed after W46 fixture generator support: 185 tests.
- `bun run package` passed after W46 fixture generator support.
- `bun run vsix` produced `chipmate-0.1.0-build.221.vsix`.
- Private provider/RAG source scan passed after `build.221`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.221.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.221`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.221` found no `[error]` / `[critical]` / unhandled log entries.
- Marked W27 rich/multi-paragraph notes mostly matched for v1+ after adding newline-separated multi-paragraph footnote/endnote generation, inspection, insertion, and `updateNoteText` replacement while keeping rich formatting inside note bodies out of the v1 path.
- `bun test test/doc-agent.test.ts -t "footnote|endnote|note"` passed after W27 multi-paragraph note support: 3 tests.
- `bun run compile` passed after W27 multi-paragraph note support.
- `bun test test/doc-agent.test.ts` passed after W27 multi-paragraph note support: 186 tests.
- `bun run package` passed after W27 multi-paragraph note support.
- `bun run vsix` produced `chipmate-0.1.0-build.222.vsix`.
- Private provider/RAG source scan passed after `build.222`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.222.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.222`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.222` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window; the only ChipMate warning was the expected empty-profile CodeGraph stored-index-missing message.
- Marked W13 advanced image/drawing handling mostly matched for v1+ after extending image inspection with placement, relationship mode, targetMode, media path/extension/content type/existence, and replace support/unsupported-reason metadata.
- `bun test test/doc-agent.test.ts -t "image|figure"` passed after W13 image inspection support: 9 tests.
- `bun run compile` passed after W13 image inspection support.
- `bun test test/doc-agent.test.ts` passed after W13 image inspection support: 187 tests.
- `bun run package` passed after W13 image inspection support.
- `bun run vsix` produced `chipmate-0.1.0-build.223.vsix`.
- Private provider/RAG source scan passed after `build.223`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.223.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.223`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.223` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window; the only ChipMate warning was the expected empty-profile CodeGraph stored-index-missing message.
- Marked W19 comment threads/rich metadata mostly matched for v1+ after adding commentsExtended/commentsIds metadata inspection, parent-thread linkage, resolved-source reporting, setCommentResolved synchronization to existing commentsExtended state, and commentsIds orphan cleanup.
- `bun test test/doc-agent.test.ts -t "comment"` passed after W19 commentsExtended/thread metadata support: 9 tests.
- `bun run compile` passed after W19 commentsExtended/thread metadata support.
- `bun test test/doc-agent.test.ts` passed after W19 commentsExtended/thread metadata support: 188 tests.
- `bun run package` passed after W19 commentsExtended/thread metadata support.
- `bun run vsix` produced `chipmate-0.1.0-build.224.vsix`.
- Private provider/RAG source scan passed after `build.224`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.224.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.224`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.224` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window; the only ChipMate warning was the expected empty-profile CodeGraph stored-index-missing message.
- Marked W36 advanced visual diff diagnostics mostly matched for v1+ after adding configurable pixel thresholds, changed pixel bbox, 3x3 changed-region summaries, dominant changed regions, visual severity, human-readable summaries, and risk flags to `compare_word_documents` changed pages.
- `bun test test/doc-agent.test.ts -t "compare_word_documents"` passed after W36 visual diff diagnostics: 3 tests.
- `bun run compile` passed after W36 visual diff diagnostics.
- `bun test test/doc-agent.test.ts` passed after W36 visual diff diagnostics: 189 tests.
- `bun run package` passed after W36 visual diff diagnostics.
- `bun run vsix` produced `chipmate-0.1.0-build.225.vsix`.
- Private provider/RAG source scan passed after `build.225`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.225.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.225`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.225` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window; the only ChipMate warning was the expected empty-profile CodeGraph stored-index-missing message.
- Marked W09 XLSX <-> DOCX table helpers mostly matched for v1 after adding `extract_xlsx_table` and `export_word_table_to_csv`, wiring both into ToolRuntime and the documents skill, and documenting the bounded no-style/no-formula-recalc/no-merged-cell-semantics boundary.
- `bun test test/direct-agent-client.test.ts -t "extract_xlsx_table returns|export_word_table_to_csv|exposes read evidence"` passed after W09 spreadsheet/table helper support: 3 tests.
- `bun run compile` passed after W09 spreadsheet/table helper support.
- `bun test test/direct-agent-client.test.ts` passed after W09 spreadsheet/table helper support: 116 tests.
- `bun test test/doc-agent.test.ts` passed after W09 spreadsheet/table helper support: 189 tests.
- `bun test test/manifest.test.ts` passed after W09 spreadsheet/table helper support: 14 tests.
- `bun run package` passed after W09 spreadsheet/table helper support.
- `bun run vsix` produced `chipmate-0.1.0-build.226.vsix`.
- Private provider/RAG source scan passed after `build.226`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.226.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.226`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.226` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window; the only ChipMate warning was the expected empty-profile CodeGraph stored-index-missing message.
- Marked W32 advanced backgrounds mostly matched for v1+ after extending watermark/background inspection to `vmlImageShape` and `drawingImageBackground`, adding relationship/media evidence fields, and enabling locator-based `removeWatermark` removal for VML/DrawingML background XML while keeping relationship/media cleanup conservative.
- `bun test test/doc-agent.test.ts -t "background|watermark"` passed after W32 advanced background support: 3 tests.
- `bun run compile` passed after W32 advanced background support.
- `bun test test/doc-agent.test.ts` passed after W32 advanced background support: 190 tests.
- `bun test test/direct-agent-client.test.ts` passed after W32 advanced background support: 116 tests.
- `bun test test/manifest.test.ts` passed after W32 advanced background support: 14 tests.
- `bun run package` passed after W32 advanced background support.
- `bun run vsix` produced `chipmate-0.1.0-build.227.vsix`.
- Private provider/RAG source scan passed after `build.227`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.227.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.227`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.227` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window; the only ChipMate warning was the expected empty-profile CodeGraph stored-index-missing message.
- Reconfirmed v1 usable candidate after reprioritizing edge parity behind first delivery:
  - `bun test test/direct-agent-client.test.ts -t "v1 local Word user path"` passed: 1 test, covering ToolRuntime create/read/inspect/locator-edit/render-or-honest-fallback/style-audit flow.
  - `bun test test/doc-agent.test.ts -t "v1 usable Word smoke"` passed: 1 test, covering create/edit/report structure/render/comments/redlines/style QA.
  - `bun run compile` passed.
  - `bun run verify:chat-word-flow` passed and generated `.chipmate/docs/chat-word-smoke-20260628-092335.docx` through a development Extension Host, ChatView, documents skill activation, streamed model tool-call turn, real `create_word_document`, and final-answer turn.
  - `bun run package` passed.
- Refreshed the installable v1 candidate from the current worktree:
  - `bun run vsix` passed and produced `chipmate-0.1.0-build.228.vsix`.
  - Private provider/RAG source scan passed after `build.228`; no matches outside ignored VSIX artifacts.
  - Installed `chipmate-0.1.0-build.228.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.228`.
  - Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.228` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window.
- Marked W29 rich/nested content controls mostly matched for the v1+ safety boundary after adding balanced SDT inspection, `fillSupported` / `fillUnsupportedReason` reporting, and validation/editor fail-closed handling for rich or nested SDTs.
- `bun test test/doc-agent.test.ts -t "content control"` passed after W29: 3 tests.
- `bun run compile` passed after W29.
- `bun test test/doc-agent.test.ts` passed after W29: 191 tests.
- `bun test test/direct-agent-client.test.ts test/manifest.test.ts` passed after W29: 130 tests.
- `bun run package` passed after W29.
- `bun run vsix` produced `chipmate-0.1.0-build.229.vsix`.
- Private provider/RAG source scan passed after `build.229`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.229.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.229`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.229` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window.
- Marked W38 deep multi-doc merge mostly matched for the v1+ safety boundary after adding `mergeAudit`, base-wins style/numbering conflict reporting, hyperlink relationship remapping, and unsupported embedded object fail-closed handling.
- `bun test test/doc-agent.test.ts -t "merge_word_documents"` passed after W38: 5 tests.
- `bun run compile` passed after W38.
- `bun test test/doc-agent.test.ts` passed after W38: 193 tests.
- `bun test test/direct-agent-client.test.ts test/manifest.test.ts` passed after W38: 130 tests.
- `bun run package` passed after W38.
- `bun run vsix` produced `chipmate-0.1.0-build.230.vsix`.
- Private provider/RAG source scan passed after `build.230`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.230.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.230`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.230` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window.
- Marked W21 advanced redlines mostly matched for the v1+ safety boundary after adding tracked-change type counts/warnings, cross-run visible-text replacement redlines, move revision accept/reject clean-copy handling, and formatting revision fail-closed validation.
- `bun test test/doc-agent.test.ts -t "tracked|redline|revision"` passed after W21: 11 tests.
- `bun run compile` passed after W21.
- `bun test test/doc-agent.test.ts` passed after W21: 196 tests.
- `bun test test/direct-agent-client.test.ts test/manifest.test.ts` passed after W21: 130 tests.
- `bun run package` passed after W21.
- `bun run vsix` produced `chipmate-0.1.0-build.231.vsix`.
- Private provider/RAG source scan passed after `build.231`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.231.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.231`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.231` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window.
- Marked W25 deep template merge mostly matched for the v1+ safety boundary after adding `templateAudit`, `styleAllowlist`, style/numbering conflict reporting, local image media relationship copying for copied template parts, and unsupported relationship fail-closed handling.
- `bun test test/doc-agent.test.ts -t "template"` passed after W25: 5 tests.
- `bun run compile` passed after W25.
- `bun test test/doc-agent.test.ts` passed after W25: 198 tests.
- `bun test test/direct-agent-client.test.ts test/manifest.test.ts` passed after W25: 130 tests.
- `bun run package` passed after W25.
- `bun run vsix` produced `chipmate-0.1.0-build.232.vsix`.
- Private provider/RAG source scan passed after `build.232`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.232.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.232`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.232` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window.
- Marked W44 helper scripts distribution mostly matched for the v2 resource-distribution boundary after adding `.agents/skills/documents/scripts/README.md` and `scripts/manifest.json`, covering 36 Codex documents helper script names and mapping them to ChipMate native tools, out-of-scope decisions, the W43 safety boundary, or W45 `patchOoxmlPart`.
- `bun test test/skills-permissions.test.ts -t "resource"` passed after W44: 1 test.
- `bun test test/manifest.test.ts -t "documents helper script"` passed after W44: 1 test.
- `bun test test/direct-agent-client.test.ts -t "reads active skill resources"` passed after W44: 1 test.
- `bun run compile` passed after W44.
- `bun test test/doc-agent.test.ts` passed after W44: 198 tests.
- `bun test test/direct-agent-client.test.ts test/manifest.test.ts test/skills-permissions.test.ts` passed after W44: 141 tests.
- `bun run package` passed after W44.
- `bun run vsix` produced `chipmate-0.1.0-build.233.vsix`; VSIX file listing showed `.agents/` increased to 11 files, including the helper catalog resources.
- Private provider/RAG source scan passed after `build.233`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.233.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.233`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.233` found no `[error]` / `[critical]` / unhandled log entries before closing the temporary window.
- Marked W43 skill script execution boundary mostly matched for the v2 safety boundary after adding `chipmate_run_skill_script`, active-skill allowlist checks, manifest `directExecution` gating, executable entrypoint validation, bounded JSON stdin, command permission/audit, timeout, and output caps.
- `bun test test/direct-agent-client.test.ts -t "skill script|tool definitions"` passed after W43: 2 tests.
- `bun test test/manifest.test.ts -t "documents helper script"` passed after W43 documentation/manifest updates: 1 test.
- `bun run compile` passed after W43.
- `bun test test/doc-agent.test.ts` passed after W43: 198 tests.
- `bun test test/direct-agent-client.test.ts test/manifest.test.ts test/skills-permissions.test.ts` passed after W43: 142 tests.
- `bun run package` passed after W43.
- `bun run vsix` produced `chipmate-0.1.0-build.234.vsix`; VSIX file listing still includes the documents skill resources and helper catalog.
- Private provider/RAG source scan passed after `build.234`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.234.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.234`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.234` found no `[error]` / `[critical]` / `Unhandled` log entries before closing the temporary window.
- Marked W45 freeform OOXML repair path matched for the controlled OOXML repair boundary after adding `apply_word_document_edits.patchOoxmlPart`, XML package part allowlisting, exact patch preconditions, dangerous OOXML content blocking, XML well-formed checks, structural/render gate integration, and audit details.
- `bun test test/doc-agent.test.ts -t "OOXML part patches"` passed after W45: 1 test.
- `bun test test/manifest.test.ts -t "documents helper script"` passed after W45 manifest update: 1 test.
- `bun run compile` passed after W45.
- `bun test test/doc-agent.test.ts` passed after W45: 199 tests.
- `bun test test/direct-agent-client.test.ts test/manifest.test.ts test/skills-permissions.test.ts` passed after W45: 142 tests.
- `bun test test/chat-html.test.ts test/design-doc-agent.test.ts` passed after W45 final audit: 55 tests.
- Matrix count check passed after W45: 50 / 50 complete, no unchecked rows.
- `bun run package` passed after W45.
- `bun run vsix` produced `chipmate-0.1.0-build.235.vsix`; VSIX file listing included the new `dist` OOXML patch helper module and documents skill resources.
- Private provider/RAG source scan passed after `build.235`; no matches outside ignored VSIX artifacts.
- Installed `chipmate-0.1.0-build.235.vsix` in an isolated VS Code profile with temporary `--user-data-dir` and `--extensions-dir`; isolated `code --list-extensions --show-versions` reported `local.chipmate@0.1.0-build.235`.
- Isolated VS Code activation smoke for `local.chipmate@0.1.0-build.235` found no `[error]` / `[critical]` / `Unhandled` log entries before closing the temporary window.
- Final audit passed: 50 / 50 matrix rows checked, no `Missing` / `Partial` / `Productized but narrower` rows, W41/W42 explicitly out of scope for offline local Word, and no open parity items remain in the current matrix.

### 2026-06-28 build.237 render loop refresh

- Added `docs/chipmate-word-render-parity-plan.md` execution checklist and completed 18 / 18 items, with 0 remaining.
- Added first-class `render_word_document` public tool coverage, including PDF/page PNG artifacts, render summaries, warnings/gaps, and direct model routing for Word visual QA requests.
- Added chat `wordRender` artifact cards with PDF/PNG open/reveal actions and inline page PNG preview thumbnails through safe webview URIs limited to `.chipmate/docs`.
- Updated the `documents` skill guidance so standalone render/preview/pagination/layout checks use `render_word_document`, and render failures are disclosed instead of treated as visual pass.
- `bun run compile` passed after build.237 render-preview changes.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/chat-html.test.ts test/manifest.test.ts` passed after build.237 render-preview changes: 386 tests.
- `bun run package` passed after build.237 render-preview changes.
- `bun run vsix` produced `chipmate-0.1.0-build.237.vsix`.
- Private provider/RAG source scan passed after `build.237`; no matches outside ignored VSIX artifacts.

### 2026-06-28 build.238 final audit refresh

- Matrix count check passed after W15 table escaping cleanup: 50 / 50 complete, 0 unchecked rows, and no malformed matrix rows.
- `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/manifest.test.ts test/design-doc-agent.test.ts test/chat-html.test.ts test/skills-permissions.test.ts` passed after build.237 render-preview changes and matrix refresh: 399 tests.
- `bun run verify:chat-word-flow` passed and generated `.chipmate/docs/chat-word-smoke-20260628-115524.docx` through a development Extension Host, ChatView, documents skill activation, streamed model tool-call turn, real `create_word_document`, and final-answer turn.
- `bun run package` passed after final matrix refresh.
- `bun run vsix` produced `chipmate-0.1.0-build.238.vsix`.
- Private provider/RAG source scan passed after `build.238`; no matches outside ignored VSIX artifacts.
- Final audit remains closed: 50 / 50 matrix rows checked, no open matrix item, and W41/W42 remain the only out-of-scope rows for Google Drive/native Google Docs.
