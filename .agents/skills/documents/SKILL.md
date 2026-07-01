---
name: documents
description: Create, edit, review, and verify general Word `.docx` documents with Codex-style document planning, design presets, controlled edits, and render-quality checks.
allowed-tools:
  - read_docx
  - inspect_word_document
  - apply_word_document_edits
  - render_word_document
  - compare_word_documents
  - merge_word_documents
  - extract_xlsx_table
  - export_word_table_to_csv
  - audit_word_document_styles
  - normalize_word_document_styles
  - apply_word_template_styles
  - audit_word_document_fields
  - flatten_word_ref_fields
  - materialize_word_seq_fields
  - chipmate_render_mermaid_diagram
  - create_word_document
  - chipmate_read_skill_resource
  - chipmate_run_skill_script
  - chipmate_read
metadata:
  keywords:
    - word
    - docx
    - .docx
    - Word 文档
    - 生成文档
    - 生成*文档
    - 创建文档
    - 创建*文档
    - 编辑文档
    - 编辑*文档
    - 修改文档
    - 修改*文档
    - 审阅文档
    - 文档生成
    - 文档编辑
    - 批注
    - 修订
    - 红线
---

# Documents Skill

Use this skill when the user asks to create, revise, review, or verify a general Word `.docx` document. This skill is the generic Word workflow; do not route chip/module detailed design generation here unless the user is asking for the final Word document mechanics.

For the current offline Word v1 workflow, read these resource files when the task needs more detail:

- `tasks/create_edit_v1.md` for local `.docx` creation, existing-document editing, and final-response discipline.
- `tasks/render_verify_v1.md` for render-quality gates, page PNG verification, and field-refresh limits.
- `tasks/table_pagination_v1.md` for long/wide table pagination, repeated headers, and table overflow repair.
- `tasks/protection_v1.md` for Word document protection/restrict-editing modes.
- `tasks/sections_layout_v1.md` for section/page layout audit, mixed portrait/landscape pages, margins, and header/footer linkage.
- `tasks/render_troubleshooting_v1.md` for remote Word render server troubleshooting and visual-QA fallback disclosure.
- `tasks/v1_limits_backlog.md` for supported v1 scope, v1+ backlog, and out-of-scope items.
- `scripts/README.md` and `scripts/manifest.json` for the Codex-style helper script catalog, current ChipMate tool mappings, and W43/W45 execution/OOXML-repair boundaries. Use `chipmate_run_skill_script` only for active skill helper scripts whose manifest explicitly opts in at manifest level or helper `execution.directExecution: true`, gives an executable entrypoint, declares offline network policy, validates inputs, and returns bounded artifacts; prefer native Word tools for all mapped document operations.

## Core Contract

- The model owns the document intent: audience, document type, content outline, heading ladder, form factors, design preset, and what evidence belongs in the document.
- Tools own deterministic execution: reading existing `.docx`, applying validated local edits, building `.docx` from `WordDocSpec`, structural compatibility/a11y checks, and render-quality status with page PNG artifacts when the configured remote Word render server is available. Use `render_word_document` as the standalone visual QA tool when the user wants to preview/check an existing `.docx` without changing it.
- Do not create a separate task-specific Word pipeline when `create_word_document` can receive a complete `WordDocSpec`.
- Do not fake headings, bullets, numbering, tables, or citations with plain text when the `WordDocSpec` field can express the structure.
- Converge once the evidence is sufficient for a useful document. Generate the `.docx` with explicit assumptions, limitations, gaps, and owner-review notes instead of continuing open-ended search/read loops for perfect coverage.
- When evidence is sufficient, build the smallest complete valid `WordDocSpec` first and call `create_word_document`; if the tool returns argument or validation errors, repair the `WordDocSpec` and retry before doing more broad search/read work.
- `create_word_document` requires `spec` to be a JSON object in the tool arguments. Do not pass `JSON.stringify(spec)`, quoted JSON, Markdown, or prose as `spec`. If the tool reports `word-doc-spec-string-disallowed`, `word-doc-spec-json-parse-failed`, or `tool-arguments-invalid-json`, the next retry must use a minimal complete object-shaped `WordDocSpec` and put unresolved coverage into assumptions, limitations, or missingInputs instead of searching more or resubmitting the same long/stringified spec.

## New Document Workflow

Before calling `create_word_document`, prepare a complete `WordDocSpec`:

