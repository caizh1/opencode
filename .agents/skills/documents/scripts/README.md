# Documents Helper Script Manifest

ChipMate keeps the general Word workflow productized through built-in tools, but this
directory exposes a Codex-style helper script catalog as read-only skill resources.

Use `chipmate_read_skill_resource` to read `scripts/manifest.json` when a document
task needs the lower-level helper map. Do not execute files from this directory
directly. Script execution must go through `chipmate_run_skill_script`, an active
skill, manifest v2 opt-in (`execution.directExecution: true` or a manifest-level
allowance), offline network policy, input validation, bounded stdout/stderr,
controlled artifacts under `.chipmate/docs/skill-script-artifacts`, and normal
ChipMate command permissions.

Most document helpers remain mapped to native ChipMate Word tools and are not
directly executable. Direct helpers in this catalog are limited to read-only
diagnostics, such as the manifest report and the Word runtime/native field
refresh readiness report. Actual DOCX generation, editing, field refresh, and
render QA stay in the native ChipMate Word tools.

The manifest maps Codex documents helper script names to the closest ChipMate
tooling surface. Low-level `docx_ooxml_patch.py` use is represented by the
native `apply_word_document_edits.patchOoxmlPart` operation, which keeps exact
preconditions, XML part allowlists, structural checks, and render checks inside
the productized Word toolchain instead of creating a second Word generation
pipeline.
