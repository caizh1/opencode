# 08 Mermaid PNG Rendering Rules

## 1. ChipMate render route

Mermaid `.mmd` is the editable diagram source. High-DPI white-background PNG is the Word figure artifact. Do not use local `mmdc`, local Chrome, SVG-only output, or ASCII diagrams as the completion route.

Use `chipmate_render_mermaid_diagram` for every Mermaid diagram that must become a persisted artifact or Word figure. Use `scale: 3` for normal Word figures and `scale: 4` only for unusually dense diagrams after simplifying or splitting the graph. Keep the returned `width` / `height` as the Word display size and keep `pixelWidth` / `pixelHeight` only as high-DPI diagnostics.

## 2. Artifact indexing

The render tool writes `.mmd` and `.png` artifacts under ChipMate's artifact location, normally `.chipmate/docs/diagrams/`. Do not assume the tool writes directly into this skill's requested `04-diagrams/` tree. When the work package requires `04-diagrams/mmd/...` and `04-diagrams/png/...`, create or update `04-diagrams/diagram-index.md` and the coverage CSVs to map the requested logical diagram path to the tool-returned artifact path.

## 3. Diagram syntax

Business flow diagrams default to `flowchart TD`; state overview diagrams use `stateDiagram-v2` when appropriate. Node ids must use ASCII letters, digits, and underscores. Node labels may use Chinese business language. Edge labels must be readable business conditions and should quote punctuation-heavy labels. Exact C conditions belong in evidence tables, not overloaded node labels.

## 4. Word insertion

Word figures must use the returned PNG path in `FigureSpec.image.path` / `artifactPath`. Raw Mermaid source must not be used as the Word figure body unless the user explicitly asks for Mermaid source as a code block instead of a rendered diagram. If remote rendering fails, omit the figure or mark the work package INCOMPLETE; do not substitute Mermaid syntax as if the figure existed.

## 5. Quality checks

Every required diagram must have a Mermaid source artifact, a PNG artifact, and an edge coverage row. If render metadata reports warnings, record them in `quality-gate-report.md` and decide whether the diagram is PASS, INCOMPLETE, or must be split.
