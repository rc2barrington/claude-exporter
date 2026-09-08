import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import JSZip from "jszip";

// Test the actual shipped Mac archive, outside the repo and without node_modules.
if (process.platform !== "darwin") { console.log("Mac extraction check is only needed on macOS."); process.exit(0); }
const directory = await mkdtemp(path.join(tmpdir(), "ai-exporter-distribution-"));
let child;
try {
  const archive = path.resolve("dist/downloads/ai-chat-exporter-local.zip");
  execFileSync("ditto", ["-x", "-k", archive, directory]);
  const root = path.join(directory, "ai-chat-exporter-local");
  const zip = await JSZip.loadAsync(await readFile(archive));
  for (const entry of Object.values(zip.files)) {
    const info = await stat(path.join(directory, entry.name));
    assert.ok(Math.abs(Date.now() - info.mtimeMs) < 10 * 60 * 1000, `Unexpected extracted date: ${entry.name}`);
  }
  const launcher = await stat(path.join(root, "Open AI Chat Exporter.command"));
  assert.ok(launcher.mode & 0o100, "Launcher must be executable");
  child = spawn(process.execPath, ["server/start.js"], { cwd: root, env: { ...process.env, AI_EXPORTER_PORT: "4189" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Packaged server did not start")), 10000);
    child.stdout.on("data", bytes => { if (bytes.toString().includes("is ready")) { clearTimeout(timer); resolve(); } });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Packaged server exited: ${code}`)); });
    child.once("error", reject);
  });
  const base = "http://127.0.0.1:4189";
  const html = await (await fetch(base + "/ai-chat-exporter/")).text();
  assert.ok(html.includes("AI Chat Exporter"));
  for (const asset of html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)) assert.equal((await fetch(base + asset[1])).status, 200);
  assert.equal((await fetch(base + "/ai-chat-exporter/downloads/ai-chat-exporter-extension.zip")).status, 200);
  for (const source of ["codex", "opencode"]) {
    const response = await fetch(base + "/api/local-sessions?source=" + source, { headers: { "X-AI-Exporter": "local-sessions" } });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.ok(Array.isArray(data));
    console.log(`${source}: packaged app discovered ${data.length} sessions (metadata only).`);
  }
  assert.equal((await fetch(base + "/api/local-sessions?source=codex")).status, 403);
  console.log("Extracted timestamps, executable launcher, standalone server, assets, downloads and access checks passed.");
} finally {
  if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; }
  await rm(directory, { recursive: true, force: true });
}