Minimum required fields are `metadata.title`, `metadata.documentType`, `metadata.language`, `metadata.generatedAt`, `sources: []`, and at least one `sections[]` item with `id`, `level`, and `title`. Use `qualityChecklist.assumptions`, `qualityChecklist.limitations`, and `qualityChecklist.missingInputs` for incomplete evidence rather than delaying the first `.docx` indefinitely.

Call `create_word_document` with object arguments shaped as `{ "filename": "target.docx", "spec": { "metadata": { ... }, "sources": [], "sections": [ ... ] } }`. The `spec` value must not be a string; never wrap the full WordDocSpec in quotes.

1. Choose exactly one design preset in `layout.preset`:
   - `google_docs_default` for native Google Docs-targeted drafts.
   - `standard_business_brief` for memos, briefs, reports, and formal summaries.
   - `compact_reference_guide` for dense guides, checklists, and operator references.
   - `narrative_proposal` for proposals, persuasive writeups, and longer narrative documents.
   When a closer archetype exists, also set `layout.presetAlias` to one of `rfi_response`, `decision_memo`, `launch_messaging_guide`, `contract_negotiation_brief`, `neighborhood_business_proposal`, or `grant_proposal`; the builder resolves the alias to a base preset plus exact token overrides.
   For non-`google_docs_default` local Word documents, choose `layout.headerPattern` when a first-page title/header treatment helps the document: `memo_masthead`, `proposal_centerpiece`, `editorial_cover`, `customer_pack`, `workshop_agenda`, or `customer_story`. Use `none` for plain drafts or edits that should preserve an existing opening.
   Do not set a complex header pattern for `google_docs_default`; that preset keeps a simple first page.
2. Decide the heading ladder and section form factors before drafting:
   - prose section, lead callout, brief/key-facts cards, source evidence cards, quote, pull quote, numbered steps, grouped bullets, checklist, note box, definition list, table, form layout, or source list.
   - Use `lists` for multi-level bullet, numbered, or checklist content instead of faking indentation, bullets, checkbox marks, or decimal prefixes in paragraph text.
   - Use `briefCards` for executive snapshots, key facts, KPI-style summaries, or compact multi-column status cards instead of ordinary tables with fake card styling.
   - Use `definitionList` for term/definition material instead of prose with fake separators.
   - Use `sourceList` for visible evidence/source inventories instead of ad hoc paragraphs.
   - Use `evidenceCards` for traceable evidence summaries, source excerpts, or claim-support cards that need source/path/locator/ref metadata.
   - Use `quoteBlocks` for short quoted excerpts or pull quotes instead of faking quote styling in ordinary paragraphs.
3. Use tables only for truly comparable row/column data. For prose-heavy content, use paragraphs, bullets, callouts, or numbered steps.
4. For tables, provide clear headers and, when helpful, `columnWidthRatios` and `columnAlignments` so the builder can create explicit Word geometry. Table row cells may be plain strings or `{ text, colSpan, rowSpan, alignment }` objects; use real merged-cell specs for section headers or grouped rows instead of fake blank columns or repeated labels. When a table may be referenced later, provide `caption`, `label`, and a stable `bookmark`; table captions render as Word Caption paragraphs with cached `SEQ Table` numbering and bookmark anchors.
5. For figures, provide PNG image data or a local PNG artifact path with title, caption, alt text, and a stable `bookmark` when the figure may be referenced later. If the figure is a Mermaid diagram, call `chipmate_render_mermaid_diagram` first, use `scale: 3` for Word figures, and use the returned PNG path in `FigureSpec.image.path` / `artifactPath`; the tool uses the configured remote render server and does not run a local Chrome/Edge fallback. Word should show the rendered PNG, not raw diagram syntax. Keep `FigureSpec.image.width` / `height` as the returned CSS display size; do not use diagnostic `pixelWidth` / `pixelHeight` as the Word display size. If it reports `pngGenerated=false` or `wordFigureUsable=false`, omit that figure from Word, disclose that the remote Mermaid PNG was unavailable, and do not use Mermaid source text as a figure substitute. Captions render as Word Caption paragraphs with bookmark anchors and cached `SEQ` numbering fields. Minimal PNG-backed figure shape: `{ "title": "CI flow", "caption": "CI main flow.", "altText": "Flowchart of the CI main flow.", "bookmark": "fig_ci_flow", "image": { "contentType": "image/png", "path": ".chipmate/docs/diagrams/ci-flow.png", "artifactPath": ".chipmate/docs/diagrams/ci-flow.png", "width": 1200, "height": 720 } }`.
6. For external links, internal section jumps, or figure/table cross-references, use section/table/figure `bookmark` plus `richParagraphs` runs with `hyperlink` or `reference` fields. When prose authoring is easier inside one text run, use cross-reference markers `{{ref:bookmark|visible text}}` and `{{pageref:bookmark|page text}}`; the Word builder converts them into live `REF` / `PAGEREF` fields and does not leave marker text in the document. Use descriptive visible link text; do not paste raw URLs as the only visible link text.
7. For long reports, specs, QA artifacts, or documents where headless rendering matters, set `layout.navigation.mode` to `static-toc`. The builder writes a static clickable TOC, Top/Bottom bookmarks, section bookmarks, and Back-to-TOC links without requiring Word field updates.
8. For true footnotes or endnotes, use `richParagraphs` runs with `note.kind` and `note.text`. Newlines in `note.text` become separate Word note paragraphs. Do not fake footnotes as footer text or bracketed prose.
9. For fillable forms or templates, use section `formFields` for real Word content controls. Use `kind: "plainText"` or omit `kind` for text fields, `kind: "checkbox"` with `checked`, `kind: "dropdown"` with `options`, and `kind: "date"` with `dateFormat`. If the document should open as a protected form, set `protection.mode` to `forms`; use `readOnly`, `comments`, or `trackedChanges` only when the user asks for that review mode.
10. Include assumptions, limitations, and missing inputs when the document depends on incomplete evidence.

