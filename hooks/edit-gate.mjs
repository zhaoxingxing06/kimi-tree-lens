import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findProjectRoot,
  isWarned,
  lineWasRead,
  markWarned,
  norm,
  sessionDir,
  storePaths,
} from "./lib/state.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_DEFS = 5;
const MAX_SITES = 5;

let input = "";
process.stdin.on("data", (c) => (input += c));

function rel(root, file) {
  const r = path.relative(root, file);
  return r.startsWith("..") ? null : r;
}

function moduleOf(root, file) {
  const r = rel(root, file);
  return r ? r.split(path.sep)[0] : null;
}

function indexRoot(fromDir) {
  let dir = fromDir;
  let best = null;
  while (true) {
    const n = norm(dir);
    const store = storePaths(n);
    if (existsSync(store.db) || existsSync(store.json)) best = n;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return best;
}

function fileLines(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

function lineAt(lines, line) {
  return lines[line - 1] ?? "";
}

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(PLUGIN_ROOT, "server.js")],
    cwd: PLUGIN_ROOT,
    env: { ...process.env, TREE_SITTER_MCP_TIMEOUT_MS: "30000" },
  });
  const client = new Client({ name: "tree-lens-edit-gate", version: "0.0.1" });
  await client.connect(transport);
  try {
    return await fn(async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse(r.content[0].text);
    });
  } finally {
    await client.close().catch(() => {});
  }
}

process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input || "{}");
    const ti = payload.tool_input ?? {};
    const raw = ti.path ?? ti.file_path;
    if (typeof raw !== "string") process.exit(0);
    const target = norm(raw);
    let isFile = false;
    try {
      isFile = statSync(target).isFile();
    } catch {}
    if (!isFile) process.exit(0);
    const anchor = String(ti.old_string ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 3);
    if (!anchor) process.exit(0);
    const lines = fileLines(target);
    if (!lines) process.exit(0);
    const root = indexRoot(path.dirname(target)) ?? findProjectRoot(path.dirname(target));
    if (!root) process.exit(0);
    const dir = sessionDir(payload);
    const targetModule = moduleOf(root, target);

    const report = await withClient(async (q) => {
      let defs = [];
      try {
        const outline = await q("cached_outline", { file: target });
        if (outline.ok && Array.isArray(outline.defs)) defs = outline.defs;
      } catch {}
      const touched = defs
        .filter((d) => {
          const s = d.start_line ?? 0;
          const e = Math.min(d.end_line ?? s, lines.length);
          for (let i = s; i <= e; i++) if (lineAt(lines, i).includes(anchor)) return true;
          return false;
        })
        .filter((d) => !isWarned(dir, `${target}::${d.name}`))
        .slice(0, MAX_DEFS);
      if (!touched.length) return null;

      const sections = [];
      const modules = new Set();
      let anyVerified = false;
      for (const d of touched) {
        let res = null;
        try {
          res = await q("callers", { name: d.name, root, limit: 200 });
        } catch {}
        for (const f of res?.defined_in ?? []) {
          const m = moduleOf(root, f);
          if (m) modules.add(m);
        }
        const hits = (res?.results ?? []).filter((h) => {
          if (moduleOf(root, h.file) !== targetModule) return false;
          if (typeof h.line !== "number" || h.line < 1) return false;
          if (rel(root, norm(h.file)) === null) return false;
          const f = norm(h.file);
          if (f === target && Math.abs(h.line - (d.start_line ?? 0)) <= 1) return false;
          return lineAt(fileLines(f) ?? [], h.line).includes(d.name);
        });
        const files = new Set(hits.map((h) => norm(h.file)));
        if (hits.length) anyVerified = true;
        const sorted = [...hits].sort(
          (a, b) =>
            (lineWasRead(dir, norm(a.file), a.line) ? 1 : 0) -
            (lineWasRead(dir, norm(b.file), b.line) ? 1 : 0)
        );
        const unreadCount = sorted.filter((h) => !lineWasRead(dir, norm(h.file), h.line)).length;
        const shown = sorted.slice(0, MAX_SITES);
        let section =
          `- ${d.name} (${d.kind}:${d.start_line}) — ${hits.length} verified call site(s) in ${files.size} file(s), ${unreadCount} unread at call line:`;
        if (shown.length) {
          section +=
            "\n" +
            shown
              .map(
                (h) =>
                  `    ${rel(root, norm(h.file))}:${h.line} (${
                    lineWasRead(dir, norm(h.file), h.line) ? "read" : "unread"
                  }) (${h.confidence ?? "unresolved"})`
              )
              .join("\n");
          if (sorted.length > shown.length) section += `\n    ...${sorted.length - shown.length} more`;
        }
        if (hits.length) sections.push(section);
      }
      if (!anyVerified && modules.size <= 1) return null;
      for (const d of touched) markWarned(dir, `${target}::${d.name}`);

      let out = `[tree-lens trace] ${rel(root, target) ?? target} edit touches:\n` + sections.join("\n");
      if (modules.size > 1) {
        out += `\nsame-named definitions in ${modules.size} modules: ${[...modules].join(", ")}`;
      }
      out += `\ninformational only; re-issue the same edit to proceed.`;
      return out;
    });

    if (!report) process.exit(0);
    console.error(report);
    process.exit(2);
  } catch {}
  process.exit(0);
});
