import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseCodexJsonl } from "../src/parsers/codexJsonl.js";
import { parseOpenCode } from "../src/parsers/opencode.js";

export function createLocalSessions({ codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex"),
  openCodeHome = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode") } = {}) {
  const files = new Map();
  const attachmentLists = new Map();
  async function database(fn) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(openCodeHome, "opencode.db"), { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  }
  async function list(source) {
    if (source === "opencode") return database(db => db.prepare(
      "SELECT id,title,time_created,time_updated FROM session ORDER BY time_updated DESC"
    ).all().map(s => ({ id: s.id, title: s.title, updatedAt: new Date(s.time_updated).toISOString() })));
    if (source !== "codex") throw new Error("Unsupported local source.");
    files.clear();
    const titles = new Map();
    try {
      const databases = (await readdir(codexHome)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      if (databases.length) {
        const { DatabaseSync } = await import("node:sqlite");
        const index = new DatabaseSync(path.join(codexHome, databases[0]), { readOnly: true });
        try { for (const row of index.prepare("SELECT id,title FROM threads").all()) if (row.title) titles.set(row.id, row.title); }
        finally { index.close(); }
      }
    } catch { /* Older Codex versions may only have the JSONL session index. */ }
    try {
      for (const line of (await readFile(path.join(codexHome, "session_index.jsonl"), "utf8")).split("\n")) {
        try { const row = JSON.parse(line); if (!titles.has(row.id) && row.thread_name) titles.set(row.id, row.thread_name); } catch { /* partial final line */ }
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const results = [];
    async function walk(dir, root) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const filename = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(filename, root);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const id = createHash("sha256").update(filename).digest("hex");
          const sessionID = entry.name.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0];
          const details = await stat(filename);
          files.set(id, { filename, root, title: titles.get(sessionID) });
          results.push({ id, title: titles.get(sessionID) || entry.name, updatedAt: details.mtime.toISOString() });
        }
      }
    }
    for (const name of ["sessions", "archived_sessions"]) {
      try { const root = await realpath(path.join(codexHome, name)); await walk(root, root); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function get(source, id) {
    if (source === "opencode") return database(db => {
      db.exec("BEGIN");
      try {
        const row = db.prepare("SELECT * FROM session WHERE id=?").get(id);
        if (!row) throw new Error("Session not found.");
        const entries = db.prepare("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id").all(id);
        const parts = db.prepare("SELECT message_id,data FROM part WHERE session_id=? ORDER BY time_created,id").all(id);
        const byMessage = new Map();
        for (const part of parts) {
          if (!byMessage.has(part.message_id)) byMessage.set(part.message_id, []);
          byMessage.get(part.message_id).push(JSON.parse(part.data));
        }
        return parseOpenCode({ info: { ...row, time: { created: row.time_created, updated: row.time_updated },
          revert: row.revert ? JSON.parse(row.revert) : null },
        messages: entries.map(m => ({ info: { ...JSON.parse(m.data), id: m.id }, parts: byMessage.get(m.id) || [] })) });
      } finally { db.exec("ROLLBACK"); }
    });
    if (source !== "codex") throw new Error("Unsupported local source.");
    const file = files.get(id);
    if (!file) throw new Error("Scan sessions again before opening this session.");
    const resolved = await realpath(file.filename);
    if (!resolved.startsWith(file.root + path.sep)) throw new Error("Session path is outside its storage folder.");
    return parseCodexJsonl(await readFile(resolved, "utf8"), { fileName: path.basename(resolved), title: file.title });
  }
  async function open(source, id) {
    const session = await get(source, id);
    attachmentLists.set(source + ":" + id, session.attachments || []);
    return session;
  }
  async function attachment(source, id, index) {
    const entry = attachmentLists.get(source + ":" + id)?.[index];
    if (!entry || !entry.url.startsWith("file:")) throw new Error("This attachment is not available as a local file. Open the session again.");
    const filename = await realpath(fileURLToPath(entry.url));
    if (!(await stat(filename)).isFile()) throw new Error("Attachment is not a file.");
    return { bytes: await readFile(filename), type: entry.mime || "application/octet-stream" };
  }
  return { list, get: open, attachment };
}

export function localSessionsMiddleware(store = createLocalSessions()) {
  return async (req, res, next) => {
    if (!req.url.startsWith("/api/local-sessions")) return next();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const host = req.headers.host || "";
    const origin = req.headers.origin;
    if (!/^127\.0\.0\.1:\d+$/.test(host) || (origin && origin !== `http://${host}`) ||
        req.headers["x-ai-exporter"] !== "local-sessions" || req.method !== "GET") {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: "Only the local exporter can read sessions." }));
    }
    try {
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname !== "/api/local-sessions") throw new Error("Unknown endpoint.");
      const source = url.searchParams.get("source");
      const id = url.searchParams.get("id");
      if (url.searchParams.has("attachment")) {
        const index = url.searchParams.get("attachment");
        if (!id || !/^\d+$/.test(index)) throw new Error("Invalid attachment request.");
        const file = await store.attachment(source, id, Number(index));
        res.setHeader("Content-Type", file.type);
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.end(file.bytes);
      }
      res.end(JSON.stringify(id ? await store.get(source, id) : await store.list(source)));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error.code === "ENOENT" ? "No local session storage found for this source." : error.message }));
    }
  };
}
