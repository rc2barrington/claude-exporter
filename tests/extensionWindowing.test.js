import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const background = readFileSync(
  new URL("../chrome-extension/background.js", import.meta.url),
  "utf8"
);
const contentScript = readFileSync(
  new URL("../chrome-extension/contentScript.js", import.meta.url),
  "utf8"
);
const popup = readFileSync(
  new URL("../chrome-extension/popup.js", import.meta.url),
  "utf8"
);
const popupHtml = readFileSync(
  new URL("../chrome-extension/popup.html", import.meta.url),
  "utf8"
);
const chatGptConversation = readFileSync(
  new URL("../chrome-extension/chatgptConversation.js", import.meta.url),
  "utf8"
);

describe("Chrome extension export isolation", () => {
  it.each([
    ["create a temporary window", "chrome.windows.create("],
    ["move a chat tab", "chrome.tabs.move("],
    ["focus or activate a chat tab", "chrome.tabs.update("],
    ["remove a Chrome window", "chrome.windows.remove("],
  ])("does not %s", (_description, forbiddenCall) => {
    expect(background).not.toContain(forbiddenCall);
  });

  it("has no aggregate deadline on scraping, packaging, or download", () => {
    expect(background).not.toContain("Export timed out after 15 minutes.");
    expect(background).not.toContain("Packaging timed out after 30 minutes.");
    expect(background).not.toContain("Download timed out after 5 minutes.");
    expect(background).not.toContain("ChatGPT chain request timed out after 10 minutes.");
  });

  it("cancels every active export phase without waiting for polling", () => {
    expect(background).toContain("activeExportAbortController.abort()");
    expect(background).toContain('action: "cancelOffscreenExport"');
    expect(background).toContain('"__aiChatExporterCancel"');
    expect(background).toContain("installTabCancellationBridge(tabId)");
    expect(background).toContain('data-ai-chat-exporter-cancelled-run');
    expect(background).toContain("chrome.downloads.cancel(activeDownloadId");
    expect(background).toContain('signal.addEventListener("abort", onAbort, { once: true })');
    expect(contentScript).toContain("abortController.abort()");
    expect(contentScript).toContain(
      "document.removeEventListener('__exportCancel', onExportCancel);"
    );
    expect(popup).toContain('cancelBtn.textContent = cancelRequested ? "Stopping..."');
    expect(popup).toContain("isCancelling");
  });

  it("does not report a failed per-tab export as a successful batch", () => {
    expect(background).toContain(
      "${failedExports} chat export(s) failed; ${successfulExports} completed successfully."
    );
  });

  it("uses the authoritative chain for text and isolates any scrolling to media recovery", () => {
    expect(contentScript).toContain(
      "Active ChatGPT chain loaded: ${chatGptApiMessages.length} messages. Text history scrolling is not needed."
    );
    expect(contentScript).toContain("sweepRenderedChatGptAttachmentUrls(chatGptApiMessages)");
  });

  it("loads ChatGPT history in page context without activating the tab", () => {
    expect(background).toContain('world: "MAIN"');
    expect(background).toContain('fetch("/api/auth/session"');
    expect(background).toContain('requiredHeaders.Authorization = "Bearer " + accessToken');
    expect(background).toContain("ChatGPTConversationGraph.accountHeader(account)");
    expect(background).toContain('"OAI-Web-Deployment-Attestation"');
    expect(background).toContain("ChatGPT page authentication: ${result.authentication}.");
    expect(background).toContain("chatGptContext: chatGptContext");
    expect(contentScript).toContain(
      "No file was created because a partial history is not a valid export."
    );
  });

  it("uses ChatGPT's paginated web route instead of the rejected privileged route", () => {
    expect(chatGptConversation).toContain('"/backend-api/conversations/" + id');
    expect(chatGptConversation).toContain('"/messages?before="');
    expect(chatGptConversation).toContain('"&include_has_versions=true&num_turns="');
    expect(chatGptConversation).not.toContain("include_full_conversation");
    expect(chatGptConversation).not.toContain("/backend-api/f/conversation/");
  });

  it("canonicalizes project slugs and avoids the duplicate unauthenticated retry", () => {
    expect(background).toContain("routeEntityId.match(/^(g-p-[0-9a-f]{32})(?:-|$)/i)");
    expect(contentScript).toContain(
      "Authenticated ChatGPT chain request failed; skipping the unauthenticated duplicate retry."
    );
  });

  it("carries the popup-discovered URL into the background worker", () => {
    expect(popup).toContain("tabDetails: targets");
    expect(background).toContain("AIChatExporterSelection.requestedTargets(request)");
    expect(popup).toContain("tab.url || tab.pendingUrl");
    expect(background).toContain("|| discoveredUrl");
  });

  it("locks one exact selection snapshot across popup reopenings", () => {
    expect(popupHtml.indexOf('src="exportSelection.js"')).toBeLessThan(
      popupHtml.indexOf('src="popup.js"')
    );
    expect(background).toContain('importScripts("exportSelection.js")');
    expect(popup).toContain("activeBatchTargetIds = new Set(response.targetTabIds || targetTabIds)");
    expect(popup).toContain("element.disabled = popupExporting");
    expect(popup).toContain("visibleSelection = popupExporting");
    expect(background).toContain("An export batch is already running");
    expect(background).toContain("activeTargetIds: activeExportTargetIds.slice()");
  });

  it("starts every new idle popup with every chat unchecked", () => {
    expect(popup).toContain("createSelectionState([])");
    expect(popup).toContain(": selection.ids()");
    expect(popup).toContain('chrome.storage.local.remove("selectedTabIds"');
    expect(popup).not.toContain("chrome.storage.local.get");
    expect(popup).not.toContain("chrome.storage.local.set");
    expect(popup).toContain("if (!popupExporting) selection.replace([])");
    expect(popup).toContain('type="checkbox" autocomplete="off" class="tab-checkbox tab-select"');
  });

  it("keeps per-tab errors visible until the batch actually finishes", () => {
    expect(popup).toContain('request.message.startsWith("Batch export failed:")');
    expect(popup).not.toContain('request.type === "error"');
    expect(popup).not.toContain("AI hosts:");
  });
});
