import { Worker } from "node:worker_threads";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/bench-precision.mjs <repo-root>");
  process.exit(2);
}
const root = realpathSync(path.resolve(target));
const cacheDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-bench-prec-"));

const w = new Worker(new URL("../lib/worker.js", import.meta.url), {
  env: { ...process.env, TREE_SITTER_MCP_ALLOW_UNCONFINED: "1", TREE_SITTER_MCP_CACHE_DIR: cacheDir },
});

const call = (id, op, payload) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${op} timed out`)), 600000);
    const onMsg = (msg) => {
      if (msg.id !== id) return;
      w.off("message", onMsg);
      clearTimeout(timer);
      if (msg.ok) resolve(msg.data);
      else reject(new Error(`${op}: ${msg.error}`));
    };
    w.on("message", onMsg);
    w.postMessage({ id, op, payload });
  });

const t0 = Date.now();
const idx = await call(1, "index_workspace", { root });
const indexMs = Date.now() - t0;
const t1 = Date.now();
const stats = await call(2, "resolution_stats", { root: undefined });
const statsMs = Date.now() - t1;

const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
console.log(`# Precision report — ${root}`);
console.log("");
console.log(`| metric | value |`);
console.log(`|---|---|`);
console.log(`| files indexed | ${idx.indexed} (store ${idx.store}) |`);
console.log(`| symbols | ${idx.symbols} |`);
console.log(`| cold index time | ${(indexMs / 1000).toFixed(1)}s |`);
console.log(`| stats compute time | ${(statsMs / 1000).toFixed(1)}s |`);
console.log(`| call sites | ${stats.calls_total} (${stats.resolution.recv} with receiver) |`);
console.log(`| call sites exact | ${stats.resolution.exact} (${pct(stats.resolution.exact, stats.calls_total)}) |`);
console.log(`|   via receiver type | ${stats.exact_via.type ?? 0} |`);
console.log(`|   via import | ${(stats.exact_via.import ?? 0) + (stats.exact_via["import-static"] ?? 0)} |`);
console.log(`|   via local | ${stats.exact_via.local ?? 0} |`);
console.log(`| call sites likely | ${stats.resolution.likely} (${pct(stats.resolution.likely, stats.calls_total)}) |`);
console.log(`| call sites name-only | ${stats.resolution.name} (${pct(stats.resolution.name, stats.calls_total)}) |`);
console.log(`| import names resolved | ${stats.imports.names_resolved}/${stats.imports.names} (${pct(stats.imports.names_resolved, stats.imports.names)}) |`);
console.log(`| files with resolved import | ${stats.imports.files_with_resolved_import}/${stats.imports.files_with_imports} |`);
console.log(`| same-name definition groups | ${stats.same_name_definitions.groups} |`);
console.log("");
console.log("Per language:");
for (const [lang, rec] of Object.entries(stats.per_language)) {
  console.log(`- ${lang}: calls=${rec.calls} exact=${pct(rec.exact, rec.calls)} likely=${pct(rec.likely, rec.calls)} name=${pct(rec.name, rec.calls)}`);
}

w.terminate();
fsSync.rmSync(cacheDir, { recursive: true, force: true });
