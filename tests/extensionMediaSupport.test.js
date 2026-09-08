import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readExtension = (name) => readFileSync(
  new URL(`../chrome-extension/${name}`, import.meta.url),
  "utf8"
);

const background = readExtension("background.js");
const contentScript = readExtension("contentScript.js");
const offscreen = readExtension("offscreen.js");
const manifest = JSON.parse(readExtension("manifest.json"));

describe("extension media completeness", () => {
  it("resolves every ChatGPT API attachment through the current file-link endpoint", () => {
    expect(background).toContain("ChatGPTConversationGraph.fileDownloadEndpoint(");
    expect(background).toContain("currentFileResolverImport(");
    expect(background).toContain("getFileDownloadLink");
    expect(background).toContain("officialResolver.download(fileReference, {");
    expect(background).toContain("officialResolver.resolveOwnership({");
    expect(background).toContain('valueSource.includes("ensureQueryData")');
    expect(background).toContain('cache: "force-cache"');
    expect(background).not.toContain("value.makeQueryOptions(options)");
    expect(background).toContain("ChatGPTConversationGraph.fileInfoEndpoint(");
    expect(background).toContain("effectiveGizmoIdFromFileInfo(");
    expect(background).toContain('"X-OAI-IS-Client-Observation"');
    expect(background).toContain('"X-OpenAI-Target-Path"');
    expect(background).toContain('"X-OpenAI-Target-Route"');
    expect(background).toContain("attachment.fileReference || attachment.fileId");
    expect(background).toContain("checkContextScopesForConversationId: variant.scopedConversation");
    expect(background).toContain("downloadIntent: true");
    expect(background).toContain("downloadIntent: false");
    expect(background).toContain('"inline file request with resolved gizmo context"');
    expect(background).toContain('"download file request without gizmo context"');
    expect(background).toContain('label: "owner-authenticated request"');
    expect(background).toContain('label: "project-header compatibility request"');
    expect(background).toContain("mediaRecoveredByFallback");
    expect(background).toContain("mediaResolvedByCurrentClient");
    expect(background).toContain("ChatGPT current authenticated file client:");
    expect(background).toContain("conversationContext = {}");
    expect(background).toContain("ChatGPTConversationGraph.fileRequestHeaders(headers)");
    expect(background).toContain("attachment.libraryFileId === attachment.fileId");
    expect(background).toContain("timed out after 15 seconds");
    expect(background).toContain("length: Math.min(8, Math.max(1, jobs.length))");
  });

  it("uses authoritative ChatGPT attachment metadata instead of mounted images", () => {
    expect(contentScript).toContain("chatGptAttachmentMarkdown(message)");
    expect(contentScript).toContain("? 'chatgpt-file:' + attachment.fileId");
    expect(contentScript).toContain("if (isChatGPT && chatGptApiMessages) return;");
    expect(contentScript).toContain("enrichChatGptAttachmentsFromRenderedDom(");
    expect(contentScript).toContain("rendered history signed media URL");
    expect(contentScript).toContain("url.searchParams.get('id')");
    expect(contentScript).toContain("renderedChatGptUrlsByFileId");
    expect(contentScript).toContain("sweepRenderedChatGptAttachmentUrls(");
    expect(contentScript).toContain("Media-only ChatGPT sweep finished:");
    expect(contentScript).toContain("same-message rendered media filename match");
    expect(contentScript).toContain("same-message rendered media order match");
    expect(contentScript).toContain("renderedChatGptUrlsByAttachmentKey");
    expect(contentScript).toContain("isChatGptRenderedAttachmentUrl");
    expect(contentScript).toContain("dispatchChatGptHistoryInput");
    expect(contentScript).toContain("chatGptMessageIsMounted");
    expect(contentScript).toContain("ChatGPT rendered file viewer text");
    expect(contentScript).toContain(".content-sheet.popup");
    expect(contentScript).toContain("Math.floor(viewportHeight() * 0.42)");
    expect(contentScript).toContain("restoreTop = originalWasNearBottom");
  });

  it("recognizes markdown uploads and provider file cards with opaque URLs", () => {
    expect(contentScript).toContain("md|markdown");
    expect(contentScript).toContain("data-download-url");
    expect(contentScript).toContain("data-attachment-url");
    expect(contentScript).toContain("elementAttachmentInfo");
    expect(contentScript).toContain("drive-viewer-text-page");
    expect(contentScript).toContain("new Blob([viewerText]");
    expect(contentScript).toContain(".cm-content .cm-line, .monaco-editor .view-line");
    expect(contentScript).toContain("[data-testid*=\"file-preview\"][role=\"dialog\"]");
    expect(contentScript).toContain("URL.createObjectURL(blob)");
  });

  it("captures lazy and CSS-backed images without excluding Gemini Drive media", () => {
    expect(contentScript).toContain("data-srcset");
    expect(contentScript).toContain("element.closest('picture')");
    expect(contentScript).toContain("backgroundMediaUrl");
    expect(contentScript).toContain("child.toDataURL('image/png')");
    expect(contentScript).toContain("child.querySelector('img, picture, video, audio, canvas')");
    expect(contentScript).toContain("const nestedMedia = nodeToMarkdown(child)");
    expect(contentScript).not.toContain(
      "src.includes('drive-thirdparty.googleusercontent.com')"
    );
    expect(contentScript).toContain("data-test-id') === 'luminous-file-icon'");
  });

  it("fetches authenticated same-origin attachments in the provider page", () => {
    expect(contentScript).toContain("new URL(absolute).origin === location.origin");
    expect(contentScript).toContain("credentials: 'include'");
  });

  it("keeps failure counts in Markdown without creating an error report file", () => {
    expect(offscreen).not.toContain("media-fetch-errors.tsv");
    expect(offscreen).toContain("if (data.savedMedia && data.savedMedia.length > 0)");
    expect(offscreen).toContain("media_count: ' + data.savedMedia.length");
    expect(offscreen).toContain("exporter_version:");
    expect(offscreen).toContain("history_status:");
    expect(offscreen).not.toContain("chatgpt_history_root_reached:");
  });

  it("keeps large archives out of extension messages and bounds media fetches", () => {
    expect(offscreen).toContain("URL.createObjectURL(zipBlob)");
    expect(offscreen).toContain("URL.createObjectURL(mdBlob)");
    expect(offscreen).toContain("REMOTE_MEDIA_CONCURRENCY = 4");
    expect(offscreen).toContain("REMOTE_MEDIA_TIMEOUT_MS = 60 * 1000");
    expect(offscreen).toContain("media.blob instanceof Blob");
    expect(offscreen).not.toContain("reader.readAsDataURL(zipBlob)");
    expect(offscreen).not.toContain("reader.readAsDataURL(mdBlob)");
    expect(background).toContain("offscreenResponse.downloadUrl || offscreenResponse.dataUrl");
    expect(background).toContain('{ action: "revokeBlobUrl", url: packagedUrl }');
    expect(background).toContain("reasons: ['DOM_PARSER', 'BLOBS']");
  });

  it("grants fetch access only to the providers and their known media CDNs", () => {
    expect(manifest.version).toBe("0.2.0");
    expect(manifest.host_permissions).toEqual(expect.arrayContaining([
      "https://www.google.com/*",
      "*://*.oaiusercontent.com/*",
      "*://*.googleusercontent.com/*",
      "*://*.claudeusercontent.com/*",
      "*://*.x.ai/*",
      "*://*.blob.core.windows.net/*",
    ]));
    expect(manifest.host_permissions).not.toContain("<all_urls>");
  });
});
