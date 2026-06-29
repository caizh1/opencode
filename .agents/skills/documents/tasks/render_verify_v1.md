# Remote Word v1 Render and Verification

Use this task file after every generated or edited local `.docx`.

## Render Gate

1. Prefer the built-in render-quality result returned by `create_word_document`, `apply_word_document_edits`, `compare_word_documents`, `merge_word_documents`, `normalize_word_document_styles`, or `apply_word_template_styles`.
2. A strong render result has:
   - page count.
   - page PNG artifact paths.
   - page visual summaries with dimensions, ink ratio, content bounds, and edge-ink signals.
3. Treat structural errors as blocking. Do not claim the document is complete when the tool reports package relationship errors, content-type errors, invalid table geometry, or other structural failures.
4. Treat warnings as fix-or-disclose:
   - missing alt text.
   - skipped heading levels.
   - missing repeated table headers.
   - table overflow or prose-heavy table risk.
   - blank page or suspiciously low ink ratio.
   - content near page edges.
   - render summary failures.

## When Rendering Is Unavailable

If the configured remote Word render server is unconfigured, unreachable, times out, returns an invalid response, or returns artifacts that cannot be saved locally:

1. Continue only if the DOCX structural build/edit succeeded.
2. Say clearly that the document was structurally generated or edited, but page-level visual QA was skipped.
3. Do not say the document passed visual QA.
4. Prefer conservative Word structures: standard headings, moderate table widths, simple images, static TOC, and fewer layout-heavy constructs.
5. Do not retry indefinitely. Treat `visualQaStatus: "skipped"` as a disclosed limitation unless the user explicitly asks to troubleshoot the render server.

## Field Refresh Limits

The offline workflow can audit Word fields, materialize some cached values, and refresh Word-native layout fields when local LibreOffice is available:

- `refresh_word_native_fields` refreshes Word-native `TOC`, `PAGE`, and `NUMPAGES` into a new DOCX copy and render-verifies the result.
- `flatten_word_ref_fields` creates a deterministic render copy by replacing cached `REF` / `PAGEREF` display text with literal text.
- `materialize_word_seq_fields` recalculates cached `SEQ` caption/table/figure numbers while preserving live `SEQ` fields.

Disclose dependency limits when local LibreOffice field refresh or remote visual rendering is unavailable, and keep static TOC outputs clearly separate from Word-native refreshed fields.
