// Background Service Worker for AI Chat Exporter Chrome Extension
// Coordinates in-place tab scraping and delegates zipping/downloading to an offscreen document.

importScripts("exportSelection.js");

let isCancelled = false;
let isExporting = false;
let currentExportTabId = null;
let activeExportTargetIds = [];
let activeExportRunId = null;
let activeExportAbortController = null;
let activeDownloadId = null;
let nextExportRunId = 0;
let logsList = [];

// Log status message and cache it, then broadcast to popup if open
function logProgress(message, type = "info") {
  const time = new Date().toLocaleTimeString();
  console.log(`[${type.toUpperCase()}] [${time}] ${message}`);

  // Store the log in logsList
  logsList.push({ message, type, time });
  if (logsList.length > 200) {
    logsList.shift();
  }

  try {
    chrome.runtime.sendMessage({
      action: "progress",
      message: message,
      type: type,
      time: time
    }, () => {
      // Reading lastError silences the "Unchecked runtime.lastError" warning when the popup is closed.
      void chrome.runtime.lastError;
    });
  } catch (err) {
    console.error("Failed to send progress message:", err);
  }
}

// Create the offscreen document context for DOM-based zipping and downloads
async function setupOffscreenDocument(path) {
  try {
    await chrome.offscreen.createDocument({
      url: path,
      reasons: ['DOM_PARSER', 'BLOBS'],
      justification: 'Fetch remote files, compile JSZip, and create a temporary blob URL for download'
    });
  } catch (err) {
    // If it already exists, ignore the error
    if (err && err.message && !err.message.includes("Only a single offscreen document may be created")) {
      throw err;
    }
  }
}

// Close the offscreen document context
async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (err) {
    // Ignore error if already closed
  }
}

function exportCancellationError(message = "Export cancelled.") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "EXPORT_CANCELLED";
  return error;
}

function isExportCancellation(error) {
  return !!(
    isCancelled ||
    activeExportAbortController && activeExportAbortController.signal.aborted ||
    error && error.code === "EXPORT_CANCELLED" ||
    /export cancel(?:led|lation)/i.test(String(error && error.message || error || ""))
  );
}

function throwIfExportCancelled(signal) {
  if (isCancelled || signal && signal.aborted) {
    throw exportCancellationError();
  }
}

