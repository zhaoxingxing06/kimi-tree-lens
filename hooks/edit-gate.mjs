import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
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

function defText(lines, d) {
  const s = d.start_line ?? 0;
  if (!s) return null;
  return lines.slice(s - 1, Math.min(d.end_line ?? s, lines.length)).join("\n");
}

const squash = (s) => String(s ?? "").replace(/\s+/g, "");

const CONTAINER_KINDS = new Set(["class", "interface", "enum", "struct"]);

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
    const oldStr = String(ti.old_string ?? "");
    const anchor = oldStr
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
      const text = lines.join("\n");
      let span = null;
      const idx = text.indexOf(oldStr);
      if (idx >= 0) {
        const start = text.slice(0, idx).split("\n").length;
        span = [start, start + oldStr.split(/\r?\n/).length - 1];
      }
      const inSpan = (d) => {
        const s = d.start_line ?? 0;
        const e = Math.min(d.end_line ?? s, lines.length);
        if (span) return s <= span[1] && e >= span[0];
        for (let i = s; i <= e; i++) if (lineAt(lines, i).includes(anchor)) return true;
        return false;
      };
      let touched = defs.filter(inSpan);
      if (touched.some((d) => !CONTAINER_KINDS.has(d.kind))) {
        touched = touched.filter((d) => !CONTAINER_KINDS.has(d.kind));
      }
      touched = touched.filter((d) => !isWarned(dir, `${target}::${d.name}`)).slice(0, MAX_DEFS);
      if (!touched.length) return null;

      const unreadSections = [];
      const driftNotes = [];
      let blockWorthy = false;
      for (const d of touched) {
        let res = null;
        try {
          res = await q("callers", { name: d.name, root, limit: 200 });
        } catch {}
        const hits = (res?.results ?? []).filter((h) => {
          if (moduleOf(root, h.file) !== targetModule) return false;
          if (typeof h.line !== "number" || h.line < 1) return false;
          if (rel(root, norm(h.file)) === null) return false;
          const f = norm(h.file);
          if (f === target && Math.abs(h.line - (d.start_line ?? 0)) <= 1) return false;
          return lineAt(fileLines(f) ?? [], h.line).includes(d.name);
        });
        const unread = hits.filter((h) => !lineWasRead(dir, norm(h.file), h.line));
        if (unread.length) {
          blockWorthy = true;
          const shown = unread.slice(0, MAX_SITES);
          unreadSections.push(
            `- ${d.name} (${d.kind}:${d.start_line}), called at:\n` +
              shown
                .map((h) => `    ${rel(root, norm(h.file))}:${h.line} (${h.confidence ?? "unresolved"})`)
                .join("\n") +
              (unread.length > shown.length ? `\n    ...${unread.length - shown.length} more` : "")
          );
        }
        const others = [...new Set((res?.defined_in ?? []).map((f) => norm(f)))]
          .filter((f) => f !== target)
          .filter((f) => {
            const m = moduleOf(root, f);
            return m && m !== targetModule;
          });
        if (others.length) {
          const selfRaw = defText(lines, d);
          if (selfRaw) {
            const self = squash(selfRaw);
            const diffModules = new Set();
            const sameModules = new Set();
            for (const f of others.slice(0, 4)) {
              try {
                const o = await q("cached_outline", { file: f });
                const od =
                  (o?.defs ?? []).find((x) => x.name === d.name && x.kind === d.kind) ??
                  (o?.defs ?? []).find((x) => x.name === d.name);
                const otherLines = od ? fileLines(f) : null;
                const otherRaw = od && otherLines ? defText(otherLines, od) : null;
                if (!otherRaw) continue;
                (squash(otherRaw) === self ? sameModules : diffModules).add(moduleOf(root, f));
              } catch {}
            }
            if (diffModules.size) {
              blockWorthy = true;
              driftNotes.push(
                `- ${d.name}: body differs in ${[...diffModules].join(", ")}` +
                  (sameModules.size ? ` (identical in ${[...sameModules].join(", ")})` : "") +
                  ` — check whether this change should be ported`
              );
            }
          }
        }
      }
      if (!blockWorthy) return null;
      for (const d of touched) markWarned(dir, `${target}::${d.name}`);
      let out =
        `[tree-lens gate] edit paused once to surface impact info — re-issue the SAME edit to proceed ` +
        `(already recorded; the retry passes silently).\n${rel(root, target) ?? target}`;
      if (unreadSections.length) out += `\ncall sites not read this session:\n` + unreadSections.join("\n");
      if (driftNotes.length) out += `\ncross-module drift:\n` + driftNotes.join("\n");
      out += `\n("not read" is ledger-based: full-file reads count as fully read; if you already know these, just re-issue.)`;
      return out;
    });

    if (!report) process.exit(0);
    try {
      appendFileSync(path.join(dir, "traces.log"), `[${new Date().toISOString()}] ${report}\n\n`);
    } catch {}
    console.error(report);
    process.exit(2);
  } catch {}
  process.exit(0);
});
