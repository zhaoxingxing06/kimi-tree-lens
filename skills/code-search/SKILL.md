---
name: code-search
description: Structural code navigation for many languages via the tree-sitter MCP tools
---

Detailed reference companion to the plugin's always-on system prompt (which carries the core rules): this file adds pagination, index semantics, path confinement, and extension points. Load it on demand — sub-agents can invoke it themselves.

For source code files (java, python, typescript, tsx, go):

- Outline a file or find where a definition lives -> `list_definitions(file)`
- Read one method/class/function body -> `read_definition(file, name)`. Prefer this over Read on large files.
- AST-shaped search (e.g. all call sites of a function, all assignments to a field) -> `ast_search(file, pattern)`. Grep is for strings, comments and config files only.
- Workspace-wide: run `index_workspace(root)` once, then `find_references(name)` (syntactic, name-based), `go_to_definition(name, file?)`, `callers(name)` / `callees(name)` (heuristic call graph).
- Audit & quality: `list_presets({language?})` + `preset_search(file, name)`; `analyze_complexity(file)` ranks functions by cyclomatic complexity.
- `get_node_types({language})` returns grammar node types and fields — use it to write correct `ast_search` patterns without trial and error.
- Extend it: extra definition queries in `~/.kimi-code/tree-sitter-queries/<lang>/*.scm`; audit presets in `~/.kimi-code/tree-sitter-queries/presets/<lang>/*.scm` (first `;;` line = description). Use the official upstream tags.scm format: `@definition.<kind>` optionally paired with `@name` and `@doc` (`#strip!` supported); legacy `@<kind>.def` still decodes. `callers`/`callees` are query-driven from official `@reference.call` tags where available (java/go/python; ts/tsx use built-in call extraction).
- Paths are confined automatically: the plugin walks up from each file to the nearest project marker (`.git`, `package.json`, `pom.xml`, ...), or uses host-provided roots / `TREE_SITTER_MCP_ROOTS`. Markerless paths are rejected unless `TREE_SITTER_MCP_ALLOW_UNCONFINED=1`.
- The workspace index auto-refreshes on file changes: the watcher re-parses ONLY the changed files (an `index_version` bump means an incremental update, not a full rebuild), and the index survives restarts via a disk cache whose reuse is verified by content hash — `reused` counts are safe to trust. `index_status` reports freshness.
- Hidden directories (dot-prefixed) and build/dependency dirs (`node_modules`, `target`, `dist`, `build`, `out`, `coverage`, `__pycache__`, `.venv`, `venv`, `vendor`, `gradle`, `.gradle`) are excluded from both the initial walk and watcher updates. Throwaway probe/scratch files must live OUTSIDE any indexed root — files created inside one will never appear in the index.
- `list_definitions` returning an empty list means the language is query-only.
- `file` must be an absolute path unless workspace roots are available; relative paths then resolve against the first root.
- On any tool error or timeout, fall back to Read/Grep directly. Do not retry the same call.

Multi-index (one index per root):

- `index_workspace` keeps one index per root: indexing a new root adds an index instead of replacing the existing one; re-indexing the same root rebuilds it in place.
- Index read ops (`find_references`, `go_to_definition`, `callers`, `callees`, `index_status`) accept an optional `root`. With several indexes you MUST pass `root`; omitting it errors with the available roots. `index_status` without `root` reports the most recently built index plus `available_roots`.
- Read ops are paginated: `limit` (default 50, hard 200) / `offset`; responses carry `total`/`returned`/`offset`/`truncated` and the `index_root`/`index_version` they answered from. Page with `offset` instead of widening results; `index_workspace` reports `files_truncated` when the `maxFiles` cap clipped the file walk.

Main-agent discipline (sub-agents do NOT see this skill text — relay it yourself):

- Keep `index_workspace` exclusive to the main agent. Delegate read-only lookups to a read-only sub-agent whose tool whitelist omits `index_workspace` (bundled: `tree-lens-tracer` for chain tracing, `tree-lens-impact` for pre-change blast radius, `tree-lens-verifier` for post-change checks).
- When delegating, spell out in the task prompt: absolute paths, exact tool names, which `root` to query, and "re-check `index_status` and compare `index_version` before concluding". Sub-agents start with zero context and only see tool descriptions.
- Require compact deliverables: conclusions + `file:line` references + the `index_version` used — never raw JSON dumps. Prompt-level rules are advisory; the hard guarantees are the tool whitelist and server-side clamping.