After `create_word_document` returns, call `render_word_document` on the generated `.docx` path unless the user explicitly asked to skip visual QA. Then inspect the returned warnings and render-quality status, and make the final answer visibly include the generated `.docx` path. A strong render result includes `pageCount`, `pagePngPaths`, and `pageVisualSummaries` from DOCX -> PDF -> page PNG rendering; the visual summaries report page dimensions, ink ratio, content bounds, 3x3 region density, coarse ink-component bounding boxes, and edge-ink signals that help spot blank pages, clipping, or overflow. Treat a11y warnings such as missing image alt text, missing repeated table headers, skipped heading levels, non-descriptive link text, table overflow/prose-heavy table risks, blank rendered pages, and summary failures as items to fix or disclose. If the tool reports structural errors, do not claim the document is complete. If `visualQaStatus` is `skipped` because the remote render server is unconfigured, unavailable, returns an invalid response, or returned artifacts could not be saved, continue the Word delivery but explicitly disclose both the `.docx` path and that page-level visual QA was skipped.

For new documents, major rewrites, and layout-affecting edits, complete the Word visual QA checkpoint before finalizing. When page PNG images are attached, inspect the rendered pages before claiming the document visually passed. When the provider rejects image input or no page PNG is attached, use only render warnings and `pageVisualSummaries`, and explicitly avoid claiming page-image visual inspection. If the checkpoint finds material risks, continue through the generic Word path: inspect with `inspect_word_document`, apply locator-based fixes with `apply_word_document_edits`, and re-render. If the problem is a whole-document layout problem that locator edits cannot reasonably repair, regenerate with `create_word_document` and keep the final warnings/artifacts.

## Standalone Render / Visual QA Workflow

When the user asks to render, preview, visually inspect, check pagination/layout, export page PNGs, or verify whether a local `.docx` has clipping/overflow/blank-page risks, call `render_word_document` directly. It reads the source `.docx`; when the configured remote render server is available, it writes a render evidence bundle under `.chipmate/docs/rendered/...` and returns `pdfArtifactPath`, `pagePngPaths`, `pageVisualSummaries`, renderer metadata, and issues. It does not edit the source document.

Use the returned page summaries to explain visible risks. If `visualQaStatus` is `skipped`, say that remote visual QA was unavailable and page-image QA was skipped; do not retry indefinitely or claim the document visually passed. If render findings require a fix, inspect first with `inspect_word_document`, then use `apply_word_document_edits` with returned locators.

## Existing Document Edit Workflow

For existing `.docx` edits:

