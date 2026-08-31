import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const KIMI_HOME =
  process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code");
export const CACHE_DIR =
  process.env.TREE_SITTER_MCP_CACHE_DIR ??
  path.join(KIMI_HOME, "tree-sitter-plugin-cache");
export const STATE_BASE = path.join(KIMI_HOME, "tree-lens-gate");

export function norm(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

export function sessionDir(payload) {
  const key = createHash("sha1")
    .update(`${payload.session_id ?? "nosession"}|${payload.cwd ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(STATE_BASE, key);
}

export function ledgerAdd(dir, paths) {
  const file = path.join(dir, "read-ledger.json");
  const data = readJson(file, { read: [] });
  const set = new Set(data.read);
  for (const p of paths) if (p) set.add(p);
  data.read = [...set];
  writeJson(file, data);
}

export function ledgerAddReads(dir, entries) {
  const lines = [];
  for (const e of entries) {
    if (!e?.path) continue;
    const ranges =
      Array.isArray(e.ranges) && e.ranges.length
        ? e.ranges.filter((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite))
        : [[-1, -1]];
    if (!ranges.length) continue;
    lines.push(JSON.stringify({ p: e.path, r: ranges }));
  }
  if (!lines.length) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, "read-ledger.log"), lines.join("\n") + "\n");
}

function ledgerEntries(dir) {
  const out = [];
  try {
    for (const line of readFileSync(path.join(dir, "read-ledger.log"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e?.p && Array.isArray(e.r)) out.push(e);
      } catch {}
    }
  } catch {}
  const legacy = readJson(path.join(dir, "read-ledger.json"), null);
  if (legacy) {
    for (const p of legacy.read ?? []) {
      const ranges = (legacy.readRanges?.[p] ?? []).filter(
        (r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite)
      );
      out.push({ p, r: ranges.length ? ranges : [[-1, -1]] });
    }
  }
  return out;
}

export function lineWasRead(dir, p, line) {
  for (const e of ledgerEntries(dir)) {
    if (e.p !== p) continue;
    for (const [s, en] of e.r) {
      if (s === -1 && en === -1) return true;
      if (line >= s && line <= (en === -1 ? Infinity : en)) return true;
    }
  }
  return false;
}

export function ledgerHas(dir, p) {
  return ledgerEntries(dir).some((e) => e.p === p);
}

export function markWarned(dir, file) {
  const file2 = path.join(dir, "warned.json");
  const data = readJson(file2, {});
  data[file] = Date.now();
  writeJson(file2, data);
}

export function isWarned(dir, file) {
  return Boolean(readJson(path.join(dir, "warned.json"), {})[file]);
}

export const PROJECT_MARKERS = [
  ".git", ".hg", ".svn",
  "package.json", "pom.xml", "build.gradle", "pyproject.toml", "setup.py",
  "setup.cfg", "Cargo.toml", "go.mod", "composer.json",
];

export function findProjectRoot(startDir) {
  let dir = startDir;
  while (true) {
    for (const m of PROJECT_MARKERS) {
      if (existsSync(path.join(dir, m))) return norm(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function storePaths(rootAbs) {
  const h = createHash("sha256").update(rootAbs).digest("hex").slice(0, 24);
  return {
    db: path.join(CACHE_DIR, `${h}.db`),
    json: path.join(CACHE_DIR, `${h}.json`),
  };
}

export function rootStateDir(rootAbs) {
  const h = createHash("sha256").update(rootAbs).digest("hex").slice(0, 24);
  return path.join(STATE_BASE, "store-" + h);
}

export function acquireBuildLock(lockFile, freshMs = 15 * 60_000) {
  try {
    const st = statSync(lockFile);
    if (Date.now() - st.mtimeMs < freshMs) return false;
  } catch {}
  mkdirSync(path.dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, String(Date.now()));
  return true;
}

export function lastBuildFresh(file, freshMs) {
  const data = readJson(file, null);
  return Boolean(data?.at && Date.now() - data.at < freshMs);
}

function collect(out, raw, cwd) {
  const tok = raw.replace(/^['"]|['"]$/g, "");
  if (!tok || tok.startsWith("-") || tok.startsWith("/dev/")) return;
  for (const cand of [tok, path.resolve(cwd, tok)]) {
    try {
      if (statSync(cand).isFile()) {
        out.add(norm(cand));
        return;
      }
    } catch {}
  }
}

export function bashWriteTargets(command, cwd) {
  const out = new Set();
  for (const seg of command.split(/[;&|\n]/)) {
    const s = seg.trim();
    if (!s) continue;
    let m;
    const re = /(?:^|[\s])(?:\d*&)?(>>?)\s*([^\s;&|<>"]+)/g;
    while ((m = re.exec(s)) !== null) collect(out, m[2], cwd);
    const tokens = s.match(/[^\s]+/g) ?? [];
    const head = (tokens[0] ?? "").split("/").pop();
    const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
    if (head === "tee") {
      for (const t of args) collect(out, t, cwd);
    } else if (head === "sed" && tokens.some((t) => /^-[A-Za-z]*i/.test(t))) {
      for (const t of args) collect(out, t, cwd);
    } else if (head === "rm") {
      for (const t of args) collect(out, t, cwd);
    } else if ((head === "mv" || head === "cp") && args.length >= 2) {
      collect(out, args[args.length - 1], cwd);
    }
  }
  return [...out];
}
