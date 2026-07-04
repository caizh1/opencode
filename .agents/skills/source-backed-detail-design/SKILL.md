---
name: source-backed-detail-design
description: 源码驱动增强版详细设计生成。基于旧详细设计文档和当前源码，分 work package 生成源码证据、控制流证据、业务抽象证据、业务图、代码图、状态机图、增强版详细设计、差异报告和 Word 文档。
allowed-tools:
  - read_docx
  - chipmate_search_code
  - chipmate_search_text
  - chipmate_read
  - chipmate_read_evidence
  - chipmate_graph_map_module
  - chipmate_graph_inspect_symbol
  - chipmate_graph_callers
  - chipmate_graph_callees
  - chipmate_graph_trace_call_chain
  - chipmate_graph_function_cfg
  - chipmate_graph_expand_flow_slice
  - chipmate_graph_find_state_machines
  - chipmate_graph_trace_state_path
  - chipmate_graph_state_flow_detail
  - chipmate_read_skill_resource
  - chipmate_run_command
  - chipmate_run_skill_script
  - chipmate_create_directory
  - chipmate_create_file
  - chipmate_edit_file
  - chipmate_render_mermaid_diagram
  - create_word_document
  - render_word_document
metadata:
  keywords:
    - 源码驱动详细设计
    - 增强版详细设计
    - 旧详设
    - 基于旧详设
    - 基于源码生成详设
    - 源码证据详设
    - source backed detail design
    - source-backed detail design
    - enhanced detail design
---

# Source-backed Detail Design Workflow

Use this skill when the user asks to regenerate or enhance a detailed design document from an existing design document and the current source code. This is a ChipMate generic-agent skill, not a product-side runtime pipeline. The model owns scope discovery, evidence collection, work-package sequencing, document design, diagram semantics, and WordDocSpec authoring. ChipMate tools execute evidence retrieval, artifact writes, Mermaid PNG rendering, Word generation, and Word render QA.

## Required Resource Loading

Before each work package, read the listed references with `chipmate_read_skill_resource`. Record the resource path, line count or byte count if available, and a verified/unavailable status in the work package notes. Do not call `chipmate_read_skill_resource` for `SKILL.md` itself.

| Work package | Required references |
|---|---|
| input-and-scope | `references/01-core-principles.md`, `references/02-input-and-module-scope-rules.md`, `references/14-continuation-checkpoint-protocol.md` |
| source-evidence | `references/03-source-exploration-rules.md` |
| control-flow-evidence | `references/04-control-flow-evidence-schema.md`, `references/05-submodule-business-flow-rules.md`, `references/06-state-machine-extraction-rules.md` |
| business-flow-abstraction-and-diagrams | `references/15-business-flow-abstraction-rules.md`, `references/07-diagram-planning-and-splitting-rules.md`, `references/08-mermaid-png-rendering-rules.md` |
| code-level-submodule-diagrams | `references/05-submodule-business-flow-rules.md`, `references/07-diagram-planning-and-splitting-rules.md`, `references/08-mermaid-png-rendering-rules.md` |
| state-machine-diagrams | `references/06-state-machine-extraction-rules.md`, `references/08-mermaid-png-rendering-rules.md` |
| parent-module-diagram | `references/09-parent-module-assembly-rules.md` |
| enhanced-detail-design | `references/10-detail-design-output-templates.md` |
| diff-and-feature-report | `references/11-feature-diff-completeness-rules.md` |
| quality-and-word-export | `references/12-word-export-rules.md`, `references/13-quality-gates-and-validator.md` |

## Work Package Order

Run work packages in this order unless resuming from a saved state:

1. input-and-scope
2. source-evidence
3. control-flow-evidence
4. business-flow-abstraction-and-diagrams
5. code-level-submodule-diagrams
6. state-machine-diagrams
7. parent-module-diagram
8. enhanced-detail-design
9. diff-and-feature-report
10. quality-and-word-export

Do not skip ahead to final Word output when required evidence or diagrams are still missing. If the current turn cannot finish the current package, mark it INCOMPLETE, update `resume-state.md`, `continue-prompt.md`, and `quality-gate-report.md`, and state the next first step.

## ChipMate Tool Contract

- Use CodeGraph/RAG/search/read tools for source evidence. Start from the user prompt and old-design clues; do not default to an unbounded whole-repository scan.
- Use `chipmate_create_directory`, `chipmate_create_file`, and `chipmate_edit_file` only for the explicit output artifacts required by the active work package.
- Use `chipmate_render_mermaid_diagram` for Mermaid artifacts. For Word figures, pass `scale: 3`; for dense diagrams, split first and use `scale: 4` only when needed. Keep the returned PNG path and CSS `width`/`height` for `FigureSpec`.
- Use `create_word_document` for the final Word document. Pass `spec` as a JSON object, never as `JSON.stringify(spec)`, quoted JSON, Markdown, or prose.
- After Word creation, call `render_word_document` unless the user explicitly asks to skip visual QA. If remote render is skipped or unavailable, disclose that page-level visual QA was skipped.
- Do not restore or assume a dedicated detailed-design runtime pipeline. This skill is an operation manual for the generic ChipMate QA/DirectAgent flow.

## Output Root

Use an output root named `<module-name>_source_backed_detail_design/` under a workspace-safe location chosen from the user request or, by default, under `.chipmate/docs/`. Keep all generated CSV/MD status artifacts there. Mermaid render tool artifacts may live under ChipMate's diagram artifact directory; record their logical-to-actual path mapping in `04-diagrams/diagram-index.md` and coverage tables.

## Quality Gate Helper

When quality validation is needed, read `scripts/manifest.json` and use `chipmate_run_skill_script` with helper `validate_artifacts` when available. If the helper cannot run, perform the same checks manually from `references/13-quality-gates-and-validator.md` and write `validator not executed` in `quality-gate-report.md`.

## Final Word Rule

Final delivery is not complete until `create_word_document` returns a real `.docx` path. `08-word-export-input.md`, Mermaid source, Markdown chapters, or inline prose are intermediate artifacts only. Mermaid diagrams in Word must be PNG figures unless the user explicitly requests Mermaid source as a code block.
