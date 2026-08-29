# Tree Lens — structural code navigation (core rules)

Tree Lens exposes tree-sitter (WASM) MCP tools (`mcp__tree-lens__*`) for Java, Python, TypeScript, TSX, and Go. Use them instead of Read/Grep whenever the question is about code structure — definitions, call sites, AST shapes — not strings, comments, or config. This block is the always-on core; load `/skill:code-search` for the full reference (pagination, index semantics, path confinement, extension points).

## Tool selection

- Outline a file or find where a definition lives -> `list_definitions(file)`
- Read one method/class/function body -> `read_definition(file, name)`; prefer this over `Read` on large files
- AST-shaped search that Grep cannot express -> `ast_search(file, pattern)`; Grep is for strings, comments, and config files only
- Workspace-wide questions: run `index_workspace(root)` once, then `find_references(name)`, `go_to_definition(name, file?)`, `callers(name)` / `callees(name)`
- Audit and quality: `list_presets({language?})` + `preset_search(file, name)`; `analyze_complexity(file)` ranks functions by cyclomatic complexity
- Before writing an `ast_search` pattern, consult `get_node_types({language})` — never guess grammar node names

## Reviewing new changes (diffs / previews)

- When the user asks to review, analyze, or assess a preview of newly added/changed code that touches a project, trigger the tree-lens MCP tools FIRST — do not reach for Grep/Read first
- Start with `index_workspace(root)` (skip if `index_status` shows the root is already indexed), then for each symbol the change defines or modifies: `callers` to find upstream impact, `callees` for downstream reach, `find_references` for every occurrence
- Judge the change in its call context, not in isolation; Grep/Read are for what the index cannot answer (the diff text itself, comments, config), and as the documented fallback after tool errors

## Multi-index

- One index per root: indexing a new root adds an index; re-indexing the same root rebuilds it in place
- Index read ops accept an optional `root`; with several indexes you MUST pass it — omitting it errors with the available roots
- On any tool error or timeout, fall back to Read/Grep directly; never retry the same call

## Interpreting results

- `find_references` / `callers` / `callees` are name-based recall: prefer hits with `confidence: exact` and a `resolved_to`; `likely`/`name` hits are leads only, spot-check with Read before concluding
- Every conclusion cites `file:line` copied from tool output — never guessed
- Zero hits is a real answer; report it plainly — never pad with Grep/Read output presented as index results

## Sub-agents (they do NOT see this text — relay it yourself)

- `index_workspace` is exclusive to the main agent; delegate read-only lookups to read-only sub-agents (e.g. `tree-lens-tracer`) whose tool whitelist omits it
- In the task prompt spell out: absolute paths, exact tool names, which `root` to query, and "re-check `index_status` and compare `index_version` before concluding" — sub-agents start with zero context
- Require compact deliverables: conclusions + `file:line` references + the `index_version` used — never raw JSON dumps
