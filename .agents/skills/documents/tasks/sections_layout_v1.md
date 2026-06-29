# Local Word v1 Section and Page Layout

Use this task file when an existing `.docx` has mixed portrait/landscape pages, unexpected margins, missing headers/footers, or section-break related layout changes.

## Audit First

1. Call `inspect_word_document` before planning section edits.
2. Read `inspection.sections` for each section:
   - `type` for the section break/start type such as `nextPage` or `continuous`.
   - `page.widthTwips`, `page.heightTwips`, `page.orientation`, and `page.margins`.
   - `differentFirstPage` and `oddEvenHeaders`.
   - `headers`, `footers`, and `headerFooterLinks`.
3. Treat `headerFooterLinks[*].linkedToPrevious === true` as a Link-to-Previous warning. The section inherits that missing header/footer slot from the previous section, so changing one section can affect later pages visually.

## Safe Edits

- Use `updateSectionPageSetup` only with a section locator returned by inspection.
- Use it for page size, orientation, explicit twips, and margins.
- Do not invent section locators and do not patch `sectPr` manually.
- After any section edit, run the normal render-quality gate and verify that landscape pages, margins, and headers/footers still appear where expected.

## v1 Limits

- v1 can inspect and report header/footer linkage, different-first-page, and odd/even header settings.
- v1 does not expose arbitrary header/footer body editing or Link-to-Previous toggling as a direct edit operation yet.
- If the user asks to change header/footer content or linkage, explain the current limit and offer the safe page setup edits that are supported.
