import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const SCHEMA = 4;

function dbPathFor(rootAbs, cacheDir) {
  const h = createHash("sha256").update(rootAbs).digest("hex").slice(0, 24);
  return path.join(cacheDir, h + ".db");
}

function jsonPathFor(rootAbs, cacheDir) {
  const h = createHash("sha256").update(rootAbs).digest("hex").slice(0, 24);
  return path.join(cacheDir, h + ".json");
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, lang TEXT, key TEXT, hash TEXT,
  pkg TEXT, imports TEXT, vartypes TEXT
);
CREATE TABLE IF NOT EXISTS defs (
  path TEXT, name TEXT, qualname TEXT, kind TEXT,
  start_line INTEGER, end_line INTEGER, bases TEXT, ret TEXT
);
CREATE INDEX IF NOT EXISTS defs_name ON defs(name);
CREATE INDEX IF NOT EXISTS defs_path ON defs(path);
CREATE TABLE IF NOT EXISTS refs (path TEXT, name TEXT, line INTEGER);
CREATE INDEX IF NOT EXISTS refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS refs_path ON refs(path);
CREATE TABLE IF NOT EXISTS calls (
  path TEXT, caller TEXT, callee TEXT, line INTEGER, recv TEXT, lang TEXT
);
CREATE INDEX IF NOT EXISTS calls_callee ON calls(callee);
CREATE INDEX IF NOT EXISTS calls_caller ON calls(caller);
CREATE INDEX IF NOT EXISTS calls_path ON calls(path);
`;

class JsonStore {
  constructor(cacheFile) {
    this.kind = "json";
    this.cacheFile = cacheFile;
    this.files = new Map();
  }
  putFile(f, entry) {
    this.files.set(f, entry);
  }
  delFile(f) {
    this.files.delete(f);
  }
  keyOf(f) {
    return this.files.get(f)?.key ?? null;
  }
  has(f) {
    return this.files.has(f);
  }
  getEntry(f) {
    const e = this.files.get(f);
    return e ? { key: e.key, hash: e.hash ?? null, lang: e.lang } : null;
  }
  adoptKey(f, key) {
    const e = this.files.get(f);
    if (e) e.key = key;
  }
  paths() {
    return [...this.files.keys()];
  }
  fileCount() {
    return this.files.size;
  }
  totals() {
    let symbols = 0;
    let refs = 0;
    for (const e of this.files.values()) {
      symbols += e.defs.length;
      refs += e.refs.length;
    }
    return { files: this.files.size, symbols, refs };
  }
  filesDefining(name) {
    const out = [];
    for (const [f, e] of this.files) {
      if (e.defs.some((d) => d.name === name)) out.push(f);
    }
    return out.sort();
  }
  defsByName(name) {
    const out = [];
    for (const [f, e] of this.files) {
      for (const d of e.defs) {
        if (d.name === name) {
          out.push({ file: f, name: d.name, kind: d.kind, qualname: d.qualname ?? null, start_line: d.start_line, end_line: d.end_line, bases: Array.isArray(d.bases) ? d.bases : [], ret: d.ret ?? null });
        }
      }
    }
    return out;
  }
  refsByName(name, fileFilter) {
    const out = [];
    for (const [f, e] of this.files) {
      if (fileFilter && f !== fileFilter) continue;
      for (const r of e.refs) {
        if (r.name === name) out.push({ file: f, line: r.line });
      }
    }
    return out;
  }
  callsQuery({ callee, caller, file, lang }) {
    const out = [];
    for (const [f, e] of this.files) {
      if (file && f !== file) continue;
      if (lang && e.lang !== lang) continue;
      for (const c of e.calls ?? []) {
        if (callee !== undefined && c.callee !== callee) continue;
        if (caller !== undefined && c.caller !== caller) continue;
        out.push({ file: f, lang: e.lang, caller: c.caller, callee: c.callee, line: c.line, recv: c.recv ?? null });
      }
    }
    return out;
  }
  resolveData() {
    const files = [];
    const defs = [];
    for (const [f, e] of this.files) {
      files.push({ path: f, lang: e.lang, pkg: e.pkg ?? null, imports: e.imports ?? [], vartypes: e.vartypes ?? {} });
      for (const d of e.defs) {
        defs.push({ file: f, name: d.name, kind: d.kind, qualname: d.qualname ?? null, start_line: d.start_line, end_line: d.end_line, bases: Array.isArray(d.bases) ? d.bases : [], ret: d.ret ?? null });
      }
    }
    return { files, defs };
  }
  async flush(root, builtAt, version) {
    const files = {};
    for (const [f, e] of this.files) {
      files[f] = {
        lang: e.lang, key: e.key, defs: e.defs, refs: e.refs, calls: e.calls ?? [],
        pkg: e.pkg ?? null, imports: e.imports ?? [], vartypes: e.vartypes ?? {},
        ...(e.hash ? { hash: e.hash } : {}),
      };
    }
    const payload = { schema: SCHEMA, root, builtAt, version, files };
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    await fs.writeFile(this.cacheFile, JSON.stringify(payload));
  }
  close() {}
}

function safeJson(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

class SqliteStore {
  constructor(db, file) {
    this.kind = "sqlite";
    this.db = db;
    this.file = file;
  }
  static async open(rootAbs, cacheDir) {
    let Sqlite = null;
    try {
      Sqlite = (await import("better-sqlite3")).default;
    } catch {
      return null;
    }
    const file = dbPathFor(rootAbs, cacheDir);
    await fs.mkdir(cacheDir, { recursive: true });
    const tryOpen = () => {
      const db = new Sqlite(file);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.exec(DDL);
      const row = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get();
      if (row && row.v !== String(SCHEMA)) {
        db.exec(
          "DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS defs; DROP TABLE IF EXISTS refs; DROP TABLE IF EXISTS calls;"
        );
        db.exec(DDL);
      }
      const rootRow = db.prepare("SELECT v FROM meta WHERE k = 'root'").get();
      if (rootRow && rootRow.v !== rootAbs) {
        db.exec("DELETE FROM meta; DELETE FROM files; DELETE FROM defs; DELETE FROM refs; DELETE FROM calls;");
      }
      return new SqliteStore(db, file);
    };
    try {
      return tryOpen();
    } catch {
      try {
        await fs.rm(file, { force: true });
        await fs.rm(file + "-wal", { force: true });
        await fs.rm(file + "-shm", { force: true });
        return tryOpen();
      } catch {
        return null;
      }
    }
  }
  async importLegacy(entries, legacyPath) {
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM files").get().c;
    if (count > 0 || !entries) return false;
    const ins = this.db.transaction((map) => {
      for (const [f, e] of Object.entries(map)) this.putFile(f, e);
    });
    try {
      ins(entries);
    } catch {
      return false;
    }
    try {
      await fs.rename(legacyPath, legacyPath + ".migrated");
    } catch {}
    return true;
  }
  putFile(f, entry) {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM defs WHERE path = ?").run(f);
      this.db.prepare("DELETE FROM refs WHERE path = ?").run(f);
      this.db.prepare("DELETE FROM calls WHERE path = ?").run(f);
      this.db
        .prepare("INSERT OR REPLACE INTO files (path, lang, key, hash, pkg, imports, vartypes) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(f, entry.lang, entry.key, entry.hash ?? null, entry.pkg ?? null, JSON.stringify(entry.imports ?? []), JSON.stringify(entry.vartypes ?? {}));
      const insDef = this.db.prepare("INSERT INTO defs (path, name, qualname, kind, start_line, end_line, bases, ret) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const d of entry.defs) insDef.run(f, d.name, d.qualname ?? null, d.kind, d.start_line, d.end_line, d.bases ? JSON.stringify(d.bases) : null, d.ret ?? null);
      const insRef = this.db.prepare("INSERT INTO refs (path, name, line) VALUES (?, ?, ?)");
      for (const r of entry.refs) insRef.run(f, r.name, r.line);
      const insCall = this.db.prepare("INSERT INTO calls (path, caller, callee, line, recv, lang) VALUES (?, ?, ?, ?, ?, ?)");
      for (const c of entry.calls ?? []) insCall.run(f, c.caller ?? null, c.callee, c.line, c.recv ?? null, entry.lang);
    });
    tx();
  }
  delFile(f) {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM files WHERE path = ?").run(f);
      this.db.prepare("DELETE FROM defs WHERE path = ?").run(f);
      this.db.prepare("DELETE FROM refs WHERE path = ?").run(f);
      this.db.prepare("DELETE FROM calls WHERE path = ?").run(f);
    });
    tx();
  }
  keyOf(f) {
    const row = this.db.prepare("SELECT key FROM files WHERE path = ?").get(f);
    return row?.key ?? null;
  }
  has(f) {
    return !!this.db.prepare("SELECT 1 FROM files WHERE path = ?").get(f);
  }
  getEntry(f) {
    return this.db.prepare("SELECT key, hash, lang FROM files WHERE path = ?").get(f) ?? null;
  }
  adoptKey(f, key) {
    this.db.prepare("UPDATE files SET key = ? WHERE path = ?").run(key, f);
  }
  paths() {
    return this.db.prepare("SELECT path FROM files ORDER BY path").all().map((r) => r.path);
  }
  fileCount() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM files").get().c;
  }
  totals() {
    const files = this.db.prepare("SELECT COUNT(*) AS c FROM files").get().c;
    const symbols = this.db.prepare("SELECT COUNT(*) AS c FROM defs").get().c;
    const refs = this.db.prepare("SELECT COUNT(*) AS c FROM refs").get().c;
    return { files, symbols, refs };
  }
  filesDefining(name) {
    return this.db
      .prepare("SELECT DISTINCT path FROM defs WHERE name = ? ORDER BY path")
      .all(name)
      .map((r) => r.path);
  }
  defsByName(name) {
    return this.db
      .prepare("SELECT path AS file, name, qualname, kind, start_line, end_line, bases, ret FROM defs WHERE name = ? ORDER BY path, start_line")
      .all(name)
      .map((r) => ({ ...r, bases: safeJson(r.bases, []) }));
  }
  refsByName(name, fileFilter) {
    if (fileFilter) {
      return this.db
        .prepare("SELECT path AS file, line FROM refs WHERE name = ? AND path = ?")
        .all(name, fileFilter);
    }
    return this.db.prepare("SELECT path AS file, line FROM refs WHERE name = ?").all(name);
  }
  callsQuery({ callee, caller, file, lang }) {
    const where = [];
    const args = [];
    if (callee !== undefined) {
      where.push("callee = ?");
      args.push(callee);
    }
    if (caller !== undefined) {
      where.push("caller = ?");
      args.push(caller);
    }
    if (file) {
      where.push("path = ?");
      args.push(file);
    }
    if (lang) {
      where.push("lang = ?");
      args.push(lang);
    }
    const sql = `SELECT path AS file, caller, callee, line, recv, lang FROM calls ${
      where.length ? "WHERE " + where.join(" AND ") : ""
    } ORDER BY path, line`;
    return this.db
      .prepare(sql)
      .all(...args)
      .map((r) => ({ ...r, recv: r.recv ?? null }));
  }
  resolveData() {
    const files = this.db
      .prepare("SELECT path, lang, pkg, imports, vartypes FROM files")
      .all()
      .map((r) => ({
        path: r.path,
        lang: r.lang,
        pkg: r.pkg,
        imports: safeJson(r.imports, []),
        vartypes: safeJson(r.vartypes, {}),
      }));
    const defs = this.db
      .prepare("SELECT path AS file, name, qualname, kind, start_line, end_line, bases, ret FROM defs")
      .all()
      .map((r) => ({ ...r, bases: safeJson(r.bases, []) }));
    return { files, defs };
  }
  async flush(root, builtAt, version) {
    const set = this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)");
    this.db.transaction(() => {
      set("root", root);
      set("schema", SCHEMA);
      set("built_at", builtAt);
      set("index_version", version);
    })();
  }
  close() {
    try {
      this.db.close();
    } catch {}
  }
}

export async function openJsonStore(rootAbs, cacheDir, loadLegacy) {
  const json = new JsonStore(jsonPathFor(rootAbs, cacheDir));
  let entries = null;
  try {
    entries = typeof loadLegacy === "function" ? loadLegacy() : null;
  } catch {
    entries = null;
  }
  if (entries) {
    for (const [f, e] of Object.entries(entries)) json.putFile(f, e);
  }
  return json;
}

export async function openStore(rootAbs, cacheDir, loadLegacy) {
  const sqlite = await SqliteStore.open(rootAbs, cacheDir);
  if (sqlite) {
    const legacyPath = jsonPathFor(rootAbs, cacheDir);
    let entries = null;
    try {
      entries = typeof loadLegacy === "function" ? loadLegacy() : null;
    } catch {
      entries = null;
    }
    if (entries) await sqlite.importLegacy(entries, legacyPath);
    return sqlite;
  }
  return openJsonStore(rootAbs, cacheDir, loadLegacy);
}
