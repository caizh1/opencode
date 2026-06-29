# Remote Word v1 Render Troubleshooting

Use this task file when DOCX render QA is unavailable, incomplete, or produces suspicious results in the offline ChipMate environment.

## Remote Server Checks

The `render_word_document` page-image QA path depends on the configured remote Word render server. Check and report the exact connection or response problem rather than saying visual QA passed.

Common checks:

```bash
curl -fsS "$CHIPMATE_WORD_RENDER_REMOTE_ENDPOINT/health"
curl -fsS "<configured-render-base-url>/health"
```

If the tool reports `remote-word-render-unconfigured`, `remote-word-render-unavailable`, `remote-word-render-invalid-response`, or `remote-word-render-artifact-persist-failed`, say that the DOCX was structurally generated or edited, but page-image visual QA was skipped.

## Server-Side LibreOffice / Poppler Issues

The render server owns LibreOffice and Poppler. If the server is reachable but render output is missing or invalid, check the server container logs and health response rather than asking the local VSIX host to install office tools.

```bash
docker logs chipmate-word-render --tail=200
docker exec chipmate-word-render sh -lc 'command -v soffice && command -v pdftoppm && soffice --version && pdftoppm -v'
```

## Response / Artifact Issues

If the server responds but ChipMate reports skipped visual QA:

- `remote-invalid-response`: the server response did not contain valid PDF/page PNG payloads.
- `artifact-persist-failed`: the server returned payloads, but ChipMate could not save them under `.chipmate/docs/rendered/...`.
- disclose that text/structure checks passed but page PNG visual QA is incomplete.

## Suspicious Render Results

Investigate before delivery when visual summaries show:

- zero pages or missing page PNGs.
- blank or near-blank pages.
- very high edge ink.
- content bounds touching page edges.
- tables with overflow warnings.
- missing image alt text or table header warnings.

Fix the DOCX when possible; otherwise disclose the residual warning.

## Final Response Rule

Do not expose internal render artifacts unless the user asks. The final response should link the `.docx`, mention critical warnings, and state whether render QA was completed, unavailable, or partially completed.
