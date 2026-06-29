# Local Word v1 Create/Edit Workflow

Use this task file when creating a new local `.docx`, doing a major rewrite, or editing an existing `.docx` in the offline ChipMate environment.

## New Document v1

1. Decide the document archetype from the user request: report, brief, proposal, SOP, checklist, review memo, form, or design draft.
2. Choose a `layout.preset` before drafting:
   - `standard_business_brief` for most reports, memos, and engineering summaries.
   - `compact_reference_guide` for dense checklists, operator guides, and reference material.
   - `narrative_proposal` for longer persuasive or proposal-style documents.
   - `google_docs_default` only for compatibility with simple Word/Docs-like styling; do not use Google Drive import in this offline workflow.
3. Build a complete `WordDocSpec` with real Word structures:
   - headings through section levels, not fake bold paragraphs.
   - `lists` for bullets, numbered steps, and checklists.
   - fixed-layout `tables` for comparable row/column data.
   - `figures` for PNG-backed images or rendered diagrams, with title, caption, alt text, and optional bookmark.
   - `richParagraphs` for hyperlinks, cross-reference fields, bold/italic runs, and note references.
   - `layout.navigation.mode = "static-toc"` for long reports or docs that need deterministic local navigation.
4. Prefer prose, lists, callouts, brief cards, definition lists, or evidence cards over tables when the content is paragraph-heavy.
5. Include assumptions, missing inputs, and limitations when the source material is incomplete.
6. Call `create_word_document` only after the model has chosen the content structure, section order, design preset, figures/tables/lists, navigation intent, and warnings.

## Existing Document v1

1. Always call `inspect_word_document` first.
2. Build a `DocumentEditPlan` only with locators returned by inspection.
3. Prefer local edits:
   - `replaceText` for small paragraph-local changes.
   - `replaceParagraph` or `replaceParagraphWithRichParagraph` for one-paragraph replacements.
   - `replaceParagraphWithBlocks` when one paragraph should become ordered structures such as lists, figures, tables, cards, quotes, or code blocks.
   - `insertSection.blocks` when inserted content order matters.
4. Use specialized operations rather than raw OOXML:
   - `updateHeadingLevel` for skipped heading levels.
   - `replaceTable`, `updateTable`, `updateTableHeaderRows`, or `updateTableWithTrackedChange` for tables.
   - `updateList` for real Word list groups.
   - `updateImageAltText` or `replaceImage` for existing images.
   - `updateCaptionText` for Figure/Table captions.
   - `updateHyperlinkText` or `updateHyperlinkTarget` for links.
   - `updateNoteText` for footnotes/endnotes.
   - `fillContentControl` for plain text, checkbox, dropdown, or date fields.
5. For redlines, use the tracked-change operations only when the user asks for tracked changes, redlines, or revision-mode edits.
6. For final clean copies, use `removeAllComments`, `acceptAllTrackedChanges`, `rejectAllTrackedChanges`, and `scrubDocumentMetadata` with the returned `documentEndLocator`.

## v1 Final Response

- Link or name the final `.docx` artifact.
- Mention important warnings: visual render unavailable, field refresh limitations, table overflow risk, missing alt text, stale PAGE/NUMPAGES/TOC fields, or unsupported embedded objects.
- Do not expose raw OOXML, large internal JSON, full `WordDocSpec`, page PNG bundles, or diff artifacts unless the user asks.