1. Call `inspect_word_document` first.
2. Build a `DocumentEditPlan` using only locators returned by inspection.
3. Call `apply_word_document_edits`; do not invent locators or overwrite the original file.
4. Prefer local edits over rewriting the entire document unless the user explicitly asks for a rewrite.
5. After an edit tool returns, review its `renderCheckResult`. If the render path was unavailable or warnings mention blank pages, edge ink, clipping, table overflow, or summary failures, disclose the risk or perform another locator-based edit when the fix is clear.
6. For inserted sections, `insertSection` may include `blocks` when the order matters. Use ordered blocks for paragraphs, rich paragraphs, true Word lists, PNG figures with captions/bookmarks, fixed-layout tables, callouts, brief card groups, evidence card groups, quote blocks, and code blocks; otherwise the legacy arrays remain available. Rich paragraph blocks may use bold/italic runs, external hyperlinks, internal anchor links, REF/PAGEREF fields, cross-reference markers such as `{{ref:bookmark|visible text}}` / `{{pageref:bookmark|page text}}`, and true footnote/endnote `note` runs.
7. For small paragraph-local changes, prefer `replaceText` with exact `oldText` and `newText`; use `replaceParagraph` only when the whole paragraph should be rewritten as plain text. Use `replaceParagraphWithRichParagraph` when the replacement paragraph needs bold/italic runs, external hyperlinks, internal anchor links, REF/PAGEREF fields, cross-reference markers, or true footnote/endnote `note` runs while preserving the inspected paragraph locator. Use `replaceParagraphWithBlocks` when one inspected paragraph should become multiple same-level structural blocks such as paragraphs, rich paragraphs, true Word lists, PNG figures with captions/bookmarks, fixed-layout tables, callouts, brief/evidence cards, quote blocks, or code blocks; do not fake those structures as paragraph text.
8. For paragraph comments, use the `addComment` operation with a locator returned by inspection. Comment text may include newlines when a multi-paragraph Word comment body is needed.
9. For redlines/tracked changes, use `replaceTextWithTrackedChange` for exact paragraph-local edits, including text that spans multiple Word runs, `replaceParagraphWithTrackedChange` when a whole paragraph should be rewritten as plain text, `replaceParagraphWithRichTrackedChange` when a whole-paragraph revision must preserve rich runs such as bold/italic, hyperlinks, REF/PAGEREF fields, or true footnote/endnote note runs, and `updateTableWithTrackedChange` when an inspected table cell's text should be replaced under revision mode. Use these only when the user explicitly asks for redlines, tracked changes, or revision-mode edits. The tool writes real Word `w:del`/`w:ins` revisions; do not output OOXML directly.
10. For heading hierarchy fixes, use `updateHeadingLevel` with a returned paragraph locator and level `1`, `2`, or `3`; do not edit styles XML manually.
11. For existing comments, use `inspection.comments` to summarize reviewer feedback, including `paraId`, `parentParaId`, `parentCommentId`, `durableId`, `resolvedSource`, and `commentsExtendedDone` when the document has Word `commentsExtended.xml` / `commentsIds.xml` metadata. Use `updateCommentText` with a returned comment locator when the user asks to revise an existing comment's body text, including multi-paragraph text separated by newlines, `setCommentResolved` with a returned comment locator to mark or reopen a comment, and `removeAllComments` with the returned `documentEndLocator` when the user asks for a clean final copy without comments.
12. For Word forms/templates, use `inspection.contentControls` to find plain-text, checkbox, dropdown, and date content controls, then use `fillContentControl` with a returned content-control locator when `fillSupported` is true. For checkbox controls, pass a clear boolean-like value such as `true`, `false`, `checked`, or `unchecked`; do not invent tags or fill controls that were not returned by inspection. Rich or nested SDTs are reported with `fillSupported: false` and `fillUnsupportedReason`; explain that boundary instead of trying to fill them.
13. For simple text watermarks, use `addTextWatermark` with the returned `documentEndLocator`; it writes the VML text watermark into all existing header parts, or creates `header1.xml` when no header part exists. To remove a watermark or background image, inspect first and use `removeWatermark` only with a returned watermark locator. Inspection/removal covers VML textpath watermarks, VML image-shape backgrounds, and DrawingML anchored image backgrounds in document/header/footer parts; the applied-operation detail reports touched parts. Relationship/media cleanup is intentionally conservative, so render/diff the result when visual fidelity matters.
14. For existing footnotes/endnotes, use `inspection.notes` to summarize or audit note text. To insert new footnotes/endnotes, use rich paragraph `note.kind` and `note.text` runs through `insertSection` or `replaceParagraphWithRichParagraph`; use newline-separated `note.text` when a multi-paragraph note body is needed. To update existing note body text, use `updateNoteText` with a note locator returned by inspection; newline-separated update text replaces the note body as multiple Word paragraphs. Do not edit `word/footnotes.xml` or `word/endnotes.xml` manually.
15. For existing Word lists/numbering, use `inspection.lists` and paragraph `list` metadata to summarize list kind, levels, item counts, and list membership. To replace list items while preserving real Word numbering, use `updateList` with a list locator returned by inspection.
16. For existing tables, use `inspection.tables` to summarize rows and table locators. Use `updateTable` only for cell text changes, `updateTableWithTrackedChange` for revision-mode table cell text replacement, `replaceTable` when the user asks to replace or rebuild the whole table with a new `TableSpec`, including real `colSpan`/`rowSpan` merged cells when the new layout needs them, and `updateTableHeaderRows` with a table locator when the user asks to set repeated/header rows or fix table-header accessibility warnings.
17. For existing hyperlinks, use `inspection.hyperlinks` to summarize visible text, URL/anchor target, tooltip, and locator. Use `updateHyperlinkText` when the user asks to make link text descriptive. Use `updateHyperlinkTarget` when the user asks to change the URL, internal anchor, or tooltip. Do not use one operation for the other's job.
18. For existing drawings/images, use `inspection.images` to summarize placement (`inline`/`floating`), relationship mode (`embedded`/`external`/`missing`), media target/path/content type, media existence, size, name, alt text, and `replaceSupported` / `replaceUnsupportedReason`. Use `updateImageAltText` for title/alt metadata-only fixes. Use `replaceImage` only when the inspected image reports `replaceSupported: true` and the replacement is a PNG-backed `FigureSpec`; external linked images, missing relationships, unresolved targets, and non-PNG media must be reported instead of forced through `replaceImage`.
19. For existing Figure/Table captions, use `inspection.captions` to summarize caption kind, visible label, cached number, `SEQ` instruction, bookmark, and current text. Use `updateCaptionText` with a returned caption locator when the user asks to revise caption text; do not rewrite the caption paragraph as plain text because that can destroy `SEQ` fields and bookmark anchors.
20. For existing sections/page setup, use `inspection.sections` to summarize page size, orientation, margins, section type, different-first-page settings, odd/even header settings, header/footer references, and header/footer Link-to-Previous risk. To change page size, orientation, or margins, use `updateSectionPageSetup` with a section locator returned by inspection; do not output OOXML directly.
21. For document protection/restrict-editing modes, use `inspection.protection` and summary `protectionMode` to report the current state. Use `setDocumentProtection` with a returned `documentProtection` locator or `documentEndLocator` to set `readOnly`, `comments`, `trackedChanges`, `forms`, or `off`. Do not claim password protection.
22. For existing Word fields, use `inspection.fields` to summarize field types, instructions, cached display text, and part locations. Use `audit_word_document_fields` before any field-heavy render workflow. Word-native `TOC`, `PAGE`, or `NUMPAGES` refresh is not available in this remote-render-only VSIX build; use static TOC/page text or update fields manually in Word. Use `flatten_word_ref_fields` only for deterministic render copies where cached `REF` / `PAGEREF` display text should become literal text. Use `materialize_word_seq_fields` only for deterministic render copies where live `SEQ` caption/table/figure fields should keep their field structure but have cached visible numbers recalculated.
23. For existing Word styles, use `inspection.styles` to summarize the style catalog and paragraph/run usage. Do not attempt arbitrary style edits; use `audit_word_document_styles`, `normalize_word_document_styles`, or `apply_word_template_styles` only for their documented workflows.
24. For clean copies from redlined documents, first inspect `summary.trackedChangeTypeCounts` and `summary.advancedTrackedChangeWarnings`. Use `acceptAllTrackedChanges` or `rejectAllTrackedChanges` with the returned `documentEndLocator` for insertion/deletion revisions and move revisions; moves are unwrapped as accepted/rejected content and move-pair metadata is not preserved. If the document contains formatting revisions such as `rPrChange`, `pPrChange`, `tblPrChange`, `trPrChange`, or `tcPrChange`, report the boundary instead of trying to accept/reject them, because the tool fails closed for those revisions. Do not simulate acceptance by rewriting paragraphs.
25. For external-sharing/privacy cleanup, use `scrubDocumentMetadata` with the returned `documentEndLocator`. This removes common package metadata and Word `rsid*` attributes; it does not redact visible document content.
26. For visible text redaction/anonymization, use `redactText` with the returned `documentEndLocator`. Prefer exact `items` for known values; use bounded `patterns` for common `email` and `phone` sweeps or carefully scoped custom regexes. Set `includeComments` only when comments should be redacted too. The tool reports redaction match counts without exposing sensitive values, but it still redacts Word text nodes and does not OCR images or guarantee matches split across multiple runs.
27. For low-level OOXML repairs not covered by native operations, use `patchOoxmlPart` only as a last resort with the returned `documentEndLocator`. The plan must name a safe XML package part, a short `reason`, and exact `oldText`/`anchor`/`closeTag` preconditions with `expectedOccurrences`. Do not use it for ordinary content edits, external relationships, macros, OLE, ActiveX, embedded binary objects, or image/media replacement.

