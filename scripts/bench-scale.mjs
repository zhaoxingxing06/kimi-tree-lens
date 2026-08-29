import { Worker } from "node:worker_threads";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const FILES = Math.max(1, Number(arg("files", 20000)));
const DEFS = Math.max(2, Number(arg("defs", 8)));
const DIRS = Math.max(1, Number(arg("dirs", 100)));
const LANG = String(arg("lang", "python"));

const ext = { python: ".py", typescript: ".ts", java: ".java", go: ".go" }[LANG] ?? ".py";
const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-bench-scale-"));
fsSync.mkdirSync(path.join(tmp, "proj"), { recursive: true });
const root = realpathSync(path.join(tmp, "proj"));
const cacheDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-bench-scale-cache-"));

let body;
if (LANG === "python") {
  body = (d, i, j) => [
    `def f${i}_${j}():`,
    `    return g${i}_${(j + 1) % DEFS}()`,
    "",
    `def g${i}_${j}():`,
    `    return helper${i}()`,
    "",
    `def helper${i}():`,
    "    return 1",
    "",
  ].join("\n");
} else if (LANG === "java") {
  body = (d, i, j) => [
    `public class C${i}_${j} {`,
    `    private H${i} h = new H${i}();`,
    `    public int f${i}_${j}() { return h.go(); }`,
    `}`,
    "",
  ].join("\n");
} else {
  body = (d, i, j) => [`export function f${i}_${j}(): number {`, `  return f${i}_${(j + 1) % DEFS}();`, "}", ""].join("\n");
}

const tGen = Date.now();
fsSync.mkdirSync(root, { recursive: true });
let count = 0;
outer: for (let d = 0; d < DIRS; d++) {
  const dir = path.join(root, `mod${d}`);
  fsSync.mkdirSync(dir, { recursive: true });
  const perDir = Math.ceil(FILES / DIRS);
  for (let i = 0; i < perDir; i++) {
    let content = "";
    if (LANG === "python") {
      content = body(dir, d, i % DEFS);
    } else if (LANG === "java") {
      content = body(dir, d, i % DEFS);
    } else {
      content = body(dir, d, i % DEFS);
    }
    fsSync.writeFileSync(path.join(dir, `F${d}_${i}${ext}`), content);
    count++;
    if (count >= FILES) break outer;
  }
}
const genMs = Date.now() - tGen;

const w = new Worker(new URL("../lib/worker.js", import.meta.url), {
  env: { ...process.env, TREE_SITTER_MCP_ALLOW_UNCONFINED: "1", TREE_SITTER_MCP_CACHE_DIR: cacheDir },
});
const call = (id, op, payload, timeoutMs = 1800000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${op} timed out`)), timeoutMs);
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
const coldMs = Date.now() - t0;

const sample = path.join(root, `mod0`, `F0_0${ext}`);
fsSync.appendFileSync(sample, "\n# incremental touch\n");
const t1 = Date.now();
const inc = await call(2, "index_workspace", { root });
const incMs = Date.now() - t1;

const names = [];
for (let i = 0; i < 200; i++) {
  const d = Math.floor(Math.random() * DIRS);
  names.push(`f${d}_${Math.floor(Math.random() * DEFS)}`);
}
const lat = [];
let queryErrors = 0;
for (let i = 0; i < names.length; i++) {
  const t = Date.now();
  try {
    await call(100 + i, i % 2 ? "go_to_definition" : "find_references", { name: names[i], root });
    lat.push(Date.now() - t);
  } catch (e) {
    queryErrors++;
  }
}
lat.sort((a, b) => a - b);
const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : "n/a");

const rssMb = Math.round(process.memoryUsage().rss / 1048576);
console.log(`# Scale report — ${FILES} files × ${DEFS} defs, ${LANG} (generated in ${(genMs / 1000).toFixed(1)}s)`);
console.log("");
console.log(`| metric | value |`);
console.log(`|---|---|`);
console.log(`| files indexed | ${idx.indexed} (store ${idx.store}) |`);
console.log(`| symbols | ${idx.symbols} |`);
console.log(`| refs | ${idx.refs} |`);
console.log(`| cold index | ${(coldMs / 1000).toFixed(1)}s (${Math.round((idx.indexed / (coldMs / 1000))).toFixed(0)} files/s) |`);
console.log(`| single-file incremental re-index | ${incMs}ms (parsed=${inc.parsed}, reused=${inc.reused}) |`);
console.log(`| query latency p50 / p95 / max (n=${lat.length}${queryErrors ? `, ${queryErrors} errored` : ""}) | ${p(0.5)}ms / ${p(0.95)}ms / ${lat[lat.length - 1] ?? "n/a"}ms |`);
console.log(`| process RSS after index | ~${rssMb} MB (incl. main thread) |`);

w.terminate();
fsSync.rmSync(tmp, { recursive: true, force: true });
fsSync.rmSync(cacheDir, { recursive: true, force: true });
