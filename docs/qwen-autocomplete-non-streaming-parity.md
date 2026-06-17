# Qwen Autocomplete Non-Streaming Parity Ledger

This ledger fixes the non-streaming parity boundary for the ChipMate qwen autocomplete path against Kilo qwen-direct and Continue autocomplete.

## Alignment Target

- Continue reference: pin before implementation review and record the commit in this ledger when a dependency bump is intentional.
- Transport: non-streaming `/v1/completions` only, with `stream: false`.
- Prompt family: Qwen FIM single-file and multifile renderers.
- Product identity: keep ChipMate configuration namespace, command IDs, diagnostics prefix, and shared provider API key UX.

## Explicitly Ignored

- Streaming/generator reuse: ignored.
- `CompletionStreamer`: ignored.
- `GeneratorReuseManager`: ignored.
- `ListenableGenerator`: ignored.
- SSE mid-stream cancellation and partial generator reuse: ignored.

## Current Non-Streaming Ledger

| Area | Status | Notes |
| --- | --- | --- |
| Config and provider registration | Aligned | `chipmate.completion.provider` preserves `qwen-direct`, `none`, and legacy `openai-compatible` UI compatibility. Only `qwen-direct` registers the qwen provider. |
| Transport | Aligned | `QwenFimClient` posts raw completions with `stream: false`, Qwen stop tokens, and the shared ChipMate provider API key. |
| HelperVars | Aligned with diagnostics | Prefix/suffix pruning, `workspaceUris`, language info, file contents/lines, selected completion info, and optional AST `treePath` status are represented. |
| Context payload | Partially aligned | Recently edited, recently opened, import definitions, and root path snippets are qwen-owned and isolated from Chat/RAG/CodeGraph. Clipboard, diff, recent visited, and static context remain payload slots but are not active sources. |
| Prompt rendering | Aligned for active inputs | Single-file and multifile Qwen FIM renderers keep Continue-style token budgets and inject only selected snippets. |
| Filters and postprocess | Aligned for non-streaming subset | Full-text filtering runs before postprocess for stop tokens, fences, path lines, repetition, suffix echo, blank output, Qwen special tokens, and think markers. |
| Range | Aligned | Inline range remains single-line and uses suffix replacement checks to avoid duplicated suffix/prefix output. |
| Cache | Allowed adapter difference | Non-streaming exact/typed-prefix cache is qwen-owned. Streaming generator reuse is ignored. |

## Allowed Product Differences

- Configuration names, command IDs, log labels, and UI text stay ChipMate-specific.
- Private provider endpoint/model defaults are never written into tracked source; packaging-only manifest injection remains an artifact step.
- The qwen runtime must stay isolated from Chat, RAG, CodeGraph, and semantic search.