## Compare / Diff Workflow

When the user asks to compare two local `.docx` files, call `compare_word_documents` with the baseline document as `beforePath` and the revised document as `afterPath`. The tool extracts comparable text, renders both documents to page PNGs when the configured remote render server is available, writes a `.chipmate/docs/diff` evidence bundle, and reports changed rendered pages with before/after PNGs, changed-ratio metrics, changed bounding boxes, 3x3 changed-region summaries, visual severity, and risk flags such as broad page change, localized change, dimension change, or possible reflow/antialias noise. Pixel-highlight diff PNGs are only available when the current runtime has a supported diff provider; otherwise use text diff plus page summaries and disclose the limitation. Use `pixelThreshold` only when the user wants stricter or looser pixel matching; raising it can ignore small antialias/render noise. Use the result to explain document changes; do not ask the model to infer page-level visual differences from raw OOXML.

## Merge / Append Workflow

When the user asks to append or merge two local `.docx` files, decide the base document and append document explicitly, then call `merge_word_documents`. The base document keeps its package structure, styles, relationships, headers, footers, and final section settings; the append document contributes body content. The tool refuses append drawings/images by default. Set `allowDrawings` only after warning the user that unsupported embedded objects remain out of scope; local image relationships and `word/media/*` parts from the append body are merged deterministically. Read `mergeAudit` and warnings: style and numbering conflicts use a base-wins strategy, append-only style/numbering references may render differently, hyperlink relationships are remapped, and unsupported embedded object relationships fail closed.

