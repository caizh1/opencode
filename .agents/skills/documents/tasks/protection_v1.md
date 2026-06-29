# Word Protection / Restrict Editing v1

Use this when the user asks for a local `.docx` to open as read-only, comments-only, tracked-changes-only, or forms-only, or asks to remove that restriction.

## Supported modes

- `readOnly`
- `comments`
- `trackedChanges`
- `forms`
- `off`

Password protection is not supported in v1. Do not imply that this prevents determined edits in all viewers; it writes Word's non-password `documentProtection` setting.

## New documents

When creating a new document, set `WordDocSpec.protection.mode` only when the user asks for a protected review/template flow:

- `readOnly` for casual edit prevention.
- `comments` when reviewers should comment instead of editing.
- `trackedChanges` when reviewers should edit under revision mode.
- `forms` for fillable Word content-control templates.

## Existing documents

1. Call `inspect_word_document`.
2. Report `inspection.summary.protectionMode` and `inspection.protection` when present.
3. Use `apply_word_document_edits` with `setDocumentProtection`.
4. Use a returned `documentProtection` locator when protection already exists; otherwise use `documentEndLocator`.
5. Set `mode` to one of the supported modes above.

Examples:

```json
{ "type": "setDocumentProtection", "locator": { "...": "from inspection" }, "mode": "comments" }
```

```json
{ "type": "setDocumentProtection", "locator": { "...": "from inspection" }, "mode": "off" }
```

## Verification

- Inspect the output again and confirm `summary.protectionMode`.
- Check warnings/render status. Protection should not alter layout, but render when visual fidelity matters.
- For `off`, confirm no `documentProtection` remains in `word/settings.xml`.
