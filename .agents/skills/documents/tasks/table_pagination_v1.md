# Local Word v1 Table Pagination

Use this task file when a generated or edited `.docx` contains long, wide, or multi-page tables.

## Default Table Contract

- Use tables only for comparable row/column data.
- Provide short, clear headers for every table.
- Keep `repeatHeader` enabled unless there is a specific reason not to repeat the first row.
- Provide `columnWidthRatios` whenever column content has uneven width needs.
- Use `columnAlignments` deliberately:
  - `center` for IDs, status, dates, scores, owners, and short values.
  - `left` for requirement text, descriptions, notes, and other narrative cells.
- Do not use fixed row heights. Let Word rows grow with wrapped content.
- Do not pack long prose into table cells. Move paragraph-heavy content into prose, bullets, callouts, or appendix sections.

## Long Table Strategy

For tables that may span pages:

1. Keep the header row short and repeatable.
2. Use fixed table geometry with DXA widths; avoid auto-fit behavior.
3. Keep columns to six or fewer when possible.
4. Split very wide tables by topic, phase, owner, or artifact when the table would become unreadable.
5. For very long but narrow tables, keep one table with repeated headers instead of manually copying header rows into the body.
6. Use captions and bookmarks when the table needs to be referenced from prose.

## Repair When Render QA Warns

If the render or structural gate reports `table-overflow-risk`:

- reduce column count.
- rebalance `columnWidthRatios`.
- split a wide table into multiple narrower tables.
- convert prose-heavy columns into bullets or paragraphs.
- abbreviate short-value column labels.
- keep repeated headers; do not remove `tblHeader` to silence warnings.

If the gate reports `a11y-missing-table-header`:

- for new documents, ensure the table has `headers` and does not set `repeatHeader: false`.
- for existing documents, inspect first and use `updateTableHeaderRows` with the returned table locator.

## v1 Limit

v1 verifies the Word structures needed for cross-page behavior: repeated header rows, fixed layout, table grids, cell widths, and auto-expanding rows. It does not perform object-level visual table bbox diagnostics; those remain v1+.