## Spreadsheet / Table Helper Workflow

When the user asks to include spreadsheet data in a Word document, call `extract_xlsx_table` for a simple `.xlsx` / `.xlsm` worksheet range, then place the returned `data.table` into the appropriate section of `create_word_document` or into an inspected edit plan with `replaceTable` / `insertSection`. The model still owns section placement, captions, surrounding prose, table splitting, and design preset choice.

`extract_xlsx_table` is a bounded helper: it reads rectangular table data, uses the first row as headers by default, returns a fixed-layout `TableSpec`, and warns when ranges are truncated or formulas lack cached results. It does not recalculate formulas, migrate spreadsheet styling, preserve merged-cell semantics, or create a DOCX directly.

When the user asks to export a Word table to CSV, inspect the `.docx` first if the table is not unambiguous, then call `export_word_table_to_csv` with the returned `tableIndex` or table locator. The CSV artifact is for data review/exchange; it does not preserve Word styling, captions, merged-cell semantics, or formulas.

## Style Lint / Normalize Workflow

When the user asks why formatting looks inconsistent, call `audit_word_document_styles`. It reports direct run formatting, direct paragraph spacing/indent overrides, font usage, and heading-like paragraphs not using Heading styles. When the user asks to make formatting consistent, call `normalize_word_document_styles` to create a new copy. Default normalization clears run-level direct formatting only; use `preserveRunFormatting` when the user wants intentional emphasis, highlighted terms, or brand coloring preserved while other direct formatting drift is removed. Use paragraph-format cleanup or heading-spacing enforcement only when the user’s intent supports the layout change. Always review render-quality warnings after normalization.

## Template / Style Pack Workflow

When the user asks to apply a Word template, DOTX, template DOCX, or style pack to an existing document, choose the target document and template explicitly, warn that pagination and styling may change, and call `apply_word_template_styles`. The tool preserves the target body and copies template `styles.xml`, `theme1.xml`, `fontTable.xml`, and `numbering.xml` when present. If the user asks to import only selected template styles, pass `styleAllowlist` with the requested style ids; the tool imports those styles plus basedOn/next/link dependencies and reports the result in `templateAudit`. Use `templateAudit` to explain style/numbering conflicts, copied template media relationships, skipped relationship parts, and fail-closed unsupported relationships. Use `audit_word_document_styles` first when the target has heavy direct formatting; direct formatting can override imported styles. Do not use template style application for content merging, arbitrary template body transfer, or arbitrary OOXML patches.

