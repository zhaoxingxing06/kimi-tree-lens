// Post-read outline cache warmer for the tree-lens plugin.
// Spawned detached by read-ledger.mjs after Read/Write/Edit/Bash tool calls;
// parses supported source files with the same worker the MCP server uses and
// writes outline cache entries in the exact format server.js expects, so the
// next cached_outline call hits a warm cache instead of parsing live.

import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { realpathSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { langForFile } from "../lib/languages.js";
import { MAX_BYTES } from "../lib/trim.js";

// Must mirror the directory resolution in server.js (OUTLINE_DIR)
const OUTLINE_DIR =
  process.env.TREE_SITTER_MCP_OUTLINE_DIR ??
  path.join(process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code"), "tree-lens-hook", "outlines");

// Safety cap on files warmed per invocation (a Bash call may touch many paths)
const MAX_FILES = 8;

// Cache key must mirror server.js outlineCacheFile(): sha1 of the realpath'd absolute path
function cacheFile(abs) {
  return path.join(OUTLINE_DIR, `${createHash("sha1").update(abs).digest("hex")}.json`);
}

// Same freshness rule as server.js readOutlineCache(): mtime + size must match
function isFresh(abs, st) {
  try {
    const c = JSON.parse(readFileSync(cacheFile(abs), "utf8"));
    return c.mtimeMs === st.mtimeMs && c.size === st.size && Array.isArray(c.defs);
  } catch {
    return false;
  }
}

// Entry shape must mirror server.js writeOutlineCache()
function writeCache(abs, st, data) {
  mkdirSync(OUTLINE_DIR, { recursive: true });
  writeFileSync(cacheFile(abs), JSON.stringify({
    v: 1,
    file: abs,
    lang: data.lang,
    size: st.size,
    mtimeMs: st.mtimeMs,
    parsedAt: Date.now(),
    count: data.count,
    truncated: data.truncated ?? false,
    defs: data.defs,
  }));
}

// Collect warmup candidates: existing, supported-language, size-limited, stale-cache files
const targets = [];
for (const p of process.argv.slice(2)) {
  try {
    const abs = realpathSync(p);
    if (!langForFile(abs)) continue;
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES || isFresh(abs, st)) continue;
    targets.push({ abs, st });
  } catch {}
}

if (targets.length) {
  // Reuse the plugin's worker so definition extraction rules (defQueries, ranges,
  // MAX_DEFS truncation) stay identical to what list_definitions returns
  const worker = new Worker(new URL("../lib/worker.js", import.meta.url));
  let seq = 0;
  const pending = new Map();
  worker.on("message", (msg) => {
    const resolve = pending.get(msg?.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.ok ? msg.data : null);
    }
  });
  worker.on("error", () => {});
  const call = (file) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    worker.postMessage({ id, op: "list_definitions", payload: { file } });
  });
  for (const t of targets.slice(0, MAX_FILES)) {
    try {
      const data = await call(t.abs);
      if (data && Array.isArray(data.defs)) {
        // Re-stat right before writing: if the file changed during parsing,
        // the entry records the newer mtime and simply misses on next read
        let st = t.st;
        try {
          st = statSync(t.abs);
        } catch {}
        writeCache(t.abs, st, data);
      }
    } catch {}
  }
  worker.terminate();
}
process.exit(0);
