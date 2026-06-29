# Local Word v1 Limits and Backlog

This skill targets a usable offline local Word v1 first. Do not block delivery on the advanced backlog below, and do not claim unsupported edge cases are complete.

## In v1

- New local `.docx` creation from a complete `WordDocSpec`.
- Existing `.docx` inspect-first controlled editing.
- Real headings, paragraphs, rich paragraphs, lists, fixed tables, merged cells, PNG figures, captions, bookmarks, static TOC/navigation, hyperlinks, basic cross-reference fields, footnotes/endnotes, comments, basic tracked changes, tracked change type inspection, cross-run text redlines, move revision accept/reject, formatting revision fail-closed warnings, plain-text/checkbox/dropdown/date content controls, rich/nested content control inspection with fail-closed fill boundaries, non-password document protection/restrict-editing modes, simple VML text watermarks, DrawingML/VML image background inspection and conservative removal, style audit/normalization, template style application with selective style allowlist, template style/numbering conflict audit, copied template-part image relationship/media handling, field audit/materialization helpers, compare/diff, basic merge, merge audit for style/numbering conflicts and unsupported embedded objects, XLSX simple table extraction to `TableSpec`, Word table CSV export, metadata scrub, exact text redaction, controlled XML OOXML repair through `patchOoxmlPart`, read-only helper script catalog distribution through `scripts/manifest.json`, and safe skill script execution boundary for manifest-opt-in active skill helpers.
- Render-quality status and page PNG artifacts when local render dependencies are available.

## v1 Backlog

- Object-level visual diagnostics and sophisticated reflow explanations.
- Floating images, external image relationships, and arbitrary DrawingML editing beyond background inspection/removal.
- Full formatting revision accept/reject semantics and complex structural table revisions beyond fail-closed reporting.
- Rich comment-thread metadata beyond basic resolved state.
- Full rich or nested content control content editing beyond inspection/reporting and fail-closed fill validation.
- Password-based document protection.
- Multi-paragraph rich footnote/endnote editing beyond plain text body updates.
- Arbitrary template body/content import and arbitrary style conflict resolution beyond templateAudit reporting and selected style-id import.
- Arbitrary deep multi-document object cloning beyond hyperlink/image relationship remapping and unsupported-object fail-closed reporting.
- Direct helper script execution outside the W43 active-skill + manifest allowlist + command-permission boundary remains prohibited.
- Arbitrary freeform OOXML/binary package mutation outside `patchOoxmlPart` XML allowlists remains prohibited.

## Out of Scope for Current Offline Goal

- Google Drive import.
- Native Google Docs output.
- Online rendering services.