## Fields / Cross-Reference Workflow

When authoring new prose with cross-references, prefer explicit rich paragraph `reference` runs. If the surrounding prose is simpler as one text run, write `{{ref:bookmark|visible text}}` for a live REF field or `{{pageref:bookmark|page text}}` for a live PAGEREF field. The builder replaces those markers with Word field begin/instruction/separate/end runs, using the marker display text as the cached value.

When TOC entries, page numbers, captions, or cross-references look stale, call `audit_word_document_fields` before guessing. It reports field types such as `TOC`, `PAGE`, `NUMPAGES`, `SEQ`, `REF`, and `PAGEREF`, with examples and stale-field hints. Word-native `TOC`, `PAGE`, or `NUMPAGES` refresh is not implemented in the remote render service and the VSIX client does not run local LibreOffice/soffice; use static TOC/page text, disclose the limitation, or update fields manually in Word. If deterministic headless screenshots are more important than keeping cross-reference fields live, call `flatten_word_ref_fields` to create a new copy where complex `REF` / `PAGEREF` fields with cached visible text are replaced by literal text. If caption/table/figure numbers are stale but the `SEQ` fields should remain live, call `materialize_word_seq_fields` to create a new copy that recalculates cached `SEQ` visible numbers while preserving the field begin/instruction/separate/end structure.

## Fixture / Regression Workflow

For development or parity regression work, use `bun run fixtures:docx -- --out <dir>` to generate local DOCX fixtures plus `manifest.json`. The generated set currently covers VML watermarks across header/footer story parts, minimal tracked-change markup, and caption/cross-reference fields. These fixtures are for tests and diagnostics; do not present them as user deliverables.

## Quality Rules

