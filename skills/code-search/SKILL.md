---
name: code-search
description: Structural code navigation for many languages via the tree-sitter MCP tools
---

For source code files (java, python, typescript, tsx, go):

- Outline a file or find where a definition lives -> `list_definitions(file)`
- Read one method/class/function body -> `read_definition(file, name)`. Prefer this over Read on large files.
- AST-shaped search (e.g. all call sites of a function, all assignments to a field) -> `ast_search(file, pattern)`. Grep is for strings, comments and config files only.
- Workspace-wide: run `index_workspace(root)` once, then `find_references(name)` (syntactic, name-based), `go_to_definition(name, file?)`, `callers(name)` / `callees(name)` (heuristic call graph).
- Audit & quality: `list_presets({language?})` + `preset_search(file, name)`; `analyze_complexity(file)` ranks functions by cyclomatic complexity.
- `get_node_types({language})` returns grammar node types and fields — use it to write correct `ast_search` patterns without trial and error.
- Extend it: extra definition queries in `~/.kimi-code/tree-sitter-queries/<lang>/*.scm`; audit presets in `~/.kimi-code/tree-sitter-queries/presets/<lang>/*.scm` (first `;;` line = description).
- Paths are confined automatically: the plugin walks up from each file to the nearest project marker (`.git`, `package.json`, `pom.xml`, ...), or uses host-provided roots / `TREE_SITTER_MCP_ROOTS`. Markerless paths are rejected unless `TREE_SITTER_MCP_ALLOW_UNCONFINED=1`.
- The workspace index auto-refreshes on file changes (watcher) and survives restarts via a disk cache (`TREE_SITTER_MCP_CACHE_DIR`); `index_status` reports freshness.
- `list_definitions` returning an empty list means the language is query-only.
- `file` must be an absolute path unless workspace roots are available; relative paths then resolve against the first root.
- On any tool error or timeout, fall back to Read/Grep directly. Do not retry the same call.
