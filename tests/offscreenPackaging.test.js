import { readFileSync } from "node:fs";
import vm from "node:vm";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import "../chrome-extension/exportCore.js";
import "../chrome-extension/exportTransport.js";

const source = readFileSync(
  new URL("../chrome-extension/offscreen.js", import.meta.url),
  "utf8"
);

describe("offscreen packaging", () => {
  it("packages chunked transfers with exact deduplication and authoritative history status", async () => {
    let onMessage, blob;
    const context = {
      AbortController, Blob, console, fetch, JSZip, setTimeout, clearTimeout,
      AIChatExporterCore: globalThis.AIChatExporterCore,
      AIChatExporterTransport: globalThis.AIChatExporterTransport,
      setInterval: () => 1,
      URL: { createObjectURL(value) { blob = value; return "blob:test/integration"; } },
      chrome: { runtime: {
        connect: () => ({ onDisconnect: { addListener() {} } }),
        onMessage: { addListener(fn) { onMessage = fn; } },
        sendMessage(_request, callback) { callback?.(); },
      } },
    };
    vm.runInNewContext(source, context);
    const request = data => new Promise(resolve => onMessage(data, {}, resolve));
    await globalThis.AIChatExporterTransport.send({ title: "Complete", siteName: "ChatGPT", messageCount: 1,
      history: { status: "complete", basis: "Authoritative chain" },
      mediaDiagnostics: { historyRootReached: false },
      messages: [{ role: "## You", text: "FIRST ![one](media/a.png) ![two](media/b.png) LAST" }],
      savedMedia: ["a.png", "b.png"].map(filename => ({ filename, type: "image/png", base64: "YWJj" })),
    }, "test", request);
    const response = await request({ action: "zipAndDownload", transferId: "test", options: { includeMedia: true } });
    expect(response.status).toBe("success");
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["conversation.md", "media/", "media/a.png"]);
    const text = await zip.file("conversation.md").async("string");
    expect(text).toContain("history_status: complete");
    expect(text).not.toContain("false");
    expect(text).toContain("FIRST ![one](media/a.png) ![two](media/a.png) LAST");
    expect(await zip.file("media/a.png").async("string")).toBe("abc");
  });
  it("creates only conversation.md and saved media, never an error-report entry", async () => {
    let onMessage;
    let createdBlob;
    const context = {
      AbortController, Blob, console, fetch, JSZip, setTimeout, clearTimeout,
      setInterval: () => 1,
      URL: { createObjectURL(blob) { createdBlob = blob; return "blob:test/zip"; }, revokeObjectURL() {} },
      chrome: { runtime: {
        connect() { return { onDisconnect: { addListener() {} }, postMessage() {} }; },
        onMessage: { addListener(fn) { onMessage = fn; } },
        sendMessage(_message, callback) { callback?.(); },
      } },
    };
    vm.runInNewContext(source, context);
    const response = await new Promise(resolve => onMessage({ action: "zipAndDownload", options: { includeMedia: true }, data: {
      title: "Mixed media", siteName: "Google AI Mode", date: new Date().toISOString(), messageCount: 1,
      messages: [{ role: "## You", text: "![Saved](media/saved.txt) ![Missing](media/missing.png)" }],
      savedMedia: [{ filename: "saved.txt", base64: "aGVsbG8=" }], remoteQueue: [],
      failedFetches: [{ filename: "missing.png", url: "https://example.test/missing.png", error: "HTTP 404" }],
    } }, {}, resolve));
    expect(response.status).toBe("success");
    expect(response.filename).toMatch(/\.zip$/);
    const zip = await JSZip.loadAsync(await createdBlob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["conversation.md", "media/", "media/saved.txt"]);
    expect(await zip.file("media/saved.txt").async("string")).toBe("hello");
    expect(await zip.file("conversation.md").async("string")).toContain("https://example.test/missing.png");
  });

  it.each([false, true])("returns Markdown when no media was saved (failed attachments: %s)", async (failures) => {
    let onMessage;
    let createdBlob;
    const context = {
      AbortController,
      Blob,
      console,
      fetch,
      FileReader: class {},
      JSZip,
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      URL: {
        createObjectURL(blob) {
          createdBlob = blob;
          return "blob:extension-test/large-export";
        },
        revokeObjectURL() {},
      },
      chrome: {
        runtime: {
          lastError: null,
          connect() {
            return {
              onDisconnect: { addListener() {} },
              postMessage() {},
            };
          },
          onMessage: {
            addListener(listener) {
              onMessage = listener;
            },
          },
          sendMessage(_message, callback) {
            if (callback) callback();
          },
        },
      },
    };
    vm.runInNewContext(source, context, { filename: "offscreen.js" });

    const response = await new Promise((resolve, reject) => {
      const keepChannelOpen = onMessage({
        action: "zipAndDownload",
        options: { includeMedia: failures },
        data: {
          title: "Synthetic long chat",
          siteName: "ChatGPT",
          date: "2026-08-23T00:00:00.000Z",
          messageCount: 1,
          messages: [{ role: "## You", text: "x".repeat(2_000_000) }],
          savedMedia: [],
          remoteQueue: [],
          failedFetches: failures ? [{ filename: "missing.png", url: "https://example.test/missing.png", error: "HTTP 404" }] : [],
        },
      }, {}, resolve);
      if (keepChannelOpen !== true) reject(new Error("message channel did not stay open"));
    });

    expect(response).toMatchObject({
      status: "success",
      downloadUrl: "blob:extension-test/large-export",
      filename: "synthetic-long-chat.md",
    });
    expect(response).not.toHaveProperty("dataUrl");
    expect(createdBlob).toBeInstanceOf(Blob);
    expect(createdBlob.size).toBeGreaterThan(2_000_000);
  });

  it("aborts an in-flight remote media request and creates no file", async () => {
    let onMessage;
    let fetchedSignal;
    let createdObjectUrl = false;
    const context = {
      AbortController,
      Blob,
      console,
      fetch(_url, options) {
        fetchedSignal = options.signal;
        return new Promise((resolve, reject) => {
          const rejectAsAborted = () => {
            const error = new Error("request aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (fetchedSignal.aborted) rejectAsAborted();
          else fetchedSignal.addEventListener("abort", rejectAsAborted, { once: true });
        });
      },
      FileReader: class {},
      JSZip,
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      URL: {
        createObjectURL() {
          createdObjectUrl = true;
          return "blob:extension-test/should-not-exist";
        },
        revokeObjectURL() {},
      },
      chrome: {
        runtime: {
          lastError: null,
          connect() {
            return {
              onDisconnect: { addListener() {} },
              postMessage() {},
            };
          },
          onMessage: {
            addListener(listener) {
              onMessage = listener;
            },
          },
          sendMessage(_message, callback) {
            if (callback) callback();
          },
        },
      },
    };
    vm.runInNewContext(source, context, { filename: "offscreen.js" });

    const packageResponse = new Promise(resolve => {
      const keepChannelOpen = onMessage({
        action: "zipAndDownload",
        runId: 41,
        options: { includeMedia: true },
        data: {
          title: "Cancelled chat",
          siteName: "ChatGPT",
          date: "2026-08-23T00:00:00.000Z",
          messageCount: 1,
          messages: [{ role: "## You", text: "attachment" }],
          savedMedia: [],
          remoteQueue: [{
            url: "https://example.test/stalled-image.png",
            filename: "stalled-image.png",
          }],
          failedFetches: [],
        },
      }, {}, resolve);
      expect(keepChannelOpen).toBe(true);
    });

    const staleCancelResponse = await new Promise(resolve => {
      const keepChannelOpen = onMessage({
        action: "cancelOffscreenExport",
        runId: "stale-run",
      }, {}, resolve);
      expect(keepChannelOpen).toBe(true);
    });
    expect(staleCancelResponse).toEqual({ status: "idle" });
    expect(fetchedSignal.aborted).toBe(false);

    const cancelResponse = await new Promise(resolve => {
      const keepChannelOpen = onMessage({
        action: "cancelOffscreenExport",
        runId: 41,
      }, {}, resolve);
      expect(keepChannelOpen).toBe(true);
    });

    await expect(packageResponse).resolves.toMatchObject({
      status: "cancelled",
      error: "Export cancelled.",
    });
    expect(cancelResponse).toEqual({ status: "cancelling" });
    expect(fetchedSignal.aborted).toBe(true);
    expect(createdObjectUrl).toBe(false);
  });
});
