---
name: chip-design-doc
description: Generate chip-level module detailed design documents from local CodeGraph/RAG evidence, including current design, function coverage, business/code flows, state-machine transition tables, and diagram planning.
allowed-tools:
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
  - chipmate_ask_user_clarification
  - chipmate_render_mermaid_diagram
  - create_word_document
  - render_word_document
metadata:
  keywords:
    - 详细设计文档
    - 模块详细设计
    - 芯片级详细设计
    - 模块级详细设计
    - 状态机切换
    - 代码流程
    - 业务流程
    - 流水线*详细设计
    - 机制*详细设计
    - pipeline*design
---

# Chip Design Doc Workflow

Use this skill when the user asks for a chip-level or module-level detailed design document for a submodule, subsystem, feature, mechanism, pipeline, or implementation area in the current repository.

This skill is instructions for the generic ChipMate QA/agent flow. Do not use or assume a product-side detailed-design runtime pipeline. The model owns target discovery, evidence collection, document structure, diagram semantics, and WordDocSpec authoring; ChipMate tools only execute evidence retrieval, Mermaid rendering, Word generation, and Word render QA.

## Scope Rule

- Never default to the whole repository. If the user provides a natural-language subsystem or mechanism name, first locate likely modules with CodeGraph/RAG/search tools, then proceed with the best supported scope. Ask for clarification only when target discovery produces no credible candidate or multiple equally credible candidates.
- Treat the document as a description of the existing implementation, not a proposal for a new architecture.
- If evidence is missing or low-confidence, record the gap instead of inventing module behavior.

## Required Content

The generated document should cover:

- Module scope, source files, entry points, public/internal interfaces, data structures, macros/register definitions, dependencies, and current implementation scheme.
- Every identified function or feature in the target scope, with responsibility, inputs, outputs, side effects, dependencies, error handling, and evidence refs.
- Main business flow and subflows.
- Code execution flow, including branch/error/cleanup paths where evidence supports them.
- State-machine states, transition conditions, events, guards, actions, and evidence-backed transition tables.
- Diagrams for architecture, main flow, code flow, and state machine when enough evidence exists.
- Assumptions, limitations, missing inputs, and owner-review items.

## Diagram Rule

Use Mermaid for the formal detailed design flow so the artifacts are lightweight, readable, and render directly in Chat. Generate Mermaid sources for architecture, main business flow, code flow, and state-machine diagrams when enough evidence exists, call `chipmate_render_mermaid_diagram` for each diagram, and insert the returned PNG images into the matching Word sections through `create_word_document`. The Mermaid tool prefers the configured remote render server and falls back to local Chrome/Edge when possible; disclose `fallbackUsed=true` in the final answer because it means remote rendering failed but a local PNG was generated. Keep `.mmd` files as traceable source artifacts rather than the Word body display format.

If Mermaid-to-PNG rendering fails on both remote and local providers, fail closed and report the render failure. Do not generate a Word document that silently substitutes Mermaid syntax or source summaries for the required diagram images.

The skill or agent must decide diagram semantics from code evidence, not from renderer heuristics. Do not infer main flow, exception path, importance, or business meaning from labels, function names, Chinese words, or domain terms without supporting evidence.

## Evidence Rule

Every design claim should be tied to code evidence when possible. Cite file paths and line ranges. For dynamic dispatch, generated code, macro-expanded behavior, or compile-time conditional behavior, mark the coverage as partial unless exact evidence is present.

Converge when the collected evidence is enough to produce a reviewable detailed design document. Do not exhaust the tool budget trying to prove every branch before creating the `.docx`; put uncertain or partially covered areas into assumptions, gaps, risks, and owner-review items.

After evidence is sufficient, create a minimal complete valid `WordDocSpec` and call `create_word_document`. If `create_word_document` returns argument or validation errors, repair the `WordDocSpec` and retry before resuming broad evidence search.

## Word Output Rule

Use the generic `documents`/Word tool contract. Build one complete `WordDocSpec` with sections for current design overview, function/feature detail, main and sub business flows, code flow, state-machine transitions, evidence ledger, assumptions, gaps, and risks. Put each Mermaid-rendered PNG figure in the section it explains, not in a generic appendix or document front matter. After `create_word_document`, call `render_word_document` for visual QA when the tool result does not already include sufficient render evidence.