- Preserve user intent over a fixed template. A one-page memo, checklist, proposal, form, and engineering report should not all look like the same report.
- Use real Word structure: Heading styles, true multi-level list numbering, fixed-layout tables with DXA widths, real merged cells when needed, and image relationships.
- Keep tables for comparable row/column data. If the structural gate reports `table-overflow-risk`, reduce columns, split the table, adjust `columnWidthRatios`, use real `colSpan`/`rowSpan` only for structural grouping, or move prose-heavy content into paragraphs, bullets, callouts, or definition/source lists.
- Audit style drift before broad cleanup; when intentional manual emphasis should survive cleanup, pass `preserveRunFormatting` such as `["bold", "italic", "underline", "color"]` instead of doing an all-or-nothing cleanup.
- Apply template/style packs only when the user requested template inheritance or when a skill workflow clearly needs it; disclose that page count and table wrapping can change after style import.
- Provide meaningful alt text for figures, repeated header rows for tables, non-skipping heading levels, and descriptive link text.
- Use real Word hyperlink relationships for external URLs, `w:anchor` hyperlinks for internal jumps, and REF/PAGEREF fields for cross-references. Cross-reference markers are allowed only as an authoring shorthand inside rich paragraph text; the final DOCX must contain Word fields, not marker literals. Tables that need cross-references should have stable `bookmark` values and Word Caption paragraphs, not plain muted captions.
- Existing headings are ordinary paragraphs with Heading styles in `inspection.paragraphs`. Use `updateHeadingLevel` for skipped-heading accessibility fixes; it changes the paragraph style only.
- Use `layout.navigation.mode = "static-toc"` when a deterministic clickable TOC is better than a Word-native TOC field that needs manual update.
- Audit field-heavy documents before final render. Flatten cached REF/PAGEREF only for deterministic render copies, and disclose that live cross-reference semantics are removed in that copy. Materialize cached SEQ caption/table/figure numbers before render when those numbers are stale, and disclose that the output is a render-stabilized copy that still preserves live `SEQ` fields.
- Existing comments can be inspected and reported through `inspection.comments`, including thread metadata from `commentsExtended.xml` / `commentsIds.xml` when present. `setCommentResolved` updates both legacy `comments.xml` state and existing `commentsExtended.xml` state; `removeAllComments` removes comments, commentsExtended, and commentsIds package parts/relationships/content types for clean copies. Use `updateCommentText` for controlled comment body edits, including multi-paragraph comment text, `setCommentResolved` for completion state, and `removeAllComments` for clean copies; do not edit comment OOXML manually.
- Use true Word footnote/endnote parts for notes; footnotes/endnotes are not footer paragraphs. New notes can be inserted through rich paragraph `note` runs, and existing notes can be inspected through `inspection.notes`; use newline-separated note text for multi-paragraph note bodies and `updateNoteText` for controlled note body text updates while preserving the note reference. Rich formatting inside the note body is not a v1 path; keep note body text plain unless the tool schema adds explicit rich note runs.
- Existing tables can be inspected and reported through `inspection.tables`, including rows and table locators. Use `updateTable` for cell text changes, `updateTableWithTrackedChange` for controlled table cell text redlines, `replaceTable` for whole-table replacement, and `updateTableHeaderRows` for repeated/header-row accessibility fixes.
- Existing hyperlinks can be inspected and reported through `inspection.hyperlinks`, including visible text, URL/anchor target, tooltip, and locator. Use `updateHyperlinkText` for descriptive-link-text accessibility fixes, and `updateHyperlinkTarget` for URL, internal anchor, or tooltip changes.
- Existing lists/numbering can be inspected and reported through `inspection.lists`, including list kind, levels, item count, item text, and paragraph list membership. Use `updateList` for whole-list item replacement/reorganization; use paragraph-local operations only for small text edits inside one list item.
- Existing drawings/images can be inspected and reported through `inspection.images`, including inline/floating placement, embedded/external relationship mode, relationship target, media path, content type, media existence, size, name, alt text, and replace support. Use `updateImageAltText` for controlled image title/alt metadata fixes. Use `replaceImage` only for inspected local PNG images where `replaceSupported` is true; for external links, missing relationships, unresolved targets, or non-PNG media, explain the `replaceUnsupportedReason` and avoid inventing an unsupported replacement operation.
- Existing Figure/Table captions can be inspected and reported through `inspection.captions`, including caption kind, visible label, cached number, `SEQ` instruction, bookmark, and current text. Use `updateCaptionText` for controlled caption body edits while preserving `SEQ` fields and bookmark anchors.
- Existing section/page setup can be inspected and reported through `inspection.sections`, including page size, orientation, margins, section type, different-first-page settings, odd/even header settings, header/footer references, and Link-to-Previous indicators. Use `updateSectionPageSetup` for controlled changes to page size, orientation, or margins; use it only with a returned section locator.
- Existing document protection can be inspected and reported through `inspection.protection` and summary `protectionMode`. Use `setDocumentProtection` for controlled restrict-editing modes (`readOnly`, `comments`, `trackedChanges`, `forms`) or `off`; do not claim password protection.
- Existing Word fields can be inspected and reported through `inspection.fields`, including field type, instruction, cached display text, and part location. Word-native `TOC`/`PAGE`/`NUMPAGES` refresh is not available in this VSIX build; `REF`/`PAGEREF` flattening and `SEQ` cached-number materialization remain separate deterministic workflows.
- Existing Word styles can be inspected and reported through `inspection.styles`, including style id, type, name, basedOn, default flag, and paragraph/run usage counts. Arbitrary style editing is not implemented; use the dedicated audit, normalize, or template style workflows. Template application can selectively import style ids with `styleAllowlist`, but it still preserves the target body and does not import arbitrary template content.
- Use real SDT content controls for fillable fields and Word `documentProtection` settings for protected forms/review copies. Plain-text, checkbox, dropdown, and date SDTs can be generated, inspected, and filled through returned locators when `fillSupported` is true. Rich or nested SDTs are inspection/report-only in v1+ and fail closed for fill operations; do not claim password protection or arbitrary rich/nested form editing.
- Use simple VML text watermarks only when adding new watermarks. Adding a text watermark applies to all existing header parts so multi-section documents are covered. Existing VML textpath watermarks, VML image-shape backgrounds, and DrawingML anchored image backgrounds in document/header/footer parts can be inspected and removed through returned locators with part-level audit detail. Disclose that removal deletes the referenced drawing/VML XML conservatively and may leave unused media relationships for package safety.
- Keep final answers focused on the delivered `.docx` path and any important warnings. Mention visual QA findings when page summaries indicate blank pages, clipping/edge ink, suspicious region density, near-edge ink components, or render-summary failures. Do not expose internal render artifacts unless the user asks for them.
