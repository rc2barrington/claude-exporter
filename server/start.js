import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { localSessionsMiddleware } from "./localSessions.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const port = Number(process.env.AI_EXPORTER_PORT || 4178);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("AI_EXPORTER_PORT must be an integer from 1024 through 65535.");
const address = `http://127.0.0.1:${port}/ai-chat-exporter/`;
const api = localSessionsMiddleware();
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".zip": "application/zip", ".png": "image/png" };
const server = http.createServer((req, res) => {
  api(req, res, async () => {
    try {
      const url = new URL(req.url, address);
      const relative = decodeURIComponent(url.pathname).replace(/^\/ai-chat-exporter\/?/, "");
      const filename = path.resolve(root, relative || "index.html");
      if (filename !== root && !filename.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const file = (await stat(filename)).isDirectory() ? path.join(filename, "index.html") : filename;
      res.setHeader("Content-Type", mime[path.extname(file)] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end("File not found. Build the app first with npm run build."); }
  });
});
function openBrowser() { if (process.argv.includes("--open")) spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [address], { stdio: "ignore" }).on("error", () => {}); }
server.on("error", error => { console.error(error.code === "EADDRINUSE" ? `The local app is already running at ${address}` : error.message); if (error.code === "EADDRINUSE") openBrowser(); process.exitCode = error.code === "EADDRINUSE" ? 0 : 1; });
server.listen(port, "127.0.0.1", () => { console.log(`AI Chat Exporter is ready: ${address}\nKeep this window open while exporting. Press Ctrl+C to stop.`); openBrowser(); });
