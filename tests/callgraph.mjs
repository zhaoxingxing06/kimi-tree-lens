// Focused checks for callers/callees enhancements:
//   #1 lang field on every hit   #2 file/language filters   #3 receiver (recv) on member calls
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.js", import.meta.url));
const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-callgraph-"));
const root = path.join(tmp, "proj");
fsSync.mkdirSync(root, { recursive: true });

const py = [
  "class Repo:",
  "    def save(self):",
  "        pass",
  "",
  "def run():",
  "    repo = Repo()",
  "    repo.save()",
  "    print(run)",
  "",
].join("\n");
fsSync.writeFileSync(path.join(root, "svc.py"), py);

const java = [
  "class Sample {",
  "    void run() {",
  "        helper();",
  "    }",
  "    void helper() { }",
  "}",
].join("\n");
fsSync.writeFileSync(path.join(root, "Sample.java"), java);

const ts = [
  "export function run() {",
  "  helper();",
  "}",
  "function helper() {}",
].join("\n");
fsSync.writeFileSync(path.join(root, "util.ts"), ts);

let pass = 0;
let fail = 0;
const check = (label, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label}${extra ? " :: " + JSON.stringify(extra).slice(0, 400) : ""}`);
  }
};
const parse = (r) => JSON.parse(r.content[0].text);

const t = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: {
    ...process.env,
    TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
    TREE_SITTER_MCP_CACHE_DIR: fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-callgraph-cache-")),
  },
});
const c = new Client({ name: "callgraph-check", version: "0.0.1" });
await c.connect(t);

try {
  let r = parse(await c.callTool({ name: "index_workspace", arguments: { root } }));
  check("index ok (3 files)", r.ok === true && r.indexed === 3, r);

  r = parse(await c.callTool({ name: "callees", arguments: { name: "run" } }));
  check("callees run spans 3 files", r.ok === true && r.total === 5 && new Set(r.results.map((x) => x.lang)).size === 3, r);
  check("callees carry lang", r.results.every((x) => x.lang), r);

  r = parse(await c.callTool({ name: "callees", arguments: { name: "run", language: "typescript" } }));
  check("callees language filter", r.ok === true && r.total === 1 && r.results[0].callee === "helper" && r.results[0].lang === "typescript", r);

  r = parse(await c.callTool({ name: "callees", arguments: { name: "run", file: path.join(root, "svc.py") } }));
  check("callees file filter", r.ok === true && r.total === 3 && r.results.every((x) => x.lang === "python") && r.results.some((x) => x.callee === "save" && x.recv === "repo"), r);

  r = parse(await c.callTool({ name: "callers", arguments: { name: "save" } }));
  check("callers save has receiver", r.ok === true && r.total === 1 && r.results[0].caller === "run" && r.results[0].recv === "repo", r);

  r = parse(await c.callTool({ name: "callers", arguments: { name: "helper", language: "java" } }));
  check("callers language filter java", r.ok === true && r.total === 1 && r.results[0].caller === "run" && r.results[0].lang === "java", r);

  r = parse(await c.callTool({ name: "callers", arguments: { name: "helper" } }));
  check("callers helper spans ts+java", r.ok === true && r.total === 2, r);

  r = parse(await c.callTool({ name: "index_workspace", arguments: { root } }));
  const persistedCalls = r.persisted !== undefined;
  check("re-index reuses persisted", r.ok === true && persistedCalls && r.reused === 3, r);
  r = parse(await c.callTool({ name: "callers", arguments: { name: "save" } }));
  check("recv survives persistence", r.ok === true && r.results[0]?.recv === "repo", r);
} finally {
  await c.close();
  fsSync.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