function createExportRunId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${++nextExportRunId}-${Math.random().toString(36).slice(2)}`;
}

function signalTabCancellation(tabId, runId) {
  if (!Number.isInteger(tabId)) return;

  // Stop the isolated-world scraper and all of its fetches and sleeps.
  try {
    chrome.tabs.sendMessage(tabId, { action: "cancelExport", runId }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {}

  // ChatGPT history and attachment discovery run in the page's MAIN world,
  // before the scraper is injected. Persist the run id as well as dispatching
  // an event, so a cancellation cannot be lost in the tiny race before the
  // MAIN-world listener has attached.
  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [runId],
    func: cancelledRunId => {
      globalThis.__aiChatExporterCancelledRunId = cancelledRunId;
      if (document.documentElement) {
        document.documentElement.setAttribute(
          "data-ai-chat-exporter-cancelled-run",
          String(cancelledRunId)
        );
      }
      try {
        document.dispatchEvent(new CustomEvent(
          "__aiChatExporterCancel",
          { detail: cancelledRunId }
        ));
      } catch (error) {}
      try { document.dispatchEvent(new Event("__exportCancel")); } catch (error) {}
    },
  }).catch(() => {});
}

async function installTabCancellationBridge(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [2],
    func: bridgeVersion => {
      if (globalThis.__aiChatExporterCancelBridgeVersion === bridgeVersion) return;
      globalThis.__aiChatExporterCancelBridgeVersion = bridgeVersion;
      let chainParts = [];
      document.addEventListener("__aiChatExporterChainPart", event => {
        const part = JSON.parse(event.detail);
        if (part.begin) {
          globalThis.__aiChatExporterPreloadedChain = { runId: part.runId, messages: [] };
          chainParts = [];
          return;
        }
        const chain = globalThis.__aiChatExporterPreloadedChain;
        if (!chain || chain.runId !== part.runId) return;
        chainParts.push(part.chunk);
        if (part.last) {
          chain.messages.push(JSON.parse(chainParts.join("")));
          chainParts = [];
        }
      });
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!request || request.action !== "cancelExport") return;
        if (request.runId !== undefined && document.documentElement) {
          document.documentElement.setAttribute(
            "data-ai-chat-exporter-cancelled-run",
            String(request.runId)
          );
        }
        try {
          document.dispatchEvent(new CustomEvent(
            "__aiChatExporterCancel",
            { detail: request.runId }
          ));
        } catch (error) {}
        try { document.dispatchEvent(new Event("__exportCancel")); } catch (error) {}
        sendResponse({ status: "cancelled" });
      });
    },
  });
}

function signalOffscreenCancellation(runId) {
  // The offscreen document owns remote media requests and ZIP generation.
  // Send its AbortController a signal, then close the document as a hard stop
  // for any JSZip work that was already queued.
  try {
    chrome.runtime.sendMessage({
      action: "cancelOffscreenExport",
      runId,
    }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {}
  void closeOffscreenDocument();
}

function cancelActiveExport() {
  if (!isExporting) return false;
  if (isCancelled) return true;

  isCancelled = true;
  logProgress("Cancellation accepted. Stopping the active export now...", "info");

  if (activeExportAbortController && !activeExportAbortController.signal.aborted) {
    activeExportAbortController.abort();
  }
  signalTabCancellation(currentExportTabId, activeExportRunId);
  signalOffscreenCancellation(activeExportRunId);

  if (activeDownloadId !== null) {
    chrome.downloads.cancel(activeDownloadId, () => {
      void chrome.runtime.lastError;
    });
  }
  return true;
}

function finishExportRun(runId, error) {
  if (activeExportRunId !== runId) return;

  const cancelled = isExportCancellation(error);
  isExporting = false;
  activeExportTargetIds = [];
  activeExportRunId = null;
  activeExportAbortController = null;
  activeDownloadId = null;
  currentExportTabId = null;

  if (cancelled) {
    logProgress("Batch export was cancelled.", "info");
  } else if (error) {
    logProgress(`Batch export failed: ${error.message || error}`, "error");
  } else {
    logProgress("Batch export sequence completed.", "success");
  }
}

function chatGptConversationInfo(url) {
  try {
    const parsed = new URL(url || "");
    if (!/(^|\.)(chatgpt\.com|chat\.openai\.com)$/.test(parsed.hostname)) return null;
    const conversationId = (parsed.pathname.match(/\/c\/([^/?#]+)/) || [])[1] || null;
    if (!conversationId) return null;
    const routeEntityId = (parsed.pathname.match(/\/g\/([^/?#]+)\/c\//) || [])[1] || null;
    const projectMatch = routeEntityId && routeEntityId.match(/^(g-p-[0-9a-f]{32})(?:-|$)/i);
    const projectId = projectMatch ? projectMatch[1] : null;
    return { conversationId, projectId };
  } catch (error) {
    return null;
  }
}

async function preloadChatGptChain(tabId, tabUrl, tabTitle, includeMedia, runId) {
  let info = chatGptConversationInfo(tabUrl);
  try {
    // Prefer the page's live location over any cached tabs API value. This is
    // both the fallback for an occluded cross-window tab whose URL was omitted
    // and protection against exporting a URL the tab has since navigated away
    // from. executeScript does not activate or focus the target tab.
    const [locationResult] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const isChatGpt = /(^|\.)(chatgpt\.com|chat\.openai\.com)$/.test(location.hostname);
        if (!isChatGpt) return null;
        const conversationId = (location.pathname.match(/\/c\/([^/?#]+)/) || [])[1] || null;
        const routeEntityId = (location.pathname.match(/\/g\/([^/?#]+)\/c\//) || [])[1] || null;
        const projectMatch = routeEntityId && routeEntityId.match(/^(g-p-[0-9a-f]{32})(?:-|$)/i);
        const projectId = projectMatch ? projectMatch[1] : null;
        return { conversationId, projectId };
      },
    });
    if (locationResult && locationResult.result && locationResult.result.conversationId) {
      info = locationResult.result;
    }
  } catch (error) {
    // The URL carried from the popup is still usable if this lightweight live
    // location check is blocked during an in-progress navigation.
  }
  if (!info || !info.conversationId) return null;
  const { conversationId, projectId } = info;

  logProgress(`Reading the complete ChatGPT chain for "${tabTitle}" without activating its tab...`, "info");
  const startedAt = Date.now();
  const progressTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    logProgress(`Still reading the complete ChatGPT chain for "${tabTitle}" (${seconds}s)...`, "info");
  }, 10000);

  try {
    // Fetch in the page's MAIN world so ChatGPT sees the exact same origin,
    // cookies, and request context as its own frontend. This does not activate,
    // focus, move, or render the tab.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["chatgptConversation.js"],
    });
    if (isCancelled) {
      return { conversationId, messages: null, error: "Export cancelled.", cancelled: true };
    }

    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [conversationId, projectId, includeMedia === true, runId],
      func: async (id, currentProjectId, shouldResolveMedia, exportRunId) => {
        const controller = new AbortController();
        let cancelledByExporter = false;
        const onExporterCancel = event => {
          if (!event || event.detail === undefined || event.detail === exportRunId) {
            cancelledByExporter = true;
            controller.abort();
          }
        };
        document.addEventListener("__aiChatExporterCancel", onExporterCancel);
        const cancelledRunAttribute = document.documentElement &&
          document.documentElement.getAttribute("data-ai-chat-exporter-cancelled-run");
        if (
          globalThis.__aiChatExporterCancelledRunId === exportRunId ||
          cancelledRunAttribute === String(exportRunId)
        ) {
          cancelledByExporter = true;
          controller.abort();
        }
        // The user can cancel; large chats have no aggregate time limit.
        const abortMessage = () => "Export cancelled.";
        const timer = null;
        let authentication = "ChatGPT session was not checked";
        try {
          // ChatGPT's root bootstrap contains the selected account and the
          // standard request context used by its own API client. Read only the
          // fields needed for this request. No token or identifier leaves the
          // page world or appears in extension logs.
          let bootstrap = null;
          for (const script of document.querySelectorAll('script[type="application/json"]')) {
            try {
              const candidate = JSON.parse(script.textContent || "");
              if (candidate && candidate.session) {
                bootstrap = candidate;
                break;
              }
            } catch (error) {}
          }

          const bootstrapSession = bootstrap && bootstrap.session || null;
          let fetchedSession = null;
          try {
            const sessionResponse = await fetch("/api/auth/session", {
              credentials: "include",
              headers: { Accept: "application/json" },
              signal: controller.signal,
            });
            authentication = `/api/auth/session returned HTTP ${sessionResponse.status}`;
            if (sessionResponse.ok) {
              fetchedSession = await sessionResponse.json();
            }
          } catch (error) {
            authentication = "session discovery failed: " + String(error && error.message || error);
          }
          if (controller.signal.aborted) throw new Error(abortMessage());

          const accessToken = fetchedSession && (fetchedSession.accessToken || fetchedSession.access_token) ||
            bootstrapSession && (bootstrapSession.accessToken || bootstrapSession.access_token);
          const bootstrapAccount = bootstrapSession && bootstrapSession.account || null;
          const fetchedAccount = fetchedSession && fetchedSession.account || null;
          const account = bootstrapAccount || fetchedAccount
            ? { ...(bootstrapAccount || {}), ...(fetchedAccount || {}) }
            : null;
          const accountId = account && account.id;
          const isPersonalAccount = account && account.structure === "personal";

          const requiredHeaders = currentProjectId
            ? { "chatgpt-project-id": currentProjectId }
            : {};
          if (typeof accessToken === "string" && accessToken) {
            requiredHeaders.Authorization = "Bearer " + accessToken;
            authentication = "signed-in bearer session attached";
          } else if (!fetchedSession && bootstrapSession) {
            authentication = "bootstrap session contained no access token";
          } else {
            authentication = "session response contained no access token";
          }

          // ChatGPT's current client explicitly omits ChatGPT-Account-ID for a
          // personal workspace. v0.1.4 sent the personal account id anyway,
          // which makes project-conversation requests return HTTP 403.
          const workspaceHeader = globalThis.ChatGPTConversationGraph.accountHeader(account);
          Object.assign(requiredHeaders, workspaceHeader);
          if (workspaceHeader["ChatGPT-Account-ID"] && typeof accountId === "string") {
            authentication += "; active non-personal workspace attached";
          } else if (isPersonalAccount) {
            authentication += "; personal workspace header correctly omitted";
          }

          const contextHeaders = {};
          const addContext = (name, value) => {
            if (typeof value === "string" && value) contextHeaders[name] = value;
          };
          addContext("OAI-Language", bootstrap && bootstrap.locale);
          addContext("OAI-Client-Version", document.documentElement.dataset.build);
          addContext("OAI-Client-Build-Number", document.documentElement.dataset.seq);
          addContext("OAI-Session-Id", bootstrap && bootstrap.sessionId);
          addContext("OAI-Web-Deployment-Attestation", bootstrap && bootstrap.webDeploymentAttestation);

          // DeviceId is also present in the server-rendered Statsig context.
          // Use that page-provided value instead of inspecting browser cookies
          // or storage.
          const findDeviceId = (value, depth = 0) => {
            if (!value || typeof value !== "object" || depth > 12) return null;
            if (typeof value.DeviceId === "string" && value.DeviceId) return value.DeviceId;
            for (const child of Object.values(value)) {
              const match = findDeviceId(child, depth + 1);
              if (match) return match;
            }
            return null;
          };
          try {
            const statsig = typeof (bootstrap && bootstrap.statsigPayload) === "string"
              ? JSON.parse(bootstrap.statsigPayload)
              : bootstrap && bootstrap.statsigPayload;
            addContext("OAI-Device-Id", findDeviceId(statsig));
          } catch (error) {}

          const variants = [
            {
              label: "official page request context",
              headers: { ...contextHeaders, ...requiredHeaders },
            },
            {
              label: "minimal authenticated request context",
              headers: requiredHeaders,
            },
          ];
          const attempts = [];
          const seen = new Set();

          const resolveMessageMedia = async (messages, headers, conversationContext = {}) => {
            if (!shouldResolveMedia) {
              return { messages, discovered: 0, resolved: 0, failed: 0 };
            }

            const jobs = [];
            for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
              const attachments = Array.isArray(messages[messageIndex].attachments)
                ? messages[messageIndex].attachments
                : [];
              for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex++) {
                jobs.push({ messageIndex, attachmentIndex });
              }
            }

            const output = messages.map(message => ({
              ...message,
              attachments: Array.isArray(message.attachments)
                ? message.attachments.map(attachment => ({ ...attachment }))
                : [],
            }));
            let nextJob = 0;
            let resolved = 0;
            let failed = 0;
            let recoveredByFallback = 0;
            let resolvedByCurrentClient = 0;
            const resolvedFileCache = new Map();
            const fileCacheKey = attachment =>
              attachment && (attachment.fileReference || attachment.fileId) || null;
            const rememberResolvedFile = attachment => {
              const key = fileCacheKey(attachment);
              if (!key || !attachment.url) return;
              resolvedFileCache.set(key, {
                url: attachment.url,
                mimeType: attachment.mimeType || null,
                resolutionStrategy: attachment.resolutionStrategy || null,
              });
            };

            const withExporterAbort = (work, timeoutMs = 20000) => new Promise(
              (resolve, reject) => {
                let settled = false;
                const finish = (callback, value) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timeout);
                  controller.signal.removeEventListener("abort", onAbort);
                  callback(value);
                };
                const onAbort = () => finish(reject, new Error(abortMessage()));
                const timeout = setTimeout(
                  () => finish(reject, new Error("timed out after " + timeoutMs / 1000 + " seconds")),
                  timeoutMs
                );
                if (controller.signal.aborted) {
                  onAbort();
                  return;
                }
                controller.signal.addEventListener("abort", onAbort, { once: true });
                try {
                  Promise.resolve(work()).then(
                    value => finish(resolve, value),
                    error => finish(reject, error)
                  );
                } catch (error) {
                  finish(reject, error);
                }
              }
            );

            // Use ChatGPT's own authenticated file client. Its JavaScript
            // bundles now have anonymous content-hash names; conversation-small
            // is CSS only, so looking for conversation-small-*.js silently
            // bypassed this path. Inspect preloaded source for the stable
            // getFileDownloadLink query key, follow its minified ESM import,
            // and call the exact current file resolver from ChatGPT's page.
            let officialResolverDiscoveryError = null;
            let officialResolverStatus = "not inspected";
            const officialResolverPromise = withExporterAbort(async () => {
              const assetUrls = [];
              const seenAssetUrls = new Set();
              for (const element of document.querySelectorAll(
                'link[href*="/cdn/assets/"], script[src*="/cdn/assets/"]'
              )) {
                try {
                  const assetUrl = new URL(element.href || element.src, location.href);
                  assetUrl.hash = "";
                  if (
                    assetUrl.origin !== location.origin ||
                    !assetUrl.pathname.startsWith("/cdn/assets/") ||
                    !assetUrl.pathname.endsWith(".js") ||
                    seenAssetUrls.has(assetUrl.href)
                  ) continue;
                  seenAssetUrls.add(assetUrl.href);
                  assetUrls.push(assetUrl.href);
                } catch (error) {
                }
              }

              let nextAssetIndex = 0;
              let discoveredResolver = null;
              let inspectedAssets = 0;
              const discoveryFailures = [];
              const inspectAsset = async () => {
                while (!discoveredResolver && nextAssetIndex < assetUrls.length) {
                  const assetUrl = assetUrls[nextAssetIndex++];
                  try {
                    const response = await fetch(assetUrl, {
                      credentials: "same-origin",
                      cache: "force-cache",
                      signal: controller.signal,
                    });
                    inspectedAssets++;
                    if (!response.ok) continue;
                    const source = await response.text();
                    if (!source.includes("getFileDownloadLink")) continue;
                    const resolverImport =
                      globalThis.ChatGPTConversationGraph.currentFileResolverImport(
                        source,
                        assetUrl
                      );
                    if (!resolverImport) {
                      discoveryFailures.push(
                        "found getFileDownloadLink but could not follow its module import"
                      );
                      continue;
                    }
                    const resolverModule = await import(resolverImport.moduleUrl);
                    const resolver = resolverModule[resolverImport.exportName];
                    if (typeof resolver !== "function") {
                      discoveryFailures.push(
                        "the discovered ChatGPT file-client export was not callable"
                      );
                      continue;
                    }
                    let ownershipResolver = null;
                    for (const value of Object.values(resolverModule)) {
                      if (typeof value !== "function") continue;
                      let valueSource = "";
                      try {
                        valueSource = Function.prototype.toString.call(value);
                      } catch (error) {
                        continue;
                      }
                      if (
                        valueSource.includes("ensureQueryData") &&
                        valueSource.includes("effectiveGizmoId") &&
                        valueSource.includes("libraryFileId") &&
                        valueSource.includes("serverThreadId")
                      ) {
                        ownershipResolver = value;
                        break;
                      }
                    }
                    discoveredResolver = {
                      download: resolver,
                      resolveOwnership: ownershipResolver,
                    };
                  } catch (error) {
                    if (controller.signal.aborted) throw error;
                    discoveryFailures.push(String(error && error.message || error));
                  }
                }
              };

              await Promise.all(Array.from(
                { length: Math.min(8, Math.max(1, assetUrls.length)) },
                () => inspectAsset()
              ));
              if (!discoveredResolver) {
                const detail = discoveryFailures.length
                  ? discoveryFailures[discoveryFailures.length - 1]
                  : "no getFileDownloadLink route module was found";
                throw new Error(
                  `inspected ${inspectedAssets}/${assetUrls.length} JavaScript assets: ${detail}`
                );
              }
              officialResolverStatus =
                `discovered after inspecting ${inspectedAssets}/${assetUrls.length} JavaScript assets` +
                (discoveredResolver.resolveOwnership
                  ? "; ownership resolver available"
                  : "; ownership resolver unavailable");
              return discoveredResolver;
            }, 60000).catch(error => {
              if (controller.signal.aborted) throw error;
              officialResolverDiscoveryError = String(error && error.message || error);
              officialResolverStatus = "unavailable: " + officialResolverDiscoveryError;
              return null;
            });

            // ChatGPT's conversation endpoints require project headers, but
            // its own file downloader sends project context as gizmo_id in the
            // query string. Carrying chatgpt-project-id into the file request
            // makes ordinary owned uploads return HTTP 403. v0.1.9 changed the
            // query variants but accidentally retained that header in every
            // single fallback.
            const officialFileHeaders =
              globalThis.ChatGPTConversationGraph.fileRequestHeaders(headers);
            if (officialFileHeaders.Authorization) {
              let pageCookies = "";
              try {
                pageCookies = document.cookie;
              } catch (error) {}
              officialFileHeaders["X-OAI-IS-Client-Observation"] =
                globalThis.ChatGPTConversationGraph.integrityObservationHeader(pageCookies);
            }
            const compatibilityHeaders = { ...(headers || {}) };
            const projectForFiles = conversationContext.projectId || currentProjectId;
            const conversationGizmoId = conversationContext.gizmoId || null;
            if (projectForFiles) {
              compatibilityHeaders["chatgpt-project-id"] = projectForFiles;
            }
            if (conversationContext.ownerUserId) {
              compatibilityHeaders["chatgpt-conv-owner-id"] =
                conversationContext.ownerUserId;
            }

            const fetchFileLink = async (requestPath, requestHeaders) => {
              const requestController = new AbortController();
              let requestTimedOut = false;
              const onGlobalAbort = () => requestController.abort();
              if (controller.signal.aborted) requestController.abort();
              else controller.signal.addEventListener("abort", onGlobalAbort, { once: true });
              const requestTimer = setTimeout(() => {
                requestTimedOut = true;
                requestController.abort();
              }, 15000);

              try {
                const targetUrl = new URL(requestPath, location.origin);
                let targetRoute = targetUrl.pathname;
                if (/^\/backend-api\/files\/download\/[^/]+$/i.test(targetRoute)) {
                  targetRoute = "/backend-api/files/download/{file_id}";
                } else if (/^\/backend-api\/files\/[^/]+\/simple$/i.test(targetRoute)) {
                  targetRoute = "/backend-api/files/{file_id}/simple";
                }
                return await fetch(requestPath, {
                  credentials: "include",
                  headers: {
                    Accept: "application/json",
                    "X-OpenAI-Target-Path": targetUrl.pathname,
                    "X-OpenAI-Target-Route": targetRoute,
                    ...requestHeaders,
                  },
                  signal: requestController.signal,
                });
              } catch (error) {
                if (requestTimedOut) throw new Error("timed out after 15 seconds");
                throw error;
              } finally {
                clearTimeout(requestTimer);
                controller.signal.removeEventListener("abort", onGlobalAbort);
              }
            };

            const responseFailure = async response => {
              const prefix = "HTTP " + response.status;
              try {
                const body = await response.json();
                const detail = body && (
                  body.code ||
                  body.message ||
                  body.error && (body.error.code || body.error.message) ||
                  typeof body.detail === "string" && body.detail ||
                  body.detail && (body.detail.code || body.detail.message)
                );
                return typeof detail === "string" && detail.trim()
                  ? prefix + " (" + detail.trim().replace(/\s+/g, " ").slice(0, 180) + ")"
                  : prefix;
              } catch (error) {
                return prefix;
              }
            };

            const absoluteHttpUrl = value => {
              if (typeof value !== "string" || !value.trim()) return null;
              try {
                const parsed = new URL(value, location.origin);
                return parsed.protocol === "http:" || parsed.protocol === "https:"
                  ? parsed.href
                  : null;
              } catch (error) {
                return null;
              }
            };

            const candidateGizmoIds = attachment => Array.from(new Set([
              attachment.gizmoId,
              conversationGizmoId,
              projectForFiles,
              null,
            ].filter((value, index, values) => value || index === values.length - 1)));

            const resolveWithChatGptPage = async (attachment, attempts) => {
              const officialResolver = await officialResolverPromise;
              if (!officialResolver) {
                attempts.push(
                  "ChatGPT page file resolver was unavailable" +
                  (officialResolverDiscoveryError
                    ? " (" + officialResolverDiscoveryError + ")"
                    : "")
                );
                return false;
              }

              const fileReference = globalThis.ChatGPTConversationGraph.fileDownloadReference(
                attachment.fileReference || attachment.fileId
              );
              if (!fileReference) {
                attempts.push("ChatGPT page file resolver could not normalize the file reference");
                return false;
              }

              const scopeConversationId =
                attachment.checkContextScopesForConversationId || id;
              const owningConversationId = attachment.conversationId || id;
              const ownershipGizmoIds = [];
              const ownershipFileId = globalThis.ChatGPTConversationGraph.cleanAssetId(
                fileReference
              );
              if (officialResolver.resolveOwnership && ownershipFileId) {
                const requestedGizmoId = candidateGizmoIds(attachment)
                  .find(candidate => candidate) || undefined;
                try {
                  const ownership = await withExporterAbort(
                    () => officialResolver.resolveOwnership({
                      fileId: ownershipFileId,
                      gizmoId: requestedGizmoId,
                      libraryFileId:
                        attachment.libraryFileId ||
                        attachment.mountedLibraryFileId ||
                        undefined,
                      serverThreadId: scopeConversationId,
                    }),
                    20000
                  );
                  if (ownership && ownership.effectiveGizmoId) {
                    ownershipGizmoIds.push(ownership.effectiveGizmoId);
                  }
                  const fileInfo = ownership && ownership.fileInfo;
                  if (fileInfo && typeof fileInfo === "object") {
                    const directUrl = absoluteHttpUrl(
                      fileInfo.download_url || fileInfo.downloadUrl || fileInfo.url
                    );
                    if (directUrl) {
                      attachment.url = directUrl;
                      attachment.resolutionStrategy =
                        "ChatGPT current file ownership resolver returned a URL";
                      if (!attachment.mimeType && typeof fileInfo.mime_type === "string") {
                        attachment.mimeType = fileInfo.mime_type;
                      }
                      return true;
                    }
                    if (!attachment.libraryFileId && typeof fileInfo.library_file_id === "string") {
                      attachment.libraryFileId = fileInfo.library_file_id;
                    }
                    if (
                      !attachment.libraryDownloadId &&
                      typeof fileInfo.library_download_id === "string"
                    ) {
                      attachment.libraryDownloadId = fileInfo.library_download_id;
                    }
                    if (
                      !attachment.sharedLibraryFileId &&
                      typeof fileInfo.shared_library_file_id === "string"
                    ) {
                      attachment.sharedLibraryFileId = fileInfo.shared_library_file_id;
                    }
                  }
                } catch (error) {
                  attempts.push(
                    "ChatGPT current file ownership resolver returned " +
                    String(error && error.message || error)
                  );
                }
              }

              const gizmoIds = Array.from(new Set([
                ...ownershipGizmoIds,
                ...candidateGizmoIds(attachment),
              ]));
              const variants = [];
              for (const gizmoId of gizmoIds) {
                variants.push({
                  label: "ChatGPT page inline resolver" + (gizmoId ? " with gizmo context" : " without gizmo context"),
                  gizmoId,
                  conversationId: owningConversationId,
                  checkContextScopesForConversationId: scopeConversationId,
                  showInline: false,
                  downloadIntent: false,
                });
                variants.push({
                  label: "ChatGPT page download resolver" + (gizmoId ? " with gizmo context" : " without gizmo context"),
                  gizmoId,
                  conversationId: undefined,
                  checkContextScopesForConversationId: scopeConversationId,
                  showInline: undefined,
                  downloadIntent: true,
                });
              }

              const seenOfficialRequests = new Set();
              for (const variant of variants) {
                const signature = JSON.stringify([
                  variant.gizmoId,
                  variant.conversationId,
                  variant.checkContextScopesForConversationId,
                  variant.showInline,
                  variant.downloadIntent,
                ]);
                if (seenOfficialRequests.has(signature)) continue;
                seenOfficialRequests.add(signature);
                try {
                  const result = await withExporterAbort(() => officialResolver.download(fileReference, {
                    gizmoId: variant.gizmoId || undefined,
                    conversationId: variant.conversationId,
                    postId: attachment.postId || undefined,
                    checkContextScopesForConversationId:
                      variant.checkContextScopesForConversationId,
                    showInline: variant.showInline,
                    downloadIntent: variant.downloadIntent,
                  }));
                  const downloadUrl = absoluteHttpUrl(result && (
                    result.url || result.download_url || result.downloadUrl
                  ));
                  if (!downloadUrl) {
                    throw new Error("response contained no download URL");
                  }
                  attachment.url = downloadUrl;
                  attachment.resolutionStrategy = variant.label;
                  const mimeType = result.mimeType || result.mime_type;
                  if (!attachment.mimeType && typeof mimeType === "string") {
                    attachment.mimeType = mimeType;
                  }
                  return true;
                } catch (error) {
                  attempts.push(
                    variant.label + " returned " + String(error && error.message || error)
                  );
                  if (controller.signal.aborted) break;
                }
              }
              return false;
            };

            const resolveOne = async ({ messageIndex, attachmentIndex }) => {
              const attachment = output[messageIndex].attachments[attachmentIndex];
              if (attachment.url) {
                rememberResolvedFile(attachment);
                resolved++;
                return;
              }
              const cached = resolvedFileCache.get(fileCacheKey(attachment));
              if (cached) {
                attachment.url = cached.url;
                if (!attachment.mimeType && cached.mimeType) {
                  attachment.mimeType = cached.mimeType;
                }
                attachment.resolutionStrategy = cached.resolutionStrategy ||
                  "cached ChatGPT file resolution";
                resolved++;
                return;
              }
              if (!attachment.fileId) {
                attachment.error = "ChatGPT returned attachment metadata without a file id or URL";
                failed++;
                return;
              }

              const attempts = [];
              if (await resolveWithChatGptPage(attachment, attempts)) {
                rememberResolvedFile(attachment);
                resolved++;
                resolvedByCurrentClient++;
                return;
              }

              // If ChatGPT's route bundle was unavailable or its resolver
              // rejected an old pointer, reproduce the same ownership lookup
              // before falling back to direct file-link requests.
              const discoveredGizmoIds = [];
              for (const requestedGizmoId of candidateGizmoIds(attachment)) {
                const infoEndpoint = globalThis.ChatGPTConversationGraph.fileInfoEndpoint(
                  attachment.fileReference || attachment.fileId,
                  location.origin,
                  {
                    gizmoId: requestedGizmoId,
                    conversationId:
                      attachment.checkContextScopesForConversationId || id,
                  }
                );
                if (!infoEndpoint) continue;
                try {
                  const response = await fetchFileLink(
                    infoEndpoint.pathname + infoEndpoint.search,
                    officialFileHeaders
                  );
                  if (!response.ok) {
                    throw new Error(await responseFailure(response));
                  }
                  const fileInfo = await response.json();
                  const directUrl = absoluteHttpUrl(fileInfo && (
                    fileInfo.download_url || fileInfo.downloadUrl || fileInfo.url
                  ));
                  if (directUrl) {
                    attachment.url = directUrl;
                    attachment.resolutionStrategy = "file ownership lookup returned a URL";
                    if (!attachment.mimeType && typeof fileInfo.mime_type === "string") {
                      attachment.mimeType = fileInfo.mime_type;
                    }
                    rememberResolvedFile(attachment);
                    resolved++;
                    recoveredByFallback++;
                    return;
                  }
                  const effectiveGizmoId =
                    globalThis.ChatGPTConversationGraph.effectiveGizmoIdFromFileInfo(
                      requestedGizmoId,
                      fileInfo
                    );
                  if (effectiveGizmoId) discoveredGizmoIds.push(effectiveGizmoId);
                  if (!attachment.libraryFileId && typeof fileInfo.library_file_id === "string") {
                    attachment.libraryFileId = fileInfo.library_file_id;
                  }
                  if (
                    !attachment.libraryDownloadId &&
                    typeof fileInfo.library_download_id === "string"
                  ) {
                    attachment.libraryDownloadId = fileInfo.library_download_id;
                  }
                  if (
                    !attachment.sharedLibraryFileId &&
                    typeof fileInfo.shared_library_file_id === "string"
                  ) {
                    attachment.sharedLibraryFileId = fileInfo.shared_library_file_id;
                  }
                } catch (error) {
                  attempts.push(
                    "file ownership lookup returned " +
                    String(error && error.message || error)
                  );
                  if (controller.signal.aborted) break;
                }
              }

              // Match ChatGPT's current file client first. It preserves query
              // context embedded in the asset pointer, uses gizmo_id rather
              // than a project header, and sends only the scoped-conversation
              // check for an ordinary download.
              const rawGizmoIds = Array.from(new Set([
                ...discoveredGizmoIds,
                ...candidateGizmoIds(attachment),
              ]));
              const requestVariants = [];
              for (const gizmoId of rawGizmoIds) {
                requestVariants.push({
                  label: gizmoId
                    ? "inline file request with resolved gizmo context"
                    : "inline file request without gizmo context",
                  scopedConversation: true,
                  conversation: true,
                  gizmoId,
                  inline: false,
                  downloadIntent: false,
                  projectHeaders: false,
                });
                requestVariants.push({
                  label: gizmoId
                    ? "download file request with resolved gizmo context"
                    : "download file request without gizmo context",
                  scopedConversation: true,
                  conversation: false,
                  gizmoId,
                  inline: null,
                  downloadIntent: true,
                  projectHeaders: false,
                });
              }
              requestVariants.push(
                {
                  label: "owner-authenticated request",
                  scopedConversation: false,
                  conversation: false,
                  gizmoId: null,
                  inline: null,
                  downloadIntent: true,
                  projectHeaders: false,
                },
                {
                  label: "project-header compatibility request",
                  scopedConversation: true,
                  conversation: false,
                  gizmoId: attachment.gizmoId || conversationGizmoId || projectForFiles,
                  inline: null,
                  downloadIntent: true,
                  projectHeaders: true,
                }
              );
              const seenRequests = new Set();

              for (let variantIndex = 0; variantIndex < requestVariants.length; variantIndex++) {
                const variant = requestVariants[variantIndex];
                const endpoint = globalThis.ChatGPTConversationGraph.fileDownloadEndpoint(
                  attachment.fileReference || attachment.fileId,
                  location.origin,
                  {
                    conversationId: variant.conversation
                      ? (attachment.conversationId || id)
                      : null,
                    checkContextScopesForConversationId: variant.scopedConversation
                      ? (attachment.checkContextScopesForConversationId || id)
                      : null,
                    inline: variant.inline,
                    downloadIntent: variant.downloadIntent,
                    gizmoId: variant.gizmoId,
                    postId: attachment.postId || null,
                  }
                );
                if (!endpoint) {
                  attempts.push(variant.label + " could not build a file endpoint");
                  continue;
                }
                const requestPath = endpoint.pathname + endpoint.search;
                const requestHeaders = variant.projectHeaders
                  ? compatibilityHeaders
                  : officialFileHeaders;
                const requestSignature =
                  (variant.projectHeaders ? "project-headers:" : "official-headers:") +
                  requestPath;
                if (seenRequests.has(requestSignature)) continue;
                seenRequests.add(requestSignature);

                try {
                  const response = await fetchFileLink(requestPath, requestHeaders);
                  if (!response.ok) {
                    throw new Error(await responseFailure(response));
                  }
                  const body = await response.json();
                  const downloadUrl = absoluteHttpUrl(
                    body && (body.download_url || body.downloadUrl || body.url)
                  );
                  if (!downloadUrl) {
                    throw new Error("response contained no download URL");
                  }
                  attachment.url = downloadUrl;
                  attachment.resolutionStrategy = variant.label;
                  if (!attachment.mimeType && typeof body.mime_type === "string") {
                    attachment.mimeType = body.mime_type;
                  }
                  rememberResolvedFile(attachment);
                  resolved++;
                  if (variantIndex > 0) recoveredByFallback++;
                  return;
                } catch (error) {
                  attempts.push(
                    variant.label + " returned " + String(error && error.message || error)
                  );
                  if (controller.signal.aborted) break;
                }
              }

              // Library-backed attachments can expose an explicit library
              // download id instead of a normal file-service id. Let the page
              // fetch this authenticated same-origin URL during collection.
              const libraryDownloadId = attachment.sharedLibraryFileId ||
                attachment.libraryDownloadId ||
                attachment.libraryFileId === attachment.fileId && attachment.libraryFileId;
              if (libraryDownloadId && !controller.signal.aborted) {
                attachment.url = new URL(
                  "/api/library/files/" + encodeURIComponent(libraryDownloadId) + "/download",
                  location.origin
                ).href;
                attachment.resolutionStrategy = "library download endpoint";
                rememberResolvedFile(attachment);
                resolved++;
                recoveredByFallback++;
                return;
              }

              attachment.error = attempts.join("; ") || "all file-link request variants failed";
              failed++;
            };

            const worker = async () => {
              while (nextJob < jobs.length) {
                if (controller.signal.aborted) throw new Error(abortMessage());
                const job = jobs[nextJob++];
                await resolveOne(job);
              }
            };
            await Promise.all(Array.from(
              { length: Math.min(8, Math.max(1, jobs.length)) },
              () => worker()
            ));
            if (controller.signal.aborted) throw new Error(abortMessage());
            return {
              messages: output,
              discovered: jobs.length,
              resolved,
              failed,
              recoveredByFallback,
              resolvedByCurrentClient,
              currentClientStatus: jobs.length ? officialResolverStatus : null,
            };
          };

          for (const variant of variants) {
            const signature = JSON.stringify(variant.headers);
            if (seen.has(signature)) continue;
            seen.add(signature);
            try {
              const result = await globalThis.ChatGPTConversationGraph.fetchActiveMessages(id, {
                headers: variant.headers,
                signal: controller.signal,
              });
              const media = await resolveMessageMedia(
                result.messages,
                variant.headers,
                result
              );
              document.dispatchEvent(new CustomEvent("__aiChatExporterChainPart", { detail: JSON.stringify({ begin: true, runId: exportRunId }) }));
              for (const message of media.messages) {
                if (controller.signal.aborted) throw new Error(abortMessage());
                const json = JSON.stringify(message);
                for (let offset = 0; offset < json.length; offset += 256 * 1024) {
                  document.dispatchEvent(new CustomEvent("__aiChatExporterChainPart", { detail: JSON.stringify({ runId: exportRunId, chunk: json.slice(offset, offset + 256 * 1024), last: offset + 256 * 1024 >= json.length }) }));
                }
              }
              return {
                status: "success",
                endpoint: result.endpoint,
                messageCount: media.messages.length,
                pages: result.pages,
                source: result.source,
                overlappingMessages: result.overlappingMessages || 0,
                usedCurrentNodeFallback: result.usedCurrentNodeFallback === true,
                mediaDiscovered: media.discovered,
                mediaResolved: media.resolved,
                mediaFailed: media.failed,
                mediaRecoveredByFallback: media.recoveredByFallback,
                mediaResolvedByCurrentClient: media.resolvedByCurrentClient,
                mediaCurrentClientStatus: media.currentClientStatus,
                authentication,
                requestStrategy: variant.label,
              };
            } catch (error) {
              if (controller.signal.aborted) throw new Error(abortMessage());
              attempts.push(variant.label + ": " + String(error && error.message || error));
            }
          }
          throw new Error(attempts.join(" | ") || "no ChatGPT request strategy succeeded");
        } catch (error) {
          return {
            status: cancelledByExporter ? "cancelled" : "error",
            error: String(error && error.message || error),
            authentication,
          };
        } finally {
          clearTimeout(timer);
          document.removeEventListener("__aiChatExporterCancel", onExporterCancel);
        }
      },
    });

    const result = execution && execution.result;
    if (isCancelled || result && result.status === "cancelled") {
      return { conversationId, messages: null, error: "Export cancelled.", cancelled: true };
    }
    if (result && result.status === "success" && result.messageCount > 0) {
      logProgress(`ChatGPT page authentication: ${result.authentication}.`, "info");
      logProgress(`ChatGPT request strategy: ${result.requestStrategy}.`, "info");
      if (result.source === "paginated") {
        logProgress(
          `Reached the ChatGPT root through ${result.pages} paginated history page(s).`,
          "info"
        );
      } else {
        logProgress("Reached the ChatGPT root through its complete-mapping fallback.", "info");
      }
      logProgress(`Loaded ${result.messageCount} ChatGPT messages from the authoritative root-to-current chain.`, "info");
      if (result.usedCurrentNodeFallback) {
        logProgress(
          "ChatGPT omitted its server current node from the paginated message set; " +
          "used the newest returned node, matching ChatGPT's own web client.",
          "info"
        );
      }
      if (result.overlappingMessages) {
        logProgress(
          `Merged ${result.overlappingMessages} overlapping ChatGPT pagination message(s).`,
          "info"
        );
      }
      if (includeMedia) {
        logProgress(
          `ChatGPT attachment metadata: ${result.mediaDiscovered || 0} found, ` +
          `${result.mediaResolved || 0} resolved, ${result.mediaFailed || 0} unresolved.`,
          result.mediaFailed ? "error" : "info"
        );
        if (result.mediaCurrentClientStatus) {
          logProgress(
            `ChatGPT current authenticated file client: ${result.mediaCurrentClientStatus}; ` +
            `${result.mediaResolvedByCurrentClient || 0} attachment(s) resolved through it.`,
            result.mediaResolvedByCurrentClient ? "info" : "error"
          );
        }
        if (result.mediaRecoveredByFallback) {
          logProgress(
            `Recovered ${result.mediaRecoveredByFallback} older ChatGPT attachment(s) through compatibility request context.`,
            "info"
          );
        }
      }
      return {
        conversationId,
        ready: true,
        runId,
        messageCount: result.messageCount,
        pages: result.pages,
        source: result.source,
        overlappingMessages: result.overlappingMessages || 0,
        usedCurrentNodeFallback: result.usedCurrentNodeFallback === true,
        error: null,
      };
    }

    const requestError = result && result.error ? result.error : "page-context chain request returned no messages";
    const error = result && result.authentication
      ? `${requestError} Page authentication: ${result.authentication}.`
      : requestError;
    logProgress(`Page-context ChatGPT chain request failed for "${tabTitle}": ${error}`, "error");
    return { conversationId, messages: null, error };
  } catch (error) {
    const reason = String(error && error.message || error);
    if (isCancelled) {
      return { conversationId, messages: null, error: "Export cancelled.", cancelled: true };
    }
    logProgress(`Could not run the ChatGPT chain request for "${tabTitle}": ${reason}`, "error");
    return { conversationId, messages: null, error: reason };
  } finally {
    clearInterval(progressTimer);
  }
}

// Listen for keep-alive heartbeats to prevent SW termination during long tasks
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepAlive') {
    port.onMessage.addListener((msg) => {
      // The act of receiving this message resets the 30-second idle timer.
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request) return;

  if (request.action === "forwardProgress") {
    logProgress(request.message, request.type || "info");
    return;
  }

  if (request.action === "startExport") {
    if (isExporting) {
      sendResponse({
        status: "error",
        error: "An export batch is already running. Cancel it before changing the selection.",
        targetTabIds: activeExportTargetIds.slice(),
      });
      return true;
    }

    const exportTargets = globalThis.AIChatExporterSelection.requestedTargets(request);
    if (!globalThis.AIChatExporterSelection.hasBatchConfirmation(request, exportTargets)) {
      sendResponse({ status: "error", error: "Review and confirm the selected batch twice before exporting." });
      return true;
    }
    if (!exportTargets.length) {
      sendResponse({
        status: "error",
        error: "No checked chat tabs were included in the export request.",
        targetTabIds: [],
      });
      return true;
    }

    isCancelled = false;
    isExporting = true;
    activeExportTargetIds = exportTargets.map(target => target.id);
    const runId = createExportRunId();
    const abortController = new AbortController();
    activeExportRunId = runId;
    activeExportAbortController = abortController;
    logsList = [];
    logProgress(`AI Chat Exporter v${chrome.runtime.getManifest().version} started this run.`, "info");

    runBatchExport(exportTargets, request.options, runId, abortController.signal)
      .then(() => finishExportRun(runId, null))
      .catch(err => finishExportRun(runId, err));

    sendResponse({
      status: "started",
      targetTabIds: activeExportTargetIds.slice(),
      targetCount: activeExportTargetIds.length,
    });
    return true;
  }

  if (request.action === "cancelExport") {
    const wasActive = cancelActiveExport();
    sendResponse({ status: wasActive ? "cancelling" : "idle" });
    return true;
  }

  if (request.action === "getStatus") {
    sendResponse({
      isExporting: isExporting,
      isCancelling: isExporting && isCancelled,
      activeTargetIds: activeExportTargetIds.slice(),
      logs: logsList
    });
    return true;
  }

  // Legacy pop-out request from older content scripts: acknowledge and do
  // nothing. Window manipulation (pop-out, resize, focus-steal) is gone;
  // hidden tabs are kept alive by the visibility patch + wake pulses instead.
  if (request.action === "popOutTab") {
    sendResponse({ status: "success" });
    return true;
  }

});


// NOTE: there is deliberately no web-page-triggered export path. An earlier
// "testExport" hook, reachable from any page on the supported sites via
// externally_connectable, let a script start an export and write a file to
// disk with no user interaction. Exports must originate from the popup.

async function runBatchExport(targetTabs, options, runId, signal) {
  logProgress(`Starting ${targetTabs.length > 1 ? "batch " : ""}export of ${targetTabs.length} chat(s) in background...`, "info");
  let successfulExports = 0;
  let failedExports = 0;
  const failureDetails = [];

  try {
    // Keep service worker alive by opening the offscreen document immediately
    await setupOffscreenDocument('offscreen.html');
    throwIfExportCancelled(signal);

    for (const target of targetTabs) {
      throwIfExportCancelled(signal);

      // New popup versions pass the URL they already discovered. Keep number
      // support for an export launched by an older popup that was open while
      // the extension reloaded.
      const tabId = typeof target === "number" ? target : target && target.id;
      const discoveredUrl = typeof target === "object" && target ? target.url : "";
      let tabTitle = typeof target === "object" && target && target.title
        ? target.title
        : `Tab ${tabId}`;
      try {
        if (!Number.isInteger(tabId)) {
          throw new Error("The selected Chrome tab no longer has a valid tab id.");
        }
        const tabObj = await chrome.tabs.get(tabId);
        throwIfExportCancelled(signal);
        tabTitle = tabObj && tabObj.title ? tabObj.title : tabTitle;

        currentExportTabId = tabId;
        // Never move, activate, focus, or resize the user's tab. The scraper's
        // hidden-tab wake pulse below keeps work progressing in place, and the
        // ChatGPT path reads the authoritative conversation graph instead of
        // depending on a visible, fully rendered page.
        logProgress(`Exporting "${tabTitle}" in place. The tab will not be moved or focused.`, "info");

        // Install a small isolated-world listener before the long MAIN-world
        // ChatGPT request starts. It forwards tab messages through a DOM event
        // and persists the run id on the shared document element, covering the
        // race where a second MAIN-world injection would otherwise be queued.
        await installTabCancellationBridge(tabId);
        throwIfExportCancelled(signal);

        // A background tab can be marked hidden by Chrome. Its timers are throttled to
        // roughly once a second, and requestAnimationFrame stops firing
        // altogether.
        //
        // The scrape itself copes: sleep() advances on __exportWake pulses
        // injected from here, and the loader is triggered by a synthetic scroll
        // event, both of which work while hidden. What does not cope is the
        // page's own rendering. Gemini's chat history is an Angular virtual
        // scroller, so the scroll handler schedules its work through rAF; with
        // rAF parked, the batch is fetched but never rendered and the message
        // count never moves.
        //
        // So: report the page as visible, and re-drive rAF from the same
        // unthrottled pulse that drives sleep(). Callbacks are queued and
        // flushed on each __exportWake -- DOM events cross worlds, so the pulse
        // dispatched from the isolated world reaches this MAIN-world listener.
        // The native rAF is still called too, so nothing changes while visible.
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: "MAIN",
            func: () => {
              if (window.__exportVisibilityPatched) return;
              window.__exportVisibilityPatched = true;
              const descriptors = new Map(["visibilityState", "hidden"].map(key => [key, Object.getOwnPropertyDescriptor(document, key)]));
              const originalRaf = window.requestAnimationFrame;
              const originalCancel = window.cancelAnimationFrame;
              const stopVisibility = e => e.stopImmediatePropagation();
              let releaseQueue = () => {};
              window.__exportRestoreVisibility = () => {
                document.removeEventListener("visibilitychange", stopVisibility, true);
                for (const [key, descriptor] of descriptors) {
                  if (descriptor) Object.defineProperty(document, key, descriptor);
                  else delete document[key];
                }
                window.requestAnimationFrame = originalRaf;
                window.cancelAnimationFrame = originalCancel;
                releaseQueue();
                delete window.__exportVisibilityPatched;
                delete window.__exportRestoreVisibility;
              };
              try {
                Object.defineProperty(document, "visibilityState", {
                  configurable: true,
                  get: () => "visible",
                });
                Object.defineProperty(document, "hidden", {
                  configurable: true,
                  get: () => false,
                });
                document.addEventListener(
                  "visibilitychange",
                  stopVisibility,
                  true
                );
              } catch (err) {}

              try {
                const nativeRaf = window.requestAnimationFrame.bind(window);
                let queue = [];
                let nextId = 1 << 20; // keep clear of native ids
                const flush = () => {
                  if (!queue.length) return;
                  const batch = queue;
                  queue = [];
                  const now = performance.now();
                  for (const entry of batch) {
                    try { entry.cb(now); } catch (err) {}
                  }
                };
                window.requestAnimationFrame = function (cb) {
                  const id = nextId++;
                  queue.push({ id: id, cb: cb });
                  try { nativeRaf(flush); } catch (err) {}
                  return id;
                };
                window.cancelAnimationFrame = function (id) {
                  queue = queue.filter((e) => e.id !== id);
                };
                document.addEventListener("__exportWake", flush);
                releaseQueue = () => {
                  document.removeEventListener("__exportWake", flush);
                  for (const entry of queue) nativeRaf(entry.cb);
                  queue = [];
                };
              } catch (err) {}
            },
          });
        } catch (e) {}

        // Read the true visibility from the isolated world: property
        // redefinitions in MAIN are not shared across worlds, so this still
        // sees what Chrome actually thinks rather than the patched value.
        // Occluded is expected and handled -- log it as information so a slow
        // export is explainable, not as a failure.
        try {
          const [vis] = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => document.visibilityState,
          });
          if (vis && vis.result && vis.result !== "visible") {
            logProgress(`Tab is occluded (visibilityState "${vis.result}"); driving it from the background.`, "info");
          }
        } catch (e) {}

        throwIfExportCancelled(signal);

        const chatGptContext = await preloadChatGptChain(
          tabId,
          tabObj && (tabObj.url || tabObj.pendingUrl) || discoveredUrl,
          tabTitle,
          !!(options && options.includeMedia),
          runId
        );
        throwIfExportCancelled(signal);

        logProgress(`Injecting scraper script...`, "info");
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ["chatgptConversation.js", "browserAdapters.js", "exportTransport.js", "contentScript.js"]
        });

        throwIfExportCancelled(signal);

        logProgress(`Executing scraper on webpage...`, "info");

        // Wake pulse: keeps the service worker alive and lets the content
        // script's sleep() resolve via __exportWake even if the window
        // ends up behind other windows.
        const wakeInterval = setInterval(() => {
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => { document.dispatchEvent(new Event('__exportWake')); }
          }).catch(() => {});
        }, 500);

        const response = await new Promise((resolve, reject) => {
          let settled = false;
          let timer = null;
          const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearInterval(wakeInterval);
            if (timer) clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            fn(value);
          };
          const onAbort = () => {
            finish(reject, exportCancellationError("Export cancelled during page scraping."));
          };
          signal.addEventListener("abort", onAbort, { once: true });

          if (signal.aborted) {
            onAbort();
            return;
          }

          chrome.tabs.sendMessage(tabId, {
            action: "exportChat",
            transferId: runId + ":" + tabId,
            options: options,
            chatGptContext: chatGptContext,
          }, (res) => {
            if (chrome.runtime.lastError) {
              finish(reject, new Error(chrome.runtime.lastError.message));
            } else {
              finish(resolve, res);
            }
          });
        });

        throwIfExportCancelled(signal);

        if (response && response.status === "success") {

          throwIfExportCancelled(signal);

          logProgress(`Delegating file compile to offscreen document...`, "info");
          const offscreenResponse = await new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const finish = (fn, value) => {
              if (settled) return;
              settled = true;
              if (timer) clearTimeout(timer);
              signal.removeEventListener("abort", onAbort);
              fn(value);
            };
            const onAbort = () => {
              finish(reject, exportCancellationError("Export cancelled during packaging."));
            };
            signal.addEventListener("abort", onAbort, { once: true });

            if (signal.aborted) {
              onAbort();
              return;
            }

            chrome.runtime.sendMessage({
              action: "zipAndDownload",
              transferId: response.transferId,
              options: options,
              runId: runId
            }, (res) => {
              if (chrome.runtime.lastError) {
                finish(reject, new Error(chrome.runtime.lastError.message));
              } else {
                finish(resolve, res);
              }
            });
          });
          throwIfExportCancelled(signal);

          const packagedUrl = offscreenResponse &&
            (offscreenResponse.downloadUrl || offscreenResponse.dataUrl);
          if (offscreenResponse && offscreenResponse.status === "success" && packagedUrl) {
            const { filename } = offscreenResponse;
            logProgress(`Starting download of: ${filename}...`, "info");

            try {
              await new Promise((resolve, reject) => {
                let listener = null;
                let downloadId = null;
                let settled = false;
                let timer = null;
                const finish = (fn, value) => {
                  if (settled) return;
                  settled = true;
                  if (timer) clearTimeout(timer);
                  signal.removeEventListener("abort", onAbort);
                  if (listener) chrome.downloads.onChanged.removeListener(listener);
                  if (activeDownloadId === downloadId) activeDownloadId = null;
                  fn(value);
                };
                const cancelDownload = id => {
                  if (id === null || id === undefined) return;
                  chrome.downloads.cancel(id, () => { void chrome.runtime.lastError; });
                };
                const onAbort = () => {
                  cancelDownload(downloadId);
                  finish(reject, exportCancellationError("Export cancelled during download."));
                };
                signal.addEventListener("abort", onAbort, { once: true });

                if (signal.aborted) {
                  onAbort();
                  return;
                }

                chrome.downloads.download({
                  url: packagedUrl,
                  filename: filename,
                  saveAs: false
                }, (startedDownloadId) => {
                  if (chrome.runtime.lastError) {
                    if (settled) return;
                    return finish(reject, new Error(chrome.runtime.lastError.message));
                  }
                  if (settled || signal.aborted) {
                    cancelDownload(startedDownloadId);
                    return;
                  }
                  downloadId = startedDownloadId;
                  activeDownloadId = startedDownloadId;

                  listener = (delta) => {
                    if (delta.id === downloadId && delta.state && delta.state.current !== 'in_progress') {
                      if (delta.state.current === 'complete') {
                        logProgress(`Successfully downloaded: ${filename}`, "success");
                        finish(resolve);
                      } else {
                        finish(reject, new Error(`Download state: ${delta.state.current}`));
                      }
                    }
                  };
                  chrome.downloads.onChanged.addListener(listener);
                });
              });
            } finally {
              if (packagedUrl.startsWith("blob:")) {
                await new Promise((resolve) => {
                  chrome.runtime.sendMessage(
                    { action: "revokeBlobUrl", url: packagedUrl },
                    () => {
                      void chrome.runtime.lastError;
                      resolve();
                    }
                  );
                });
              }
            }
            throwIfExportCancelled(signal);
            successfulExports++;

          } else {
            const errMsg = (offscreenResponse && offscreenResponse.error) || "Offscreen packaging failed.";
            throw new Error(`Export packaging failed for "${tabTitle}": ${errMsg}`);
          }

        } else {
          const errMessage = (response && response.error) || "Scraper failed to return data.";
          throw new Error(errMessage);
        }
      } catch (err) {
        if (signal.aborted || isExportCancellation(err)) {
          logProgress(`Stopped export of "${tabTitle}".`, "info");
          break;
        }
        failedExports++;
        const reason = String(err.message || err);
        failureDetails.push(`"${tabTitle}": ${reason}`);
        logProgress(`FAILED "${tabTitle}": ${reason}`, "error");
      } finally {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => window.__exportRestoreVisibility?.() });
        } catch { /* The user may have closed the tab. */ }
        if (currentExportTabId === tabId) currentExportTabId = null;
      }
    }

    // There is no focus or window restoration step because the export never
    // changes the user's Chrome window or active tab.
    if (!isCancelled && failedExports > 0) {
      throw new Error(
        `${failedExports} chat export(s) failed; ${successfulExports} completed successfully. ` +
        `Failures: ${failureDetails.join(" | ")}`
      );
    }

  } finally {
    // Always close offscreen document when finished to release resources
    await closeOffscreenDocument();
  }
}
