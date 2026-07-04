# 12 Word Export Rules

## 1. ChipMate Word route

The final Word document must be generated with ChipMate's generic Word tool: `create_word_document`. Do not use a task-specific Word pipeline, local pandoc, local LibreOffice/soffice export, or a standalone node-docx script as the primary or fallback route. `08-word-export-input.md` is an auditable assembly draft, not the final export mechanism.

## 2. WordDocSpec requirements

Before calling `create_word_document`, build a complete object-shaped `WordDocSpec` with `metadata`, `sources`, and `sections`. Never pass `JSON.stringify(spec)`, quoted JSON, Markdown, or prose as `spec`. Use assumptions, limitations, gaps, and owner-review items for incomplete evidence rather than continuing unbounded search.

Sections should preserve the enhanced design structure: overview, business flow overview, architecture/dependencies, core data structures, interface design, main flow, state machine and exceptions, submodule business flows, code-level submodule flows, resources/performance, build/integration, source evidence appendix, diff report, and quality gates.

## 3. Figures and diagrams

Insert Mermaid diagrams as PNG-backed `FigureSpec` objects in the section that explains them. Copy the complete figure shape returned by `chipmate_render_mermaid_diagram`: title, caption, alt text, image content type, artifact path, width, and height. Keep `.mmd` paths in diagram indexes and evidence ledgers for traceability.

If the user explicitly asks for Mermaid source in Word, represent it as a `codeBlocks[]` entry with `language: mermaid`; otherwise rendered diagrams must be PNG figures.

## 4. Render verification

After `create_word_document` succeeds, call `render_word_document` unless the user explicitly asks to skip visual QA. If remote render is unconfigured or unavailable, continue the Word delivery but disclose that page-level visual QA was skipped. If render returns page PNGs or visual summaries with material risks, fix through the generic Word tools or mark the relevant work package INCOMPLETE.

## 5. Success criteria

Word export PASS requires a non-empty `.docx` path returned by `create_word_document`, the final answer visibly reporting that path, required PNG figures inserted or explicitly disclosed as unavailable, and `quality-gate-report.md` recording render QA status. A Markdown draft, Mermaid source, or `08-word-export-input.md` alone is not a completed Word deliverable.
