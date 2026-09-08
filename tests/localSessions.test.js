import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createLocalSessions, localSessionsMiddleware } from "../server/localSessions.js";

const tempPaths = [];
afterEach(async () => { for (const dir of tempPaths.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe("local discovery", () => {
  it("reads only structured attachments from an opened session, including Markdown files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exporter-attachment-test-")); tempPaths.push(root);
    await mkdir(path.join(root, "sessions"));
    const attachment = path.join(root, "notes.md");
    await writeFile(attachment, "# Complete uploaded document\nLast line");
    await writeFile(path.join(root, "sessions", "test.jsonl"), JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_file", url: pathToFileURL(attachment).href, filename: "notes.md" }] } }));
    const store = createLocalSessions({ codexHome: root });
    const [item] = await store.list("codex");
    await expect(store.attachment("codex", item.id, 0)).rejects.toThrow(/not available/);
    const session = await store.get("codex", item.id);
    expect(session.attachments[0].label).toBe("notes.md");
    const file = await store.attachment("codex", item.id, 0);
    expect(file.bytes.toString()).toBe("# Complete uploaded document\nLast line");
    await expect(store.attachment("codex", item.id, "../../secret")).rejects.toThrow(/not available/);
  });
  it("reads the installed OpenCode SQLite schema into an ordered export", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exporter-db-test-")); tempPaths.push(root);
    const db = new DatabaseSync(path.join(root, "opencode.db"));
    db.exec("CREATE TABLE session(id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,revert TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);");
    db.prepare("INSERT INTO session VALUES(?,?,?,?,?)").run("s1", "Test session", 1000, 2000, null);
    for (const [id, role, text, time] of [["m2", "assistant", "Answer", 2], ["m1", "user", "First prompt", 1]]) {
      db.prepare("INSERT INTO message VALUES(?,?,?,?)").run(id, "s1", time, JSON.stringify({ role }));
      db.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("p" + id, id, "s1", time, JSON.stringify({ type: "text", text }));
    }
    db.close();
    const store = createLocalSessions({ openCodeHome: root });
    expect(await store.list("opencode")).toEqual([{ id: "s1", title: "Test session", updatedAt: "1970-01-01T00:00:02.000Z" }]);
    const parsed = await store.get("opencode", "s1");
    expect(parsed.messages.map(m => m.blocks[0].text)).toEqual(["First prompt", "Answer"]);
    await expect(store.get("opencode", "s1' OR 1=1")).rejects.toThrow(/not found/);
  });
  it("scans only session roots, lists metadata, then reads the selected session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exporter-test-")); tempPaths.push(root);
    await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", "test.jsonl"), JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "First prompt" }] } }));
    await writeFile(path.join(root, "auth.jsonl"), "DO NOT READ");
    await symlink(path.join(root, "auth.jsonl"), path.join(root, "sessions", "link.jsonl"));
    const store = createLocalSessions({ codexHome: root });
    const list = await store.list("codex");
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("First prompt");
    expect((await store.get("codex", list[0].id)).messages[0].blocks[0].text).toBe("First prompt");
    await expect(store.get("codex", "../../auth.jsonl")).rejects.toThrow(/Scan sessions/);
    await expect(store.list("claude")).rejects.toThrow(/Unsupported/);
  });
  it.each([
    { host: "evil.test:5173", "x-ai-exporter": "local-sessions" },
    { host: "127.0.0.1:5173", origin: "https://evil.test", "x-ai-exporter": "local-sessions" },
    { host: "127.0.0.1:5173" },
  ])("rejects foreign origins, DNS rebinding, and requests without the private header", async headers => {
    let body;
    const res = { setHeader() {}, end(value) { body = value; } };
    await localSessionsMiddleware({ list() { throw new Error("should never read"); } })({ headers, method: "GET", url: "/api/local-sessions?source=codex" }, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(body).error).toMatch(/Only the local exporter/);
  });
});
