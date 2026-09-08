import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import "../chrome-extension/exportCore.js";

const output = path.resolve("dist/downloads");
await mkdir(output, { recursive: true });
async function addTree(zip, directory, prefix = directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.name === "downloads" || item.isSymbolicLink()) continue;
    const filename = path.join(directory, item.name);
    const name = prefix + "/" + item.name;
    if (item.isDirectory()) await addTree(zip, filename, name);
    else zip.file(name, await readFile(filename), { unixPermissions: item.name.endsWith(".command") ? "100755" : "100644" });
  }
}
const extension = new JSZip();
await addTree(extension, "chrome-extension", "ai-chat-exporter-extension");
globalThis.AIChatExporterCore.stampZip(extension);
await writeFile(path.join(output, "ai-chat-exporter-extension.zip"), await extension.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" }));
const local = new JSZip();
for (const directory of ["dist", "server", "src/parsers"]) await addTree(local, directory, "ai-chat-exporter-local/" + directory);
local.file("ai-chat-exporter-local/dist/downloads/ai-chat-exporter-extension.zip", await readFile(path.join(output, "ai-chat-exporter-extension.zip")));
local.file("ai-chat-exporter-local/Open AI Chat Exporter.command", await readFile("Open AI Chat Exporter.command"), { unixPermissions: "100755" });
local.file("ai-chat-exporter-local/START HERE.txt", "Unzip this folder. Double-click Open AI Chat Exporter.command. Requires Node.js 22.13 or newer: https://nodejs.org/en/download\n\nThe app runs only on this computer. Choose Codex or OpenCode to find saved chats. No terminal commands or npm install are needed. Keep the launcher window open while using the app.\n");
globalThis.AIChatExporterCore.stampZip(local);
await writeFile(path.join(output, "ai-chat-exporter-local.zip"), await local.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" }));
console.log("Built extension and local app downloads with current file and folder timestamps.");
