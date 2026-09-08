// Content script for AI Chat Exporter Chrome Extension
// Scrapes the chat page, scrolls to load all content, fetches media, and returns the data.

(async function() {
  const scriptVersion = (window.__exporterScriptVersion || 0) + 1;
  window.__exporterScriptVersion = scriptVersion;

  let keepAlivePort;
  let keepAliveInterval;

  function startKeepAlive() {
    if (keepAlivePort) return;
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
      });
      
      // Ping every 20 seconds to reset the background script's idle timer
      keepAliveInterval = setInterval(() => {
        if (keepAlivePort) {
          try {
            keepAlivePort.postMessage({ ping: true });
          } catch (err) {}
        } else {
          startKeepAlive(); // Reconnect if disconnected
        }
      }, 20000);
    } catch (e) {
      // Ignore connection failures when the extension gets reloaded/invalidated
    }
  }

  function stopKeepAlive() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (keepAlivePort) {
      keepAlivePort.disconnect();
      keepAlivePort = null;
    }
  }

  let exportCancelled = false;

  // Chrome throttles setTimeout to ~1/second (or worse) in hidden tabs.
  // The background worker dispatches an __exportWake event every 500ms via
  // chrome.scripting.executeScript, which is NOT throttled. sleep() listens
  // for that event so the export keeps running at near-normal speed even
  // when the user switches to another tab.
  //
  // sleep() is also the cancellation point: if the export is cancelled while
  // it's waiting, it aborts the sleep and throws immediately instead of
  // running out the full delay. Since nearly every step awaits a sleep, this
  // makes Cancel take effect almost instantly no matter what phase we're in.
  function sleep(ms) {
    return new Promise((resolve, reject) => {
      if (exportCancelled) { reject(new Error("Export cancelled.")); return; }
      const deadline = Date.now() + ms;
      let settled = false;
      const cleanup = () => {
        document.removeEventListener('__exportWake', onWake);
        document.removeEventListener('__exportCancel', onCancel);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onCancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Export cancelled."));
      };
      const onWake = () => {
        if (Date.now() >= deadline) done();
      };
      document.addEventListener('__exportWake', onWake);
      document.addEventListener('__exportCancel', onCancel);
      setTimeout(done, ms);
    });
  }

  // Listen for the run message from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (window.__exporterScriptVersion !== scriptVersion) return;
    if (!request) return;
    if (request.action === "cancelExport") {
      exportCancelled = true;
      // Wake any in-flight sleep() so it aborts right now instead of
      // waiting out its timer.
      try { document.dispatchEvent(new Event('__exportCancel')); } catch (e) {}
      sendResponse({ status: "cancelled" });
      return;
    }
    if (request.action === "exportChat") {
      exportCancelled = false;
      startKeepAlive();
      const context = request.chatGptContext;
      const chain = globalThis.__aiChatExporterPreloadedChain;
      const preloadedContext = context?.ready
        ? { ...context, messages: chain?.runId === context.runId && chain.messages.length === context.messageCount ? chain.messages : null,
          error: chain?.runId === context.runId && chain.messages.length === context.messageCount ? null : "The complete conversation transfer did not arrive." }
        : context;
      runExport(request.options, preloadedContext || null)
        .then(async result => {
          const transferred = await globalThis.AIChatExporterTransport.send(result, request.transferId,
            payload => chrome.runtime.sendMessage(payload),
            () => { if (exportCancelled) throw new Error("Export cancelled."); });
          stopKeepAlive();
          sendResponse({ status: "success", ...transferred });
        })
        .catch(err => {
          stopKeepAlive();
          sendResponse({ status: "error", error: err.message || String(err) });
        }).finally(() => { delete globalThis.__aiChatExporterPreloadedChain; });
      return true; // Keep message channel open for async response
    }
  });

  // Helper to send progress updates back to popup
  function updateProgress(message) {
    try {
      chrome.runtime.sendMessage({ action: "forwardProgress", message: message }, () => {
        // Reading lastError silences the "Unchecked runtime.lastError" warning in background.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // Ignore if context is invalidated
    }
  }

  async function runExport(options, chatGptContext) {
    function checkCancelled() {
      if (exportCancelled) throw new Error("Export cancelled.");
    }

    // Aborts in-flight network requests the moment Cancel is hit, so a slow
    // media download or the initial API fetch doesn't hold up cancellation.
    const abortController = new AbortController();
    const onExportCancel = () => {
      document.removeEventListener('__exportCancel', onExportCancel);
      try { abortController.abort(); } catch (e) {}
    };
    document.addEventListener('__exportCancel', onExportCancel);
    if (exportCancelled) abortController.abort();

    try {

    if (globalThis.AIChatExporterBrowserAdapters?.isGoogleSearch(location.href)) {
      updateProgress("Reading Google AI answers and citations without activating the tab...");
      const data = await globalThis.AIChatExporterBrowserAdapters.exportGoogle(document, location.href, {
        includeMedia: options.includeMedia, signal: abortController.signal,
      });
      return { ...data, exporterVersion: chrome.runtime.getManifest().version };
    }

    // Grok is tested FIRST: it marks messages with [data-testid="user-message"]
    // too, which is also Claude's selector, so a hostname check has to break
    // the tie before the Claude branch can claim the page.
    const isGrok = /(^|\.)grok\.com$/.test(location.hostname) &&
                   !!document.querySelector('[data-testid="user-message"],[data-testid="assistant-message"]');
    const isChatGPTHost = /(^|\.)(chatgpt\.com|chat\.openai\.com)$/.test(location.hostname);
    const isChatGPT = !isGrok && isChatGPTHost && (
      !!document.querySelector('[data-message-author-role]') || /\/c\/[^/?#]+/.test(location.pathname)
    );
    const isClaude = !isGrok && !!document.querySelector('[data-testid="user-message"]');
    const isGemini = !isGrok && !!document.querySelector('user-query');

    if (!isChatGPT && !isClaude && !isGemini && !isGrok) {
      throw new Error("No messages found. Open this on a Claude.ai, ChatGPT, Gemini, or Grok conversation.");
    }

    const siteName = isGrok ? "Grok" : (isChatGPT ? "ChatGPT" : (isClaude ? "Claude" : "Gemini"));
    updateProgress(`Detected ${siteName} tab. Scanning scroll container...`);

    // ChatGPT stores a conversation as a graph. Edits and regenerated replies
    // leave abandoned siblings in `mapping`; `current_node` identifies the one
    // active path shown in the UI. The DOM is virtualized, so a scroll sweep can
    // miss turns and data-testid turn numbers are not a conversation chain.
    // Fetch the graph first and use it as the authoritative order/content. The
    // DOM sweep below enriches messages with rendered Markdown and media when
    // those nodes happen to mount. It also provides a validated fallback if
    // ChatGPT's private endpoint is slow or changes again.
    let chatGptApiMessages = null;
    let chatGptConversationId = isChatGPT
      ? ((location.pathname.match(/\/c\/([^/?#]+)/) || [])[1] || null)
      : null;
    const chatGptProjectId = isChatGPT && globalThis.ChatGPTConversationGraph
      ? globalThis.ChatGPTConversationGraph.projectIdFromPath(location.pathname)
      : null;
    let chatGptApiError = null;
    if (isChatGPT) {
      const preloaded = chatGptContext && Array.isArray(chatGptContext.messages)
        ? chatGptContext.messages
        : null;
      if (preloaded && preloaded.length) {
        chatGptApiMessages = preloaded;
        updateProgress(`Using ${preloaded.length} authoritative ChatGPT messages loaded in page context.`);
      } else if (chatGptContext && chatGptContext.error) {
        // The authenticated MAIN-world request already produced the useful
        // error. An isolated content-script fetch cannot attach ChatGPT's page
        // request context, so retrying it only repeats the same 403 and buries
        // the real diagnostic in duplicated output.
        updateProgress("Authenticated ChatGPT chain request failed; skipping the unauthenticated duplicate retry.");
      } else {
        try {
          if (!chatGptConversationId) throw new Error("no conversation id in URL");
          if (!globalThis.ChatGPTConversationGraph) throw new Error("conversation graph helper unavailable");

          updateProgress("Retrying ChatGPT's active conversation chain in extension context...");
          const graphController = new AbortController();
          const forwardCancel = () => graphController.abort();
          const graphStartedAt = Date.now();
          const graphProgress = setInterval(() => {
            const seconds = Math.round((Date.now() - graphStartedAt) / 1000);
            updateProgress(`Still retrying ChatGPT's active chain (${seconds}s)...`);
          }, 10000);
          const graphTimer = setTimeout(() => graphController.abort(), 120000);
          abortController.signal.addEventListener("abort", forwardCancel, { once: true });
          try {
            const result = await globalThis.ChatGPTConversationGraph.fetchActiveMessages(
              chatGptConversationId,
              {
                headers: chatGptProjectId ? { "chatgpt-project-id": chatGptProjectId } : {},
                signal: graphController.signal,
              }
            );
            chatGptApiMessages = result.messages;
            updateProgress(`Found ${result.messages.length} messages on the active ChatGPT branch.`);
          } finally {
            clearTimeout(graphTimer);
            clearInterval(graphProgress);
            abortController.signal.removeEventListener("abort", forwardCancel);
          }
        } catch (e) {
          if (exportCancelled) throw new Error("Export cancelled.");
          chatGptApiMessages = null;
          chatGptApiError = String(e.message || e);
          updateProgress(`Extension-context ChatGPT chain request failed (${chatGptApiError}).`);
        }
      }

      // A normal ChatGPT conversation must never be exported from the
      // virtualized DOM. It may contain only the newest mounted window, which
      // is how a 169-message chat was incorrectly exported as 10 messages.
      if (chatGptConversationId && !chatGptApiMessages) {
        const errors = [
          chatGptContext && chatGptContext.error,
          chatGptApiError,
        ].filter(Boolean).join(" | ");
        throw new Error(
          "Could not load ChatGPT's complete root-to-current conversation chain" +
          (errors ? ": " + errors : ".") +
          " No file was created because a partial history is not a valid export."
        );
      }
    }

    // claude.ai virtualizes long chats so aggressively that a DOM sweep is
    // both slow (React mounts each window synchronously; ~20 min on a long
    // chat) and lossy (the DOM never mounts every message). The SPA's own
    // JSON API returns the entire conversation in one request — use it,
    // and keep the DOM sweep only as a fallback. Runs in the page context,
    // so the user's session cookies apply; nothing leaves claude.ai.
    let claudeApiData = null;
    if (isClaude) {
      try {
        updateProgress("Fetching conversation via claude.ai API (no scrolling needed)...");
        const convoId = (location.pathname.match(/\/chat\/([^/?#]+)/) || [])[1];
        if (!convoId) throw new Error("no conversation id in URL");
        const orgsRes = await fetch("/api/organizations", { credentials: "same-origin", signal: abortController.signal });
        if (!orgsRes.ok) throw new Error("organizations HTTP " + orgsRes.status);
        const orgs = await orgsRes.json();
        // The account may belong to several organizations; the conversation
        // lives in exactly one. Try chat-capable orgs first.
        const candidates = [
          ...orgs.filter(o => (o.capabilities || []).includes("chat")),
          ...orgs.filter(o => !(o.capabilities || []).includes("chat"))
        ];
        for (const org of candidates) {
          const res = await fetch(
            "/api/organizations/" + org.uuid + "/chat_conversations/" + convoId +
            "?tree=True&rendering_mode=messages&render_all_tools=true",
            { credentials: "same-origin", signal: abortController.signal }
          );
          if (res.ok) { claudeApiData = await res.json(); break; }
        }
        if (!claudeApiData || !Array.isArray(claudeApiData.chat_messages) || !claudeApiData.chat_messages.length) {
          claudeApiData = null;
          throw new Error("conversation not found via API");
        }
        updateProgress(`Fetched ${claudeApiData.chat_messages.length} messages via API.`);
      } catch (e) {
        claudeApiData = null;
        updateProgress(`claude.ai API path failed (${e.message || e}); falling back to page scrape.`);
      }
    }

    // ----- Find scroll container, force-load all turns -----
    const GROK_MSG_SELECTOR = '[data-testid="user-message"],[data-testid="assistant-message"]';

    let firstMsg;
    if (isGrok) firstMsg = document.querySelector(GROK_MSG_SELECTOR);
    else if (isChatGPT) firstMsg = document.querySelector('[data-message-author-role]');
    else if (isClaude) firstMsg = document.querySelector('[data-testid="user-message"]');
    else firstMsg = document.querySelector('user-query');

    let scrollEl = document.documentElement;
    let p = firstMsg;
    while (p && p.parentElement) {
      p = p.parentElement;
      const style = window.getComputedStyle(p);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 100) {
        scrollEl = p;
        break;
      }
    }

    function getScrollableElements() {
      const els = new Set([document.documentElement, document.body]);
      if (scrollEl) els.add(scrollEl);
      document.querySelectorAll('.overflow-y-auto, [style*="overflow-y: auto"], [style*="overflow: auto"], main').forEach(e => els.add(e));
      const geminiScroller = document.querySelector('infinite-scroller.chat-history');
      if (geminiScroller) els.add(geminiScroller);
      return Array.from(els);
    }

    function scrollTopTo(y) {
      window.scrollTo(0, y);
      getScrollableElements().forEach(el => {
        try { el.scrollTop = y; } catch(e) {}
      });
    }

    function scrollBy(dy) {
      window.scrollBy(0, dy);
      getScrollableElements().forEach(el => {
        try { el.scrollTop += dy; } catch(e) {}
      });
    }

    function currentTop() {
      let maxTop = window.scrollY || 0;
      getScrollableElements().forEach(el => {
        if (el && el.scrollTop > maxTop) {
          maxTop = el.scrollTop;
        }
      });
      return maxTop;
    }

    const initialClientH = window.innerHeight || 800;

    function clientH() {
      let h = window.innerHeight;
      if (scrollEl && scrollEl !== document.documentElement && scrollEl.clientHeight > 0) {
        h = scrollEl.clientHeight;
      }
      return Math.max(h, initialClientH, 600);
    }

    function getMaxScrollHeight() {
      let maxH = document.documentElement.scrollHeight || 0;
      getScrollableElements().forEach(el => {
        if (el && el.scrollHeight > maxH) maxH = el.scrollHeight;
      });
      return maxH;
    }

    // Kept as a hook point for the scroll loops. The background worker's
    // visibility patch + wake pulses keep a hidden tab progressing, so
    // there is nothing to do here anymore.
    async function ensureVisible() {}

    updateProgress("Loading full conversation history...");

    if (isClaude && claudeApiData) {
      // Full conversation already fetched via the API — no DOM prep needed.
    } else if (isClaude) {
      // Fallback DOM path: jump to the top, confirm the height is stable,
      // and let the capture sweep below visit every virtualized window.
      scrollTopTo(0);
      await sleep(600);
      let cLastH = getMaxScrollHeight();
      while (true) {
        checkCancelled();
        await sleep(300);
        const h = getMaxScrollHeight();
        if (h === cLastH) break;
        cLastH = h;
        scrollTopTo(0);
      }
    } else if (isGrok) {
      // Grok keeps every message mounted (verified live, 2026-07: a
      // 53-message chat had all 53 in the DOM with stable element
      // identity, and scrolling to the top loaded nothing new). Longer
      // chats may still paginate, so scroll up until the count stops
      // growing, then stop — on an already-complete chat this costs one
      // round and exits.
      const grokCount = () => document.querySelectorAll(GROK_MSG_SELECTOR).length;
      let gPrev = grokCount();
      let gEmpty = 0;

      while (gEmpty < 3) {
        checkCancelled();
        scrollTopTo(0);
        getScrollableElements().forEach(el => {
          try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
        });
        await sleep(700);
        const c = grokCount();
        if (c > gPrev) {
          gPrev = c;
          gEmpty = 0;
          updateProgress(`Loading history... ${c} messages`);
        } else {
          gEmpty++;
        }
      }
      updateProgress(`Page history captured: ${gPrev} messages; no older messages appeared.`);
    } else if (isChatGPT && chatGptApiMessages) {
      // The API graph already contains the complete active branch. Avoid the
      // old up/down scroll loops: ChatGPT virtualizes the DOM, and forcing the
      // entire page to supply message text was both slow and capable of
      // skipping turns. A separate media-only sweep runs later when needed.
      updateProgress(
        `Active ChatGPT chain loaded: ${chatGptApiMessages.length} messages. Text history scrolling is not needed.`
      );
    } else if (isGemini) {
      // The background worker keeps this in-place tab moving with wake pulses
      // and a requestAnimationFrame bridge. Trigger Gemini's lazy-loader by
      // scrolling the infinite-scroller to 0 and dispatching a scroll event.
      //
      // Verified live (2026-07, 340-message chat):
      //   - scrollTop=0 alone does NOT trigger the loader; the scroll
      //     event dispatch is required.
      //   - After each ~20-message batch, Gemini restores scrollTop back
      //     down, so every round must re-scroll to 0.
      //   - Batches can stall for 1-2 rounds then resume, so "done"
      //     requires several consecutive rounds with zero growth.
      const gScroller = () =>
        document.querySelector('infinite-scroller.chat-history') ||
        scrollEl || document.scrollingElement || document.documentElement;
      const msgCount = () => document.querySelectorAll('user-query, model-response').length;

      // The wait is adaptive rather than a flat timeout. A fixed 15s wait per
      // round meant an already-complete conversation sat silent for a full
      // minute (4 rounds x 15s) before the export moved on, which looked
      // exactly like a hang. While Gemini is rendering a batch its
      // scrollHeight keeps changing, so treat that as activity and keep
      // waiting; once the page goes quiet, stop waiting early.
      //
      // Quiet windows escalate across consecutive empty rounds. A batch that
      // is merely slow to come back from the server shows no scrollHeight
      // activity either, so bailing after one short quiet window would stop
      // early and drop the oldest messages -- the original Gemini bug. The
      // escalation keeps ~20s of total patience before concluding the top is
      // reached, while still reporting progress every few seconds.
      const QUIET_STEPS_MS = [2500, 4000, 6000, 8000];
      const MAX_WAIT_MS = 25000; // ceiling for one very large batch
      const DONE_AFTER_QUIET_ROUNDS = QUIET_STEPS_MS.length;

      let prevCount = msgCount();
      let emptyRounds = 0;
      updateProgress(`Loading history... ${prevCount} messages so far`);

      while (emptyRounds < DONE_AFTER_QUIET_ROUNDS) {
        checkCancelled();

        const sc = gScroller();
        sc.scrollTop = 0;
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));

        const quietMs = QUIET_STEPS_MS[Math.min(emptyRounds, QUIET_STEPS_MS.length - 1)];
        const started = Date.now();
        let lastActivity = Date.now();
        let lastHeight = sc.scrollHeight;
        let grew = false;

        while (Date.now() - started < MAX_WAIT_MS) {
          await sleep(250);
          checkCancelled();
          if (msgCount() > prevCount) { grew = true; break; }
          const h = gScroller().scrollHeight;
          if (h !== lastHeight) { lastHeight = h; lastActivity = Date.now(); }
          if (Date.now() - lastActivity > quietMs) break;
        }

        const now = msgCount();
        if (grew) {
          emptyRounds = 0;
          prevCount = now;
          updateProgress(`Loading history... ${now} messages`);
        } else {
          emptyRounds++;
          // Report every round so a slow load never looks like a freeze.
          updateProgress(`Loading history... ${now} messages (checking for older, ${emptyRounds}/${DONE_AFTER_QUIET_ROUNDS})`);
        }
      }

      updateProgress(`History loaded: ${msgCount()} messages.`);
      gScroller().scrollTop = 0;
      await sleep(300);
    } else {
      // ChatGPT DOM fallback. Put its real scroll container at the top and let
      // the virtualizer settle. The capture phase below performs one careful,
      // fine-grained downward pass and captures every mounted window as it goes.
      updateProgress("Preparing ChatGPT's validated page scan...");
      scrollTopTo(0);
      getScrollableElements().forEach(el => {
        try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch(e) {}
      });
      await sleep(500);
    }

    // ----- Media Bookkeeping -----
    const mediaQueue = [];  // [{ url, filename, kind, alt, mimeType, isLocal }]
    const urlToFilename = new Map();
    const mediaKeyToFilename = new Map();
    const filenameOwners = new Map();
    const mediaResolutionFailures = [];
    const interactiveMediaQueue = [];
    const interactiveElementTokens = new WeakMap();
    // ChatGPT only mounts a small moving window of long conversations. Keep
    // every signed attachment URL seen during the media-only scroll sweep so
    // an older URL is not lost as soon as React unmounts that message again.
    const renderedChatGptUrlsByFileId = new Map();
    const renderedChatGptUrlsByAttachmentKey = new Map();
    const attemptedChatGptFileCards = new Set();
    let chatGptMediaSweepResult = null;
    let chatGptFileCardsRecovered = 0;
    let chatGptFileCardsFailed = 0;
    let mediaCounter = 0;

    function sanitizeMediaBasename(value) {
      const raw = String(value || "").split(/[\\/]/).pop() || "";
      const withoutControls = Array.from(raw).filter(character => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      }).join('');
      return withoutControls
        .replace(/[^a-z0-9._ -]+/gi, "-")
        .replace(/\s+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 160);
    }

    function logicalMediaKey(absolute, suppliedKey) {
      if (suppliedKey) return String(suppliedKey);
      try {
        const parsed = new URL(absolute);
        const fileId = parsed.searchParams.get('id') || parsed.searchParams.get('file_id');
        if (fileId && /(?:chatgpt|openai|oaiusercontent)/i.test(parsed.hostname)) {
          return 'chatgpt-file:' + fileId;
        }
      } catch (error) {}
      return absolute;
    }

    function enqueueMedia(rawUrl, kind, alt, metadata = {}) {
      if (!options.includeMedia) return null;
      if (!rawUrl) return null;
      let absolute;
      try { absolute = new URL(rawUrl, location.href).href; } catch (e) { return null; }
      const logicalKey = logicalMediaKey(absolute, metadata.logicalKey);
      if (mediaKeyToFilename.has(logicalKey)) return mediaKeyToFilename.get(logicalKey);
      if (urlToFilename.has(absolute)) return urlToFilename.get(absolute);

      let filename = generateMediaFilename(
        absolute,
        kind,
        mediaCounter++,
        metadata.preferredFilename,
        metadata.mimeType
      );
      const bareFilename = filename;
      let collision = 2;
      while (filenameOwners.has(filename) && filenameOwners.get(filename) !== logicalKey) {
        const dot = bareFilename.lastIndexOf('.');
        filename = dot > 0
          ? bareFilename.slice(0, dot) + '-' + collision + bareFilename.slice(dot)
          : bareFilename + '-' + collision;
        collision++;
      }
      filenameOwners.set(filename, logicalKey);
      urlToFilename.set(absolute, filename);
      mediaKeyToFilename.set(logicalKey, filename);
      let isSameOrigin = false;
      try { isSameOrigin = new URL(absolute).origin === location.origin; } catch (error) {}
      const isLocal = metadata.forceLocal === true || isSameOrigin ||
        absolute.startsWith('blob:') || absolute.startsWith('data:');
      mediaQueue.push({
        url: absolute,
        filename,
        kind,
        alt: alt || "",
        mimeType: metadata.mimeType || "",
        isLocal,
      });
      return filename;
    }

    function generateMediaFilename(url, kind, idx, preferredFilename, mimeType) {
      let basePart = "";
      const preferred = sanitizeMediaBasename(preferredFilename);
      if (preferred) basePart = preferred;
      try {
        const u = new URL(url);
        const lastSeg = u.pathname.split('/').filter(Boolean).pop() || "";
        if (!basePart) basePart = lastSeg.split('?')[0];
      } catch (e) { basePart = ""; }
      basePart = sanitizeMediaBasename(basePart);
      const declaredExt = extFromMime(mimeType);
      const hasExt = /\.[a-z0-9]{1,12}$/i.test(basePart);
      if (basePart && hasExt) {
        return String(idx).padStart(3, '0') + '-' + basePart;
      }
      if (basePart && declaredExt) {
        return String(idx).padStart(3, '0') + '-' + basePart + declaredExt;
      }
      const prefix = kind === 'image' ? 'image'
                   : kind === 'video' ? 'video'
                   : kind === 'audio' ? 'audio'
                   : 'file';
      const ext = declaredExt || (kind === 'image' ? '.png'
                : kind === 'video' ? '.mp4'
                : kind === 'audio' ? '.mp3'
                : '.bin');
      return String(idx).padStart(3, '0') + '-' + prefix + ext;
    }

    function extFromMime(mime) {
      if (!mime) return null;
      const map = {
        'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
        'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
        'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
        'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.weba',
        'application/pdf': '.pdf', 'application/json': '.json',
        'text/plain': '.txt', 'text/csv': '.csv', 'text/markdown': '.md',
        'application/zip': '.zip'
      };
      return map[mime.split(';')[0].trim().toLowerCase()] || null;
    }

    const GEMINI_SKIP_TAGS = new Set([
      'message-actions', 'thumb-up-button', 'thumb-down-button',
      'copy-button', 'freemium-rag-disclaimer', 'sensitive-memories-banner',
      'election-info-disclaimer', 'fact-check-button'
    ]);

    const ATTACHMENT_EXTENSION_RE = /\.((?:pdf|csv|tsv|json|jsonl|zip|txt|md|markdown|docx?|xlsx?|pptx?|rtf|odt|ods|odp|epub|py|ipynb|js|mjs|cjs|ts|tsx|jsx|html|css|xml|yaml|yml|toml|sql|wav|mp3|m4a|ogg|flac|mp4|mov|m4v|webm|avi|png|jpe?g|gif|webp|svg|avif))(?:\s|$|[?#)\]])/i;

    function filenameFromLabel(value) {
      const label = String(value || "").trim().replace(
        /^(?:download|uploaded file|attachment|file)\s*:?\s*/i,
        ''
      );
      if (!label) return "";
      const matches = label.match(new RegExp(
        "([^\\\\/\\n]+" + ATTACHMENT_EXTENSION_RE.source + ")",
        "i"
      ));
      return sanitizeMediaBasename(matches ? matches[1].trim() : label);
    }

    function bestMediaSource(element) {
      const srcsets = [
        element.getAttribute('srcset'),
        element.getAttribute('data-srcset'),
      ];
      const picture = element.closest('picture');
      if (picture) {
        picture.querySelectorAll('source').forEach(source => {
          srcsets.push(source.getAttribute('srcset'), source.getAttribute('data-srcset'));
        });
      }

      let largestCandidate = '';
      let largestScore = -1;
      for (const srcset of srcsets.filter(Boolean)) {
        if (srcset.startsWith('data:')) continue;
        for (const entry of srcset.split(',')) {
          const parts = entry.trim().split(/\s+/);
          const url = parts[0];
          if (!url) continue;
          const descriptor = parts[1] || '1x';
          const widthMatch = descriptor.match(/^(\d+)w$/i);
          const densityMatch = descriptor.match(/^([\d.]+)x$/i);
          const score = widthMatch
            ? Number(widthMatch[1])
            : densityMatch
              ? Number(densityMatch[1]) * 1000
              : 1;
          if (score > largestScore) {
            largestScore = score;
            largestCandidate = url;
          }
        }
      }
      if (largestCandidate) return largestCandidate;

      const direct = element.currentSrc || element.src ||
        element.getAttribute('src') || element.getAttribute('data-src') ||
        element.getAttribute('data-original') || element.getAttribute('data-url');
      if (direct) return direct;
      return '';
    }

    function semanticMediaMarker(element) {
      return [
        typeof element.className === 'string' ? element.className : '',
        element.getAttribute('data-testid') || '',
        element.getAttribute('data-test-id') || '',
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
      ].join(' ').toLowerCase();
    }

    function isDecorativeImage(element, src, alt) {
      const marker = semanticMediaMarker(element);
      if (
        element.getAttribute('data-test-id') === 'luminous-file-icon' ||
        /\bfile[-_ ]?icon\b/i.test(marker) ||
        /drive-thirdparty\.googleusercontent\.com\/\d+\/type\//i.test(src || '')
      ) return true;
      const ancestor = element.closest(
        'nav, header, message-actions, sources-list, [class*="message-action"], ' +
        '[class*="source-icon"], [class*="youtube"], [data-testid*="avatar"]'
      );
      if (ancestor) return true;
      if (/\/s2\/favicons|favicon(?:s)?\b/i.test(src || '')) return true;
      if (element.getAttribute('aria-hidden') === 'true') return true;

      const semanticContent = element.closest(
        '[class*="attachment"], [class*="uploaded"], [class*="generated-image"], ' +
        '[class*="image-container"], [data-testid*="attachment"], [data-testid*="image"]'
      );
      if (semanticContent) return false;

      const width = element.naturalWidth || element.width || 0;
      const height = element.naturalHeight || element.height || 0;
      if (/\b(?:avatar|profile|logo|icon|emoji|badge)\b/i.test(marker) && !alt) return true;
      return width > 0 && height > 0 && width <= 48 && height <= 48 && !alt;
    }

    function backgroundMediaUrl(element) {
      const marker = semanticMediaMarker(element);
      if (!/(?:generated|attachment|uploaded|media|image)[-_ ]?(?:preview|container|card|tile)?/i.test(marker)) {
        return '';
      }
      if (element.querySelector('img, video, audio')) return '';
      const value = getComputedStyle(element).backgroundImage || '';
      const match = value.match(/^url\(["']?(.*?)["']?\)$/i);
      return match ? match[1] : '';
    }

    function elementAttachmentInfo(element) {
      const marker = semanticMediaMarker(element);
      const label = (
        element.getAttribute('download') || element.getAttribute('title') ||
        element.getAttribute('aria-label') || element.innerText || element.textContent || ''
      ).trim();
      const href = element.getAttribute('href') ||
        element.getAttribute('data-download-url') || element.getAttribute('data-file-url') ||
        element.getAttribute('data-attachment-url') || element.getAttribute('data-url') || '';
      const semantic = /(?:attachment|uploaded|file[-_ ]?(?:card|chip|preview)|document[-_ ]?(?:card|preview))/i.test(marker);
      const filename = filenameFromLabel(label);
      const namedFile = ATTACHMENT_EXTENSION_RE.test(label) || ATTACHMENT_EXTENSION_RE.test(href);
      if (!semantic && !namedFile && !element.hasAttribute('download')) return null;
      if (!href || href === '#') {
        const interactive = element.tagName === 'BUTTON' || element.getAttribute('role') === 'button';
        if (!interactive || !namedFile) return null;
        return {
          href: '',
          interactive: true,
          label: label || filename || 'attachment',
          filename: filename || label,
        };
      }
      return {
        href,
        interactive: false,
        label: label || filename || 'attachment',
        filename: filename || label,
      };
    }

    function enqueueInteractiveMedia(element, info) {
      const existing = interactiveElementTokens.get(element);
      if (existing) return existing;
      const token = '@@AI_CHAT_EXPORT_INTERACTIVE_MEDIA_' + interactiveMediaQueue.length + '@@';
      interactiveElementTokens.set(element, token);
      interactiveMediaQueue.push({
        element,
        info,
        token,
        replacement: '*Attachment unavailable: ' + info.label + '*',
      });
      return token;
    }

    // ----- Walk DOM to generate Markdown -----
    function nodeToMarkdown(node) {
      if (!node) return "";
      let out = "";
      node.childNodes.forEach(child => {
        if (child.nodeType === 3) { out += child.nodeValue; return; }
        if (child.nodeType !== 1) return;
        if (child.classList && (
          child.classList.contains('cdk-visually-hidden') ||
          child.classList.contains('sr-only') ||
          child.classList.contains('visually-hidden')
        )) return;
        const tag = child.tagName.toLowerCase();

        if (GEMINI_SKIP_TAGS.has(tag)) return;

        // Grok wraps its reasoning trace in .thinking-container; honour the
        // "Include Thinking" toggle rather than always inlining it.
        if (child.classList && child.classList.contains('thinking-container')) {
          if (!options.includeThinking) return;
          const think = cleanText(nodeToMarkdown(child));
          if (think) out += '\n\n*Thinking:*\n\n> ' + think.replace(/\n/g, '\n> ') + '\n\n';
          return;
        }

        // ----- Media capture -----
        if (tag === 'img') {
          const src = bestMediaSource(child);
          const alt = globalThis.AIChatExporterBrowserAdapters.imageLabel(child, isGemini);
          if (!src || isDecorativeImage(child, src, alt)) return;
          if (isChatGPT && chatGptApiMessages) return;

          const fname = enqueueMedia(src, 'image', alt, {
            preferredFilename: filenameFromLabel(alt),
            mimeType: child.getAttribute('type') || '',
          });
          const altText = alt ? ` - "${alt}"` : '';
          if (fname) {
            out += '\n\n![' + alt + '](media/' + fname + ')\n*(Image: `media/' + fname + '`' + altText + ')*\n\n';
          } else {
            out += '\n\n![' + alt + '](' + src + ')\n*(Image: <' + src + '>' + altText + ')*\n\n';
          }
          return;
        }
        if (tag === 'video') {
          if (isChatGPT && chatGptApiMessages) return;
          let vSrc = child.currentSrc || child.src || child.getAttribute('src');
          if (!vSrc) {
            const srcEl = child.querySelector('source');
            if (srcEl) vSrc = srcEl.src || srcEl.getAttribute('src');
          }
          const fname2 = enqueueMedia(vSrc, 'video', '', {
            mimeType: child.getAttribute('type') || '',
          });
          if (fname2) {
            out += '\n\n[🎬 video: media/' + fname2 + '](media/' + fname2 + ')\n*(Uploaded Video: `media/' + fname2 + '`)*\n\n';
          } else if (vSrc) {
            out += '\n\n[🎬 video](' + vSrc + ')\n*(Uploaded Video: <' + vSrc + '>)*\n\n';
          }
          return;
        }
        if (tag === 'audio') {
          if (isChatGPT && chatGptApiMessages) return;
          let aSrc = child.currentSrc || child.src || child.getAttribute('src');
          if (!aSrc) {
            const srcEl2 = child.querySelector('source');
            if (srcEl2) aSrc = srcEl2.src || srcEl2.getAttribute('src');
          }
          const fname3 = enqueueMedia(aSrc, 'audio', '', {
            mimeType: child.getAttribute('type') || '',
          });
          if (fname3) {
            out += '\n\n[🔊 audio: media/' + fname3 + '](media/' + fname3 + ')\n*(Uploaded Audio: `media/' + fname3 + '`)*\n\n';
          } else if (aSrc) {
            out += '\n\n[🔊 audio](' + aSrc + ')\n*(Uploaded Audio: <' + aSrc + '>)*\n\n';
          }
          return;
        }
        if (tag === 'canvas') {
          if (isChatGPT && chatGptApiMessages) return;
          const width = child.width || child.clientWidth || 0;
          const height = child.height || child.clientHeight || 0;
          const marker = semanticMediaMarker(child);
          if (
            width < 64 || height < 64 ||
            /\b(?:avatar|logo|icon|spinner|loading)\b/i.test(marker) ||
            child.closest('message-actions, [class*="message-action"]')
          ) return;
          try {
            const label = child.getAttribute('aria-label') || child.getAttribute('title') || 'canvas image';
            const dataUrl = child.toDataURL('image/png');
            const canvasFilename = enqueueMedia(dataUrl, 'image', label, {
              preferredFilename: filenameFromLabel(label) || 'canvas-image.png',
              mimeType: 'image/png',
              logicalKey: 'canvas:' + captureOrder + ':' + mediaCounter,
              forceLocal: true,
            });
            if (canvasFilename) {
              out += '\n\n![' + label + '](media/' + canvasFilename + ')\n\n';
            }
          } catch (error) {
            // A cross-origin canvas may be tainted. Its underlying IMG or
            // video source is collected separately when the page exposes it.
          }
          return;
        }

        const backgroundUrl = backgroundMediaUrl(child);
        if (backgroundUrl && !(isChatGPT && chatGptApiMessages)) {
          const backgroundLabel = child.getAttribute('aria-label') || child.getAttribute('title') || 'image';
          const backgroundFilename = enqueueMedia(backgroundUrl, 'image', backgroundLabel, {
            preferredFilename: filenameFromLabel(backgroundLabel),
          });
          if (backgroundFilename) {
            out += '\n\n![' + backgroundLabel + '](media/' + backgroundFilename + ')\n\n';
            return;
          }
        }

        if (tag !== 'a') {
          const attachmentInfo = elementAttachmentInfo(child);
          if (attachmentInfo && !(isChatGPT && chatGptApiMessages)) {
            if (attachmentInfo.interactive) {
              if (options.includeMedia) {
                out += enqueueInteractiveMedia(child, attachmentInfo);
              } else {
                out += '*File: ' + attachmentInfo.label + '*';
              }
              return;
            }
            const attachmentFilename = enqueueMedia(
              attachmentInfo.href,
              'attachment',
              attachmentInfo.label,
              { preferredFilename: attachmentInfo.filename }
            );
            if (attachmentFilename) {
              out += '[📎 ' + attachmentInfo.label + '](media/' + attachmentFilename +
                ') *(Uploaded File: `media/' + attachmentFilename + '`)*';
              return;
            }
          }
        }

        // Link attachments
        if (tag === 'a') {
          const href = child.getAttribute('href') || '';
          // Image galleries frequently wrap their only IMG in a navigation
          // link. Treat the rendered media as the content instead of reducing
          // it to an empty Markdown link and silently losing the image.
          if (child.querySelector('img, picture, video, audio, canvas')) {
            const nestedMedia = nodeToMarkdown(child);
            if (/media\/[a-z0-9._ -]+/i.test(nestedMedia)) {
              out += nestedMedia;
              return;
            }
          }
          const attachmentInfo = elementAttachmentInfo(child);
          if (attachmentInfo && !(isChatGPT && chatGptApiMessages)) {
            const label = attachmentInfo.label;
            const fname4 = enqueueMedia(href, 'attachment', label, {
              preferredFilename: attachmentInfo.filename,
            });
            if (fname4) {
              out += '[📎 ' + (label || fname4) + '](media/' + fname4 + ') *(Uploaded File: `media/' + fname4 + '`)*';
              return;
            }
          }
          if (href && href !== '#') {
            out += '[' + (child.innerText || href) + '](' + href + ')';
            return;
          }
        }

        // ----- Text formatting -----
        if (tag === 'pre') {
          const codeEl = child.querySelector('code') || child;
          const classNames = (codeEl.className || '') + ' ' + (child.className || '');
          const langMatch = classNames.match(/(?:language-|lang-|hljs language-)([a-z0-9+#-]+)/i);
          const lang = langMatch ? langMatch[1] : '';
          const codeText = codeEl.innerText.replace(/\n+$/, '');
          out += '\n\n```' + lang + '\n' + codeText + '\n```\n\n';
          return;
        }
        if (tag === 'code' && child.parentElement && child.parentElement.tagName.toLowerCase() !== 'pre') {
          out += '`' + child.innerText + '`';
          return;
        }
        if (tag === 'br') { out += '\n'; return; }
        if (tag === 'p' || tag === 'div') { out += nodeToMarkdown(child) + '\n\n'; return; }
        if (tag === 'li') { out += '- ' + nodeToMarkdown(child) + '\n'; return; }
        if (tag === 'strong' || tag === 'b') { out += '**' + nodeToMarkdown(child) + '**'; return; }
        if (tag === 'em' || tag === 'i') { out += '*' + nodeToMarkdown(child) + '*'; return; }
        if (/^h[1-6]$/.test(tag)) {
          const n = parseInt(tag.slice(1), 10);
          out += '\n\n' + '#'.repeat(n) + ' ' + nodeToMarkdown(child) + '\n\n';
          return;
        }
        out += nodeToMarkdown(child);
      });
      return out;
    }

    function cleanText(s) { return s.replace(/\n{3,}/g, '\n\n').trim(); }

    function cleanGeminiText(s) {
      return s.replace(/\s{2,}[A-Z]{2,5}(?:\+\s*\d+)?\s*$/gm, '');
    }

    function withoutChatGptAttachmentPlaceholders(value) {
      return cleanText(String(value || '')
        .replace(/^\*Attached: [^\n]+\*\s*$/gm, '')
        .replace(/^\*Image attached\*\s*$/gm, ''));
    }

    function chatGptAttachmentName(message, attachment, index) {
      if (attachment && attachment.name) return attachment.name;
      const shortId = String(
        attachment && attachment.fileId || message && message.id || index + 1
      ).replace(/[^a-z0-9_-]/gi, '').slice(-24);
      const kind = attachment && attachment.kind;
      const ext = extFromMime(attachment && attachment.mimeType) ||
        (kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : kind === 'audio' ? '.mp3' : '.bin');
      return 'chatgpt-' + (kind === 'attachment' ? 'file' : kind || 'file') + '-' +
        (shortId || String(index + 1)) + ext;
    }

    function normalizeChatGptFileId(value) {
      if (!value) return '';
      try {
        return decodeURIComponent(String(value)).replaceAll('#', '*');
      } catch (error) {
        return String(value).replaceAll('#', '*');
      }
    }

    function unresolvedChatGptAttachmentCount(messages) {
      let count = 0;
      for (const message of messages || []) {
        for (const attachment of message.attachments || []) {
          if (!attachment.url && attachment.fileId) count++;
        }
      }
      return count;
    }

    function chatGptExpectedFileIds(messages) {
      const expected = new Set();
      for (const message of messages || []) {
        for (const attachment of message.attachments || []) {
          if (!attachment.url && attachment.fileId) {
            expected.add(normalizeChatGptFileId(attachment.fileId));
          }
        }
      }
      return expected;
    }

    function chatGptAttachmentRecoveryKey(message, attachmentIndex, messageIndex) {
      return String(message && message.id || 'message-' + messageIndex) + ':' + attachmentIndex;
    }

    function normalizedChatGptAttachmentName(value) {
      return sanitizeMediaBasename(
        String(value || '').replace(/^open image:\s*/i, '')
      ).toLowerCase();
    }

    function renderedChatGptCandidateUrls(element) {
      const values = [];
      const attributes = [
        'src',
        'href',
        'data-src',
        'data-download-url',
        'data-attachment-url',
        'data-file-url',
        'poster',
      ];

      for (const attribute of attributes) {
        const raw = attribute === 'src' && element.currentSrc
          ? element.currentSrc
          : element.getAttribute && element.getAttribute(attribute);
        if (raw) values.push(raw);
      }

      for (const attribute of ['srcset', 'data-srcset']) {
        const srcset = element.getAttribute && element.getAttribute(attribute);
        if (!srcset || srcset.startsWith('data:')) continue;
        for (const entry of srcset.split(',')) {
          const candidate = entry.trim().split(/\s+/)[0];
          if (candidate) values.push(candidate);
        }
      }
      return values;
    }

    function chatGptFileIdsFromRenderedUrl(url) {
      if (globalThis.ChatGPTConversationGraph &&
          typeof globalThis.ChatGPTConversationGraph.renderedMediaFileIds === 'function') {
        return new Set(
          globalThis.ChatGPTConversationGraph.renderedMediaFileIds(url.href, location.href)
        );
      }

      const ids = new Set();
      const pathMatch = url.pathname.match(/\/files\/download\/([^/?#]+)/i);
      for (const value of [
        url.searchParams.get('id'),
        url.searchParams.get('file_id'),
        pathMatch && pathMatch[1],
      ]) {
        if (value) ids.add(normalizeChatGptFileId(value));
      }

      // Some current oaiusercontent URLs put the file id in the path rather
      // than a query parameter. Only exact ids that exist in the authoritative
      // conversation graph are accepted by the collector below.
      if (!ids.size) {
        let decodedHref = url.href;
        try { decodedHref = decodeURIComponent(decodedHref); } catch (error) {}
        const embeddedMatches = decodedHref.match(/file[-_][a-z0-9_-]{6,}/gi) || [];
        embeddedMatches.forEach(value => ids.add(normalizeChatGptFileId(value)));
      }
      return ids;
    }

    function isChatGptRenderedAttachmentUrl(url) {
      const hostname = url.hostname.toLowerCase();
      const pathname = url.pathname.toLowerCase();
      return (
        /(^|\.)(?:chatgpt\.com|openai\.com)$/.test(hostname) &&
          /\/(?:backend-api\/estuary\/content|backend-api\/files\/download)\b/.test(pathname)
      ) || /(^|\.)oaiusercontent\.com$/.test(hostname) ||
        /(^|\.)blob\.core\.windows\.net$/.test(hostname);
    }

    function renderedChatGptMediaLabel(element) {
      const labelledButton = element.closest && element.closest('button[aria-label]');
      const values = [
        labelledButton && labelledButton.getAttribute('aria-label'),
        element.getAttribute && element.getAttribute('aria-label'),
        element.getAttribute && element.getAttribute('alt'),
        element.getAttribute && element.getAttribute('title'),
      ].filter(Boolean);
      return values.find(value => ATTACHMENT_EXTENSION_RE.test(value)) || values[0] || '';
    }

    function collectRenderedChatGptAttachmentUrls(messages) {
      const expectedFileIds = chatGptExpectedFileIds(messages);
      if (!expectedFileIds.size) return 0;

      let discovered = 0;
      document.querySelectorAll(
        '[data-message-author-role] img, [data-message-author-role] video, ' +
        '[data-message-author-role] audio, [data-message-author-role] source, ' +
        '[data-message-author-role] a[href], ' +
        '[data-message-author-role] [data-download-url], ' +
        '[data-message-author-role] [data-attachment-url], ' +
        '[data-message-author-role] [data-file-url]'
      ).forEach(element => {
        for (const raw of renderedChatGptCandidateUrls(element)) {
          try {
            const url = new URL(raw, location.href);
            if (!/^https?:$/.test(url.protocol)) continue;
            for (const fileId of chatGptFileIdsFromRenderedUrl(url)) {
              if (!expectedFileIds.has(fileId) || renderedChatGptUrlsByFileId.has(fileId)) {
                continue;
              }
              renderedChatGptUrlsByFileId.set(fileId, url.href);
              discovered++;
            }
          } catch (error) {}
        }
      });

      // Current ChatGPT sometimes renders an old image through a replacement
      // Estuary id while the conversation graph still names the expired
      // original file id. Match that case only inside the same message. Prefer
      // the visible file name, then use DOM order only for an unambiguous
      // one-to-one set of remaining image attachments and rendered images.
      const messagesById = new Map();
      (messages || []).forEach((message, messageIndex) => {
        if (message && message.id) messagesById.set(String(message.id), { message, messageIndex });
      });

      document.querySelectorAll('[data-message-author-role][data-message-id]').forEach(messageRoot => {
        const entry = messagesById.get(String(messageRoot.getAttribute('data-message-id') || ''));
        if (!entry) return;
        const { message, messageIndex } = entry;
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        const unresolvedImages = attachments.map((attachment, attachmentIndex) => ({
          attachment,
          attachmentIndex,
          key: chatGptAttachmentRecoveryKey(message, attachmentIndex, messageIndex),
          name: normalizedChatGptAttachmentName(attachment && attachment.name),
        })).filter(item => (
          !item.attachment.url &&
          item.attachment.kind === 'image' &&
          !renderedChatGptUrlsByAttachmentKey.has(item.key)
        ));
        if (!unresolvedImages.length) return;
        const resolvedImages = attachments.filter(attachment => (
          attachment && attachment.kind === 'image' && attachment.url
        ));
        const resolvedImageUrls = new Set(resolvedImages.map(attachment => attachment.url));
        const resolvedImageNames = new Set(
          resolvedImages.map(attachment => normalizedChatGptAttachmentName(attachment.name)).filter(Boolean)
        );

        const attachmentFileIds = new Set(
          attachments.map(attachment => normalizeChatGptFileId(attachment && attachment.fileId)).filter(Boolean)
        );
        const candidates = [];
        const seenUrls = new Set();
        messageRoot.querySelectorAll('img, video, audio, source').forEach(element => {
          for (const raw of renderedChatGptCandidateUrls(element)) {
            let url;
            try { url = new URL(raw, location.href); } catch (error) { continue; }
            if (!/^https?:$/.test(url.protocol) || !isChatGptRenderedAttachmentUrl(url)) continue;
            if (seenUrls.has(url.href)) continue;
            const renderedName = normalizedChatGptAttachmentName(renderedChatGptMediaLabel(element));
            if (resolvedImageUrls.has(url.href) || renderedName && resolvedImageNames.has(renderedName)) {
              continue;
            }

            const renderedFileIds = chatGptFileIdsFromRenderedUrl(url);
            if (Array.from(renderedFileIds).some(fileId => attachmentFileIds.has(fileId))) {
              // Exact identity is already retained by the file-id map above.
              continue;
            }
            seenUrls.add(url.href);
            candidates.push({
              url: url.href,
              name: renderedName,
            });
            break;
          }
        });
        if (!candidates.length) return;

        const remainingAttachments = unresolvedImages.slice();
        const remainingCandidates = candidates.slice();
        for (let candidateIndex = remainingCandidates.length - 1; candidateIndex >= 0; candidateIndex--) {
          const candidate = remainingCandidates[candidateIndex];
          if (!candidate.name) continue;
          const matches = remainingAttachments.filter(item => item.name && item.name === candidate.name);
          if (matches.length !== 1) continue;
          const match = matches[0];
          renderedChatGptUrlsByAttachmentKey.set(match.key, {
            url: candidate.url,
            strategy: 'same-message rendered media filename match',
          });
          remainingAttachments.splice(remainingAttachments.indexOf(match), 1);
          remainingCandidates.splice(candidateIndex, 1);
          discovered++;
        }

        if (
          !resolvedImages.length &&
          remainingAttachments.length &&
          remainingAttachments.length === remainingCandidates.length
        ) {
          remainingAttachments.forEach((item, index) => {
            renderedChatGptUrlsByAttachmentKey.set(item.key, {
              url: remainingCandidates[index].url,
              strategy: 'same-message rendered media order match',
            });
            discovered++;
          });
        }
      });
      return discovered;
    }

    function applyRenderedChatGptAttachmentUrls(messages) {
      let enriched = 0;
      (messages || []).forEach((message, messageIndex) => {
        (message.attachments || []).forEach((attachment, attachmentIndex) => {
          if (attachment.url || !attachment.fileId) return;
          const renderedUrl = renderedChatGptUrlsByFileId.get(
            normalizeChatGptFileId(attachment.fileId)
          );
          const contextual = renderedChatGptUrlsByAttachmentKey.get(
            chatGptAttachmentRecoveryKey(message, attachmentIndex, messageIndex)
          );
          if (!renderedUrl && !contextual) return;
          attachment.url = renderedUrl || contextual.url;
          attachment.resolutionStrategy = renderedUrl
            ? 'rendered history signed media URL'
            : contextual.strategy;
          enriched++;
        });
      });
      return enriched;
    }

    function enrichChatGptAttachmentsFromRenderedDom(messages) {
      collectRenderedChatGptAttachmentUrls(messages);
      return applyRenderedChatGptAttachmentUrls(messages);
    }

    function dispatchChatGptScroll(scroller) {
      try { scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (error) {}
      try { window.dispatchEvent(new Event('scroll')); } catch (error) {}
    }

    function dispatchChatGptHistoryInput(scroller, viewportHeight) {
      const distance = Math.max(1200, Math.floor(viewportHeight * 6));
      const target = scroller.querySelector('[data-message-author-role]') || scroller;

      // ChatGPT's older-history loader is driven by upward input. A direct
      // scrollTop=0 assignment can leave its top sentinel idle, especially in
      // an occluded tab. Send the same wheel direction the page expects, then
      // make a real scroll-position transition for its observer and scroll
      // handlers. The event is synthetic, but React still receives it and the
      // position transition also covers an IntersectionObserver loader.
      try {
        target.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          composed: true,
          deltaMode: 0,
          deltaY: -distance,
          view: window,
        }));
      } catch (error) {}

      const current = Number(scroller.scrollTop || 0);
      if (current <= 1) {
        try {
          scroller.scrollTop = 1;
          void scroller.offsetHeight;
          dispatchChatGptScroll(scroller);
        } catch (error) {}
      }
      try { scroller.scrollTop = Math.max(0, current - distance); } catch (error) {}
      dispatchChatGptScroll(scroller);
    }

    function chatGptMessageIsMounted(messageId) {
      if (!messageId) return false;
      return Array.from(document.querySelectorAll('[data-message-id]')).some(
        root => String(root.getAttribute('data-message-id') || '') === String(messageId)
      );
    }

    function interactiveViewerSelector() {
      return [
        '.drive-viewer-shown',
        '[aria-label="Showing viewer."]',
        'dialog[open]',
        '[role="dialog"]',
        '[data-state="open"][class*="modal"]',
        '[data-state="open"][class*="dialog"]',
        '[data-testid*="file-preview"][role="dialog"]',
        '[data-testid*="attachment-preview"][role="dialog"]',
        '.content-sheet.popup',
      ].join(', ');
    }

    function closeInteractiveViewer(viewer) {
      if (!viewer) return;
      const closeButton = viewer.querySelector(
        '.drive-viewer-close-button, [aria-label="Close"], ' +
        'button[aria-label*="close" i], header button'
      ) || viewer.querySelector('button');
      if (closeButton) {
        try { closeButton.click(); } catch (error) {}
      }
    }

    async function readMountedTextFileCard(element, name) {
      const selector = interactiveViewerSelector();
      const preexisting = new Set(document.querySelectorAll(selector));
      element.click();

      const started = Date.now();
      let openedViewer = null;
      let lastText = null;
      let stableTextRounds = 0;
      try {
        while (Date.now() - started < 8000) {
          await sleep(150);
          checkCancelled();
          const candidates = Array.from(document.querySelectorAll(selector));
          openedViewer = candidates.find(candidate => !preexisting.has(candidate)) ||
            candidates.find(candidate => (
              candidate.matches('.content-sheet.popup') &&
              (!name || String(candidate.textContent || '').toLowerCase().includes(
                String(name).toLowerCase()
              ))
            )) || null;
          if (!openedViewer) continue;

          const directElement = openedViewer.querySelector(
            'a[download][href], a[href*="/download"], [data-download-url], ' +
            '[data-file-url], [data-attachment-url]'
          );
          const directUrl = directElement && (
            directElement.getAttribute('href') ||
            directElement.getAttribute('data-download-url') ||
            directElement.getAttribute('data-file-url') ||
            directElement.getAttribute('data-attachment-url') || ''
          );
          if (directUrl) return { directUrl, viewerText: null };

          let viewerText = null;
          const textNode = openedViewer.querySelector(
            '.drive-viewer-text-page, .drive-viewer-text-content pre, pre[data-file-content], ' +
            '[data-testid*="file-preview"] pre, [data-testid*="attachment-preview"] pre'
          );
          if (textNode) {
            viewerText = textNode.textContent || '';
          } else {
            const editorLines = openedViewer.querySelectorAll(
              '.cm-content .cm-line, .monaco-editor .view-line'
            );
            if (editorLines.length) {
              viewerText = Array.from(editorLines, line => line.textContent || '').join('\n');
            } else if (openedViewer.matches('.content-sheet.popup')) {
              // Current ChatGPT file previews use a role-less content sheet.
              // Its middle direct child is the preview body. Do not mistake a
              // permanent loading or error state for the original file.
              const body = Array.from(openedViewer.children).find(
                child => child.tagName === 'DIV'
              );
              const bodyText = body && (body.textContent || '');
              if (
                bodyText &&
                !/(?:loading|please wait)/i.test(bodyText) &&
                !/(?:failed|error|unable|cannot|not found|unavailable|forbidden)/i.test(bodyText)
              ) {
                viewerText = bodyText;
              }
            }
          }

          if (viewerText !== null) {
            if (viewerText === lastText) stableTextRounds++;
            else stableTextRounds = 0;
            lastText = viewerText;
            if (stableTextRounds >= 2) return { directUrl: '', viewerText };
          }
        }
        throw new Error(
          'ChatGPT file viewer exposed neither original text nor a download URL for ' + name
        );
      } finally {
        closeInteractiveViewer(openedViewer);
        if (openedViewer) await sleep(100);
      }
    }

    async function recoverMountedChatGptTextFileCards(messages) {
      const messagesById = new Map();
      (messages || []).forEach((message, messageIndex) => {
        if (message && message.id) messagesById.set(String(message.id), { message, messageIndex });
      });

      let recovered = 0;
      for (const messageRoot of document.querySelectorAll(
        '[data-message-author-role][data-message-id]'
      )) {
        checkCancelled();
        const entry = messagesById.get(String(messageRoot.getAttribute('data-message-id') || ''));
        if (!entry) continue;
        const { message, messageIndex } = entry;
        const unresolved = (message.attachments || []).map((attachment, attachmentIndex) => ({
          attachment,
          attachmentIndex,
          key: chatGptAttachmentRecoveryKey(message, attachmentIndex, messageIndex),
          name: normalizedChatGptAttachmentName(attachment && attachment.name),
        })).filter(item => (
          !item.attachment.url &&
          item.name &&
          isTextUpload(item.attachment.name)
        ));
        if (!unresolved.length) continue;

        const controls = Array.from(messageRoot.querySelectorAll('button, [role="button"]'))
          .map(element => ({ element, info: elementAttachmentInfo(element) }))
          .filter(item => item.info && item.info.interactive && isTextUpload(item.info.filename));
        if (!controls.length) continue;

        const usedControls = new Set();
        for (const item of unresolved) {
          if (attemptedChatGptFileCards.has(item.key)) continue;
          const exactMatches = controls.filter((control, controlIndex) => (
            !usedControls.has(controlIndex) &&
            normalizedChatGptAttachmentName(control.info.filename || control.info.label) === item.name
          ));
          let control = exactMatches.length === 1 ? exactMatches[0] : null;
          let controlIndex = control ? controls.indexOf(control) : -1;
          if (!control && unresolved.length === 1 && controls.length === 1) {
            control = controls[0];
            controlIndex = 0;
          }
          if (!control) continue;

          attemptedChatGptFileCards.add(item.key);
          usedControls.add(controlIndex);
          try {
            const result = await readMountedTextFileCard(
              control.element,
              item.attachment.name || control.info.filename
            );
            if (result.viewerText !== null) {
              const mimeType = textUploadMimeType(item.attachment.name);
              const blob = new Blob([result.viewerText], { type: mimeType });
              item.attachment.url = URL.createObjectURL(blob);
              item.attachment.mimeType = item.attachment.mimeType || mimeType;
              item.attachment.resolutionStrategy = 'ChatGPT rendered file viewer text';
            } else if (result.directUrl) {
              item.attachment.url = new URL(result.directUrl, location.href).href;
              item.attachment.resolutionStrategy = 'ChatGPT rendered file viewer download';
            }
            if (item.attachment.url) {
              recovered++;
              chatGptFileCardsRecovered++;
            }
          } catch (error) {
            chatGptFileCardsFailed++;
            item.attachment.viewerError = String(error && error.message || error);
          }
        }
      }
      return recovered;
    }

    async function sweepRenderedChatGptAttachmentUrls(messages) {
      const unresolvedBefore = unresolvedChatGptAttachmentCount(messages);
      if (!options.includeMedia || !unresolvedBefore) {
        return {
          unresolvedBefore,
          recovered: 0,
          remaining: unresolvedBefore,
          discovered: 0,
          exactMatches: 0,
          contextualMatches: 0,
          historyInitialHeight: 0,
          historyFinalHeight: 0,
          historyLoadRounds: 0,
          historyGrowthEvents: 0,
          historyRootReached: false,
          fileCardsRecovered: 0,
          fileCardsFailed: 0,
        };
      }

      const scroller = scrollEl || document.scrollingElement || document.documentElement;
      const viewportHeight = () => Math.max(
        scroller.clientHeight || 0,
        window.innerHeight || 0,
        600
      );
      const maxTop = () => Math.max(0, (scroller.scrollHeight || 0) - viewportHeight());
      const originalTop = scroller.scrollTop || 0;
      const originalWasNearBottom = originalTop >= maxTop() - 120;
      const discoveredAtStart = renderedChatGptUrlsByFileId.size;
      const contextualAtStart = renderedChatGptUrlsByAttachmentKey.size;
      const historyInitialHeight = Number(scroller.scrollHeight || 0);
      let historyMaxHeight = historyInitialHeight;
      let historyLoadRounds = 0;
      let historyGrowthEvents = 0;
      const oldestExpectedMessage = (messages || []).find(message => message && message.id);
      const oldestExpectedMessageId = oldestExpectedMessage && oldestExpectedMessage.id;
      let historyRootReached = chatGptMessageIsMounted(oldestExpectedMessageId);
      let lastProgressAt = 0;

      updateProgress(
        `Scanning rendered ChatGPT history for ${unresolvedBefore} attachment(s) denied by the file service...`
      );

      const collect = () => {
        collectRenderedChatGptAttachmentUrls(messages);
        return renderedChatGptUrlsByFileId.size - discoveredAtStart +
          renderedChatGptUrlsByAttachmentKey.size - contextualAtStart;
      };

      try {
        // First retain anything mounted at the user's original position.
        collect();

        // The authoritative graph tells us the actual first visible message.
        // Keep driving ChatGPT upward until that exact root message mounts.
        // Height-based quiet rounds are not a completion signal: on long chats
        // ChatGPT can remain quiet for several seconds and then prepend another
        // large batch while re-anchoring scrollTop far below zero.
        const historyStartedAt = Date.now();
        let lastHistoryActivityAt = historyStartedAt;
        const HISTORY_QUIET_TIMEOUT_MS = 45 * 1000;
        while (!historyRootReached) {
          checkCancelled();
          dispatchChatGptHistoryInput(scroller, viewportHeight());
          historyLoadRounds++;

          const pollStartedAt = Date.now();
          while (Date.now() - pollStartedAt < 1400) {
            await sleep(150);
            checkCancelled();
            collect();
            historyRootReached = chatGptMessageIsMounted(oldestExpectedMessageId);
            const height = Number(scroller.scrollHeight || 0);
            if (height > historyMaxHeight + 80) {
              historyMaxHeight = height;
              historyGrowthEvents++;
              lastHistoryActivityAt = Date.now();
            }
            if (historyRootReached) break;
          }

          if (
            !historyRootReached &&
            Date.now() - lastHistoryActivityAt >= HISTORY_QUIET_TIMEOUT_MS
          ) {
            updateProgress("Rendered attachment recovery stopped making progress. The verified text chain is unaffected; unavailable files will be identified in the export.");
            break;
          }

          if (Date.now() - lastProgressAt > 1000) {
            lastProgressAt = Date.now();
            updateProgress(
              `Loading older ChatGPT media: ${historyLoadRounds} input round(s), ` +
              `${Math.round(historyMaxHeight)}px history, ` +
              `${collect()} signed URL(s) retained...`
            );
          }
        }

        scroller.scrollTop = 0;
        dispatchChatGptScroll(scroller);
        await sleep(350);
        collect();
        await recoverMountedChatGptTextFileCards(messages);

        // Move by less than half a viewport so even short, image-only turns
        // mount in at least one sampled window. Text and ordering still come
        // exclusively from the authoritative ChatGPT graph.
        let stuckRounds = 0;
        let previousTop = -1;
        while (true) {
          checkCancelled();
          const top = scroller.scrollTop || 0;
          const end = maxTop();
          collect();
          if (top >= end - 4) break;

          const distance = Math.max(220, Math.floor(viewportHeight() * 0.42));
          scroller.scrollTop = Math.min(end, top + distance);
          dispatchChatGptScroll(scroller);
          await sleep(220);
          collect();
          await recoverMountedChatGptTextFileCards(messages);

          const nextTop = scroller.scrollTop || 0;
          if (Math.abs(nextTop - previousTop) < 2) {
            stuckRounds++;
            if (stuckRounds > 10) break;
          } else {
            stuckRounds = 0;
          }
          previousTop = nextTop;

          if (Date.now() - lastProgressAt > 1000) {
            lastProgressAt = Date.now();
            const percent = end > 0 ? Math.min(100, Math.round(nextTop / end * 100)) : 100;
            updateProgress(
              `Rendered-media scan ${percent}%: retained ${collect()} signed URL(s)...`
            );
          }
        }

        // Give the final virtualized window time to replace thumbnails with
        // their signed full sources before the last collection.
        await sleep(350);
        collect();
      } finally {
        const restoreTop = originalWasNearBottom ? maxTop() : Math.min(originalTop, maxTop());
        scroller.scrollTop = restoreTop;
        dispatchChatGptScroll(scroller);
      }

      const recovered = applyRenderedChatGptAttachmentUrls(messages);
      const remaining = unresolvedChatGptAttachmentCount(messages);
      return {
        unresolvedBefore,
        recovered,
        remaining,
        discovered: renderedChatGptUrlsByFileId.size - discoveredAtStart +
          renderedChatGptUrlsByAttachmentKey.size - contextualAtStart,
        exactMatches: renderedChatGptUrlsByFileId.size - discoveredAtStart,
        contextualMatches: renderedChatGptUrlsByAttachmentKey.size - contextualAtStart,
        historyInitialHeight,
        historyFinalHeight: Math.max(historyMaxHeight, Number(scroller.scrollHeight || 0)),
        historyLoadRounds,
        historyGrowthEvents,
        historyRootReached,
        fileCardsRecovered: chatGptFileCardsRecovered,
        fileCardsFailed: chatGptFileCardsFailed,
      };
    }

    function chatGptAttachmentMarkdown(message) {
      if (!options.includeMedia) return '';
      const attachments = Array.isArray(message && message.attachments)
        ? message.attachments
        : [];
      const parts = [];

      attachments.forEach((attachment, index) => {
        const name = chatGptAttachmentName(message, attachment, index);
        const label = String(name).replace(/\[|\]/g, '');
        const logicalKey = attachment.fileId
          ? 'chatgpt-file:' + attachment.fileId
          : attachment.url
            ? 'chatgpt-url:' + attachment.url
            : 'chatgpt-unresolved:' + message.id + ':' + index;

        if (!attachment.url) {
          if (!mediaResolutionFailures.some(failure => failure.logicalKey === logicalKey)) {
            mediaResolutionFailures.push({
              logicalKey,
              url: '',
              filename: sanitizeMediaBasename(name) || 'chatgpt-attachment.bin',
              error: [
                attachment.error,
                attachment.viewerError && ('rendered file card: ' + attachment.viewerError),
              ].filter(Boolean).join('; ') ||
                'ChatGPT returned no downloadable URL for this attachment',
            });
          }
          parts.push('*Attachment unavailable: ' + label + '*');
          return;
        }

        const filename = enqueueMedia(attachment.url, attachment.kind || 'attachment', name, {
          preferredFilename: name,
          mimeType: attachment.mimeType || '',
          logicalKey,
        });
        if (!filename) return;

        if (attachment.kind === 'image') {
          parts.push('![' + label + '](media/' + filename + ')');
        } else if (attachment.kind === 'video') {
          parts.push('[🎬 ' + label + '](media/' + filename + ')');
        } else if (attachment.kind === 'audio') {
          parts.push('[🔊 ' + label + '](media/' + filename + ')');
        } else {
          parts.push('[📎 ' + label + '](media/' + filename + ')');
        }
      });

      return parts.join('\n\n');
    }

    function textUploadMimeType(filename) {
      const lower = String(filename || '').toLowerCase();
      if (/\.md$|\.markdown$/.test(lower)) return 'text/markdown';
      if (/\.json$|\.jsonl$/.test(lower)) return 'application/json';
      if (/\.csv$/.test(lower)) return 'text/csv';
      if (/\.html?$/.test(lower)) return 'text/html';
      if (/\.css$/.test(lower)) return 'text/css';
      if (/\.xml$/.test(lower)) return 'application/xml';
      return 'text/plain';
    }

    function isTextUpload(filename) {
      return /\.(?:md|markdown|txt|text|csv|tsv|json|jsonl|html?|css|xml|ya?ml|toml|sql|py|ipynb|js|mjs|cjs|jsx|ts|tsx|sh|zsh|bash|java|c|cc|cpp|h|hpp|go|rs|rb|php|swift|kt|scala|r|lua|pl|ini|conf|log)$/i.test(
        String(filename || '')
      );
    }

    async function resolveInteractiveMedia() {
      if (!options.includeMedia || !interactiveMediaQueue.length) return;
      updateProgress(
        `Resolving ${interactiveMediaQueue.length} uploaded file(s) through the page's file viewer...`
      );

      for (let index = 0; index < interactiveMediaQueue.length; index++) {
        checkCancelled();
        const item = interactiveMediaQueue[index];
        const name = item.info.filename || item.info.label || ('attachment-' + (index + 1));
        const logicalKey = 'interactive-file:' + location.pathname + ':' + name + ':' + index;
        updateProgress(
          `Reading uploaded file ${index + 1}/${interactiveMediaQueue.length}: ${name}...`
        );

        let openedViewer = null;
        try {
          if (!item.element || !item.element.isConnected) {
            throw new Error('the file card was no longer mounted');
          }
          const viewerSelector = interactiveViewerSelector();
          const preexistingViewers = new Set(document.querySelectorAll(viewerSelector));
          item.element.click();

          const started = Date.now();
          let viewerTextNode = null;
          let viewerText = null;
          let lastViewerText = null;
          let stableTextRounds = 0;
          let directUrl = '';
          while (Date.now() - started < 10000) {
            await sleep(150);
            checkCancelled();
            const candidates = Array.from(document.querySelectorAll(viewerSelector));
            const candidateName = candidate => (
              candidate.querySelector('.drive-viewer-toolstrip-name')?.textContent ||
              candidate.querySelector('[aria-label^="Displaying "]')?.getAttribute('aria-label') ||
              candidate.querySelector(
                '[data-testid*="filename"], [data-test-id*="filename"], ' +
                '[class*="file-name"], [class*="filename"]'
              )?.textContent || ''
            ).trim();
            const candidatePool = candidates.filter(candidate =>
              !preexistingViewers.has(candidate) ||
              candidate.matches('.drive-viewer-shown, [aria-label="Showing viewer."]') ||
              candidateName(candidate).toLowerCase().includes(name.toLowerCase())
            );
            openedViewer = candidatePool.find(candidate => {
              const displayedName = candidateName(candidate);
              return !displayedName || displayedName.toLowerCase().includes(name.toLowerCase());
            }) || null;
            if (!openedViewer) continue;

            viewerText = null;
            viewerTextNode = openedViewer.querySelector(
              '.drive-viewer-text-page, .drive-viewer-text-content pre, pre[data-file-content], ' +
              '[data-testid*="file-preview"] pre, [data-testid*="attachment-preview"] pre'
            );
            if (viewerTextNode) {
              viewerText = viewerTextNode.textContent || '';
            } else {
              const editorLines = openedViewer.querySelectorAll(
                '.cm-content .cm-line, .monaco-editor .view-line'
              );
              if (editorLines.length) {
                viewerText = Array.from(editorLines, line => line.textContent || '').join('\n');
              } else if (openedViewer.matches('.content-sheet.popup')) {
                const body = Array.from(openedViewer.children).find(
                  child => child.tagName === 'DIV'
                );
                const bodyText = body && (body.textContent || '');
                if (
                  bodyText &&
                  !/(?:loading|please wait)/i.test(bodyText) &&
                  !/(?:failed|error|unable|cannot|not found|unavailable|forbidden)/i.test(bodyText)
                ) {
                  viewerText = bodyText;
                }
              }
            }
            const directElement = openedViewer.querySelector(
              'a[download][href], a[href*="/download"], [data-download-url], [data-file-url]'
            );
            directUrl = directElement && (
              directElement.getAttribute('href') || directElement.getAttribute('data-download-url') ||
              directElement.getAttribute('data-file-url') || ''
            );
            if (directUrl) break;
            if (viewerText !== null) {
              if (viewerText === lastViewerText) stableTextRounds++;
              else stableTextRounds = 0;
              lastViewerText = viewerText;
              if (stableTextRounds >= 2 && (viewerText.length || Date.now() - started > 1500)) {
                break;
              }
            }
          }

          let filename = null;
          if (viewerText !== null && isTextUpload(name)) {
            const mimeType = textUploadMimeType(name);
            const blob = new Blob([viewerText], { type: mimeType });
            const objectUrl = URL.createObjectURL(blob);
            filename = enqueueMedia(objectUrl, 'attachment', name, {
              preferredFilename: name,
              mimeType,
              logicalKey,
              forceLocal: true,
            });
          } else if (directUrl) {
            filename = enqueueMedia(directUrl, 'attachment', name, {
              preferredFilename: name,
              logicalKey,
            });
          } else {
            throw new Error(
              isTextUpload(name)
                ? 'the file viewer did not expose the original text'
                : 'the file card exposed neither original bytes nor a download URL'
            );
          }

          if (!filename) throw new Error('the uploaded file could not be queued');
          const label = String(item.info.label || name).replace(/\[|\]/g, '');
          item.replacement = '[📎 ' + label + '](media/' + filename + ')';
        } catch (error) {
          const failure = {
            logicalKey,
            url: '',
            filename: sanitizeMediaBasename(name) || ('attachment-' + (index + 1) + '.bin'),
            error: String(error && error.message || error),
          };
          mediaResolutionFailures.push(failure);
          item.replacement = '*Attachment unavailable: ' + item.info.label + '*';
        } finally {
          closeInteractiveViewer(openedViewer);
          if (openedViewer) await sleep(100);
        }
      }

      for (const message of ordered) {
        for (const item of interactiveMediaQueue) {
          if (message.text && message.text.includes(item.token)) {
            message.text = cleanText(message.text.split(item.token).join(item.replacement));
          }
        }
      }
    }

    // ----- Capture Pass -----
    const seen = new Set();
    const ordered = [];
    let captureOrder = 0;

    // Gemini's virtualizer recycles DOM nodes, so element-reference dedup
    // doesn't work. Use a text fingerprint (first 200 chars of role+text)
    // to avoid duplicates from recycled elements.
    const seenTexts = new Set();

    // claude.ai virtualizes long chats: only ~10 message wrappers are
    // mounted at a time (notably BOTH the first and last turns while you're
    // at the top), and wrappers unmount/remount as you scroll. Two
    // consequences for capture:
    //   - element-identity dedup fails (a remounted message is a new node),
    //     so dedup by text fingerprint;
    //   - capture sequence is NOT document order (the tail is mounted at
    //     the top of the sweep), so order by absolute pixel position in
    //     the scroll space instead.
    let claudeScrollerCache = null;
    function claudeScroller() {
      if (claudeScrollerCache && claudeScrollerCache.isConnected) return claudeScrollerCache;
      claudeScrollerCache = Array.from(document.querySelectorAll('.overflow-y-auto'))
        .filter(el => el.scrollHeight > el.clientHeight + 200)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
      return claudeScrollerCache;
    }

    function captureClaude() {
      const sc = claudeScroller();
      const base = sc ? sc.scrollTop : 0;
      const absTop = (el) => Math.round(el.getBoundingClientRect().top + base);

      document.querySelectorAll('[data-testid="user-message"]').forEach(el => {
        const fp = 'Y|' + (el.textContent || '').trim().slice(0, 200);
        if (seenTexts.has(fp)) return;
        const txt = cleanText(nodeToMarkdown(el));
        if (!txt) return;
        seenTexts.add(fp);
        ordered.push({ el: el, role: '## You', text: txt, ord: absTop(el) });
      });
      // claude.ai renamed .font-claude-message to .font-claude-response
      // (mid-2026). Query both so the extension works on either build. The
      // [data-test-render-count] wrappers now wrap USER messages too, so
      // they can't be used as a response selector anymore — a wrapper that
      // contains a user message is not a Claude turn.
      const main = document.querySelector('main') || document.body;
      let blocks = main.querySelectorAll('.font-claude-response, .font-claude-message');
      if (!blocks.length) {
        blocks = Array.from(main.querySelectorAll('[data-test-render-count]'))
          .filter(el => !el.querySelector('[data-testid="user-message"]'));
      }
      blocks.forEach(el => {
        if (el.closest('[data-testid="user-message"]')) return;
        const fp = 'C|' + (el.textContent || '').trim().slice(0, 200);
        if (seenTexts.has(fp)) return;
        const txt = cleanText(nodeToMarkdown(el));
        if (!txt) return;
        seenTexts.add(fp);
        ordered.push({ el: el, role: '## Claude', text: txt, ord: absTop(el) });
      });
    }

    function captureChatGPT() {
      // ChatGPT's virtualizer (verified live on temporary chats, 2026-07)
      // unmounts messages and remounts them later as brand-new element
      // objects. Two consequences:
      //   1. Dedup must key on data-message-id, not element identity,
      //      or a remounted message is captured twice.
      //   2. Capture-time ordering is unreliable. The graph fetched above is
      //      the authority for branch and order. Turn numbers are used only by
      //      the DOM fallback and are not treated as a conversation chain.
      document.querySelectorAll('[data-message-author-role]').forEach(el => {
        const key = el.getAttribute('data-message-id') || el;
        if (seen.has(key)) return;
        const roleAttr = el.getAttribute('data-message-author-role');
        const role = roleAttr === 'user' ? '## You' : '## ChatGPT';
        const txt = cleanText(nodeToMarkdown(el));
        // Only mark seen once we actually captured text, so a message
        // walked mid-remount (momentarily empty) can be retried on a
        // later pass instead of being lost.
        if (!txt) return;
        seen.add(key);
        let ord = null;
        const turnEl = el.closest('[data-testid^="conversation-turn-"]');
        if (turnEl) {
          const n = parseInt(turnEl.getAttribute('data-testid').slice('conversation-turn-'.length), 10);
          if (!isNaN(n)) ord = n;
        }
        ordered.push({
          el: el,
          id: typeof key === 'string' ? key : null,
          role: role,
          text: txt,
          ord: ord !== null ? ord : captureOrder++
        });
      });
    }

    function captureGemini() {
      // Runs exactly ONCE, after the background worker has loaded the full
      // history (Gemini keeps every loaded message mounted, in document
      // order). No dedup: in a single pass every element is distinct, and
      // fingerprint dedup would wrongly drop legitimately repeated messages
      // (e.g. the user answering "yes" twice).
      document.querySelectorAll('user-query, model-response').forEach(el => {
        const role = el.tagName.toLowerCase() === 'user-query' ? '## You' : '## Gemini';
        let txt = cleanText(nodeToMarkdown(el));
        if (role === '## Gemini') txt = cleanGeminiText(txt);
        if (!txt) return; // e.g. image-only message with media export off
        ordered.push({ el: el, role: role, text: txt, ord: captureOrder++ });
      });
    }

    function captureGrok() {
      // Runs once, after the history pass. Grok renders every message in
      // document order with no virtualization, so a single sweep in DOM
      // order is both complete and correctly ordered (verified live:
      // DOM order matched visual order exactly). No dedup, for the same
      // reason as Gemini: repeated messages are legitimate.
      document.querySelectorAll(GROK_MSG_SELECTOR).forEach(el => {
        const role = el.getAttribute('data-testid') === 'user-message' ? '## You' : '## Grok';
        const txt = cleanText(nodeToMarkdown(el));
        if (!txt) return;
        ordered.push({ el: el, role: role, text: txt, ord: captureOrder++ });
      });
    }

    function captureVisible() {
      if (isGrok) captureGrok();
      else if (isClaude) captureClaude();
      else if (isChatGPT) captureChatGPT();
      else captureGemini();
    }

    // Build `ordered` straight from the claude.ai API payload: every
    // message, in order, no scrolling. Media files are pushed onto the
    // local queue (fetched below in page context, where cookies apply).
    function buildOrderedFromClaudeApi() {
      const msgs = claudeApiData.chat_messages || [];
      msgs.forEach((m, i) => {
        const role = m.sender === "human" ? "## You" : "## Claude";
        const parts = [];

        const rawClaudeFiles = [
          ...(m.files_v2 || m.files || []),
          ...(m.attachments || []),
        ].filter(Boolean);
        const seenClaudeFiles = new Set();
        rawClaudeFiles.sort((left, right) => {
          const hasUrl = file => !!(
            file.download_url || file.file_url || file.preview_url || file.thumbnail_url || file.url ||
            file.document_asset && (file.document_asset.download_url || file.document_asset.url)
          );
          return Number(hasUrl(right)) - Number(hasUrl(left));
        }).forEach(f => {
          if (!f) return;
          const name = f.file_name || f.name || f.filename || '';
          const mimeType = f.mime_type || f.content_type || f.file_type || '';
          const kind = f.file_kind === "image" || String(mimeType).startsWith('image/')
            ? "image"
            : String(mimeType).startsWith('video/')
              ? "video"
              : String(mimeType).startsWith('audio/')
                ? "audio"
                : "attachment";
          const rawUrl = f.download_url || f.file_url || f.preview_url || f.thumbnail_url || f.url ||
            (f.document_asset && (f.document_asset.download_url || f.document_asset.url)) ||
            (f.image_asset && (f.image_asset.download_url || f.image_asset.url)) || "";
          const identity = String(f.file_uuid || f.uuid || f.id || name || rawUrl);
          if (seenClaudeFiles.has(identity)) return;
          seenClaudeFiles.add(identity);

          if (rawUrl && options.includeMedia) {
            const fn = enqueueMedia(rawUrl, kind, name, {
              preferredFilename: name,
              mimeType,
              logicalKey: 'claude-file:' + identity,
              // Claude's file endpoints require the page's authenticated
              // request context, so fetch them in this content script.
              forceLocal: true,
            });
            if (fn) {
              const label = (name || fn).replace(/\[|\]/g, '');
              parts.push(kind === "image"
                ? "![" + label + "](media/" + fn + ")"
                : "[📎 " + label + "](media/" + fn + ")");
            }
          } else if (name) {
            parts.push("*File: " + name + "*");
          }
        });

        (m.content || []).forEach(b => {
          if (!b) return;
          if (b.type === "text" && b.text && b.text.trim()) {
            parts.push(b.text.trim());
          } else if (b.type === "thinking" && options.includeThinking && (b.thinking || "").trim()) {
            parts.push("*Thinking:*\n\n> " + b.thinking.trim().replace(/\n/g, "\n> "));
          } else if (b.type === "tool_use" && options.includeTools) {
            parts.push("**Tool use: " + (b.name || "tool") + "**\n\n```json\n" + JSON.stringify(b.input || {}, null, 2) + "\n```");
          } else if (b.type === "tool_result" && options.includeTools) {
            let c = b.content;
            if (Array.isArray(c)) c = c.map(x => (x && x.text) || "").join("\n");
            if (typeof c !== "string") c = JSON.stringify(c ?? "", null, 2);
            if (c && c.trim()) parts.push("**Tool result:**\n\n```\n" + c.trim() + "\n```");
          }
        });

        const text = cleanText(parts.join("\n\n"));
        if (text) ordered.push({ el: null, role: role, text: text, ord: i });
      });
    }

    if (isClaude && claudeApiData) {
      updateProgress("Building export from API data...");
      buildOrderedFromClaudeApi();
    } else if (isGrok) {
      // Like Gemini: nothing is virtualized, so one sweep in DOM order
      // captures the whole conversation with no scroll-down pass.
      updateProgress("Scraping conversation structure...");
      captureGrok();
      updateProgress(`Captured ${ordered.length} messages.`);
    } else if (isChatGPT && chatGptApiMessages) {
      if (options.includeMedia) {
        try {
          chatGptMediaSweepResult = await sweepRenderedChatGptAttachmentUrls(chatGptApiMessages);
          const sweepResult = chatGptMediaSweepResult;
          if (sweepResult.unresolvedBefore) {
            updateProgress(
              `Media-only ChatGPT sweep finished: ${sweepResult.discovered} signed URL(s) retained, ` +
              `${sweepResult.recovered} denied attachment(s) recovered ` +
              `(${sweepResult.exactMatches} exact id, ${sweepResult.contextualMatches} same-message), ` +
              `${sweepResult.fileCardsRecovered || 0} file-card upload(s) recovered, ` +
              `${sweepResult.remaining} still unavailable. ` +
              `Oldest message ${sweepResult.historyRootReached ? 'reached' : 'not reached'} ` +
              `after ${sweepResult.historyLoadRounds || 0} loader round(s).`
            );
          }
        } catch (error) {
          if (exportCancelled) throw new Error("Export cancelled.");
          updateProgress(
            `Rendered ChatGPT media sweep could not finish (${error.message || error}); continuing with API-resolved files.`
          );
        }
      }

      // Capture only the messages ChatGPT has mounted after restoring the
      // user's scroll position, so their rich Markdown can enrich the API
      // result. Missing nodes are filled from the graph in exact branch order.
      updateProgress("Enriching the ChatGPT chain from currently rendered messages...");
      captureChatGPT();
      updateProgress(`Enriched ${ordered.length} currently rendered messages.`);
    } else if (isChatGPT) {
      // The endpoint was unavailable, so scan the actual ChatGPT scroll root in
      // half-viewport increments. The former near-full-viewport jumps could
      // pass over short virtualized turns before they mounted.
      updateProgress("Scanning ChatGPT messages carefully...");
      const sc = scrollEl || document.scrollingElement || document.documentElement;
      sc.scrollTop = 0;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(500);
      captureChatGPT();

      let stuckRounds = 0;
      let previousTop = -1;
      let lastProgressAt = 0;
      while (true) {
        checkCancelled();
        await ensureVisible();

        const maxTop = Math.max(0, sc.scrollHeight - sc.clientHeight);
        if (sc.scrollTop >= maxTop - 4) break;

        const step = Math.max(240, Math.floor(sc.clientHeight * 0.5));
        sc.scrollTop = Math.min(maxTop, sc.scrollTop + step);
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(180);
        captureChatGPT();

        if (sc.scrollTop === previousTop) {
          stuckRounds++;
          if (stuckRounds > 8) break;
        } else {
          stuckRounds = 0;
        }
        previousTop = sc.scrollTop;

        if (Date.now() - lastProgressAt > 1000) {
          lastProgressAt = Date.now();
          updateProgress(`Validated page scan: ${ordered.length} messages captured...`);
        }
      }

      sc.scrollTop = sc.scrollHeight;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(400);
      captureChatGPT();
    } else if (isGemini) {
      // Gemini keeps every loaded message mounted in the DOM (no
      // virtualization / recycling). After the scroll-up phase loaded
      // all history, every message is already rendered. One querySelectorAll
      // captures the entire conversation -- no scroll-down pass needed,
      // and critically no scrollBy()/scrollTopTo() calls that force
      // synchronous layout on the 6+ scrollable elements Angular creates
      // (which is what was stalling exports on long chats).
      updateProgress("Scraping conversation structure...");
      captureGemini();
      updateProgress(`Captured ${ordered.length} messages.`);
    } else {

    // ChatGPT or Claude DOM fallback: scroll down through the page,
    // capturing messages as the virtualizer renders each window.
    updateProgress("Scraping conversation structure...");
    scrollTopTo(0);
    getScrollableElements().forEach(el => {
      try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch(e) {}
    });
    await sleep(300);
    captureVisible();

    let scrapeNoProgressCount = 0;
    let lastTop = -1;
    const captureDelay = isClaude ? 60 : 250;
    const captureStep = isClaude ? Math.floor(clientH() * 1.5) : clientH() - 50;

    let lastProgressAt = 0;

    while (true) {
      checkCancelled();
      await ensureVisible();

      const currentH = getMaxScrollHeight();
      const currTop = currentTop();
      const viewH = clientH();

      if (currTop + viewH >= currentH - 100) {
        captureVisible();
        break;
      }

      scrollBy(captureStep);
      getScrollableElements().forEach(el => {
        try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch(e) {}
      });

      await sleep(captureDelay);
      captureVisible();

      if (Date.now() - lastProgressAt > 500) {
        lastProgressAt = Date.now();
        updateProgress(`Captured ${ordered.length} messages...`);
      }

      const top = currentTop();
      if (top === lastTop) {
        scrapeNoProgressCount++;
        await sleep(200);
        if (scrapeNoProgressCount > 12) break;
      } else {
        scrapeNoProgressCount = 0;
      }
      lastTop = top;
    }

    // Scroll to the absolute bottom and wait for the virtualizer to render
    // the last messages before the final capture.
    const maxScroll = getMaxScrollHeight();
    scrollTopTo(maxScroll);
    getScrollableElements().forEach(el => {
      try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch(e) {}
    });
    await sleep(400);
    captureVisible();

    } // end DOM scrape path

    if (isChatGPT && chatGptApiMessages) {
      if (options.includeMedia) {
        const renderedMediaRecovered =
          enrichChatGptAttachmentsFromRenderedDom(chatGptApiMessages);
        if (renderedMediaRecovered) {
          updateProgress(
            `Recovered ${renderedMediaRecovered} ChatGPT attachment URL(s) from signed media already rendered by the page.`
          );
        }
      }
      const domById = new Map();
      ordered.forEach(m => {
        if (m.id && !domById.has(m.id)) domById.set(m.id, m);
      });

      // Keep exactly the current_node -> root chain. Prefer the rendered DOM
      // text when captured because it preserves links, code and media; use API
      // text for any virtualized turn the sweep failed to mount.
      ordered.length = 0;
      chatGptApiMessages.forEach((message, index) => {
        const dom = domById.get(message.id);
        let text = dom ? dom.text : message.text;
        if (options.includeMedia) {
          const attachmentMarkdown = chatGptAttachmentMarkdown(message);
          text = withoutChatGptAttachmentPlaceholders(text);
          if (attachmentMarkdown) {
            text = cleanText((text ? text + '\n\n' : '') + attachmentMarkdown);
          }
        }
        ordered.push({
          el: dom ? dom.el : null,
          id: message.id,
          role: message.role,
          text,
          ord: index,
        });
      });
    }

    await resolveInteractiveMedia();

    if (!ordered.length) {
      throw new Error('No messages could be parsed in the DOM.');
    }

    ordered.sort((a, b) => a.ord - b.ord);

    if (isChatGPT && !chatGptApiMessages) {
      // Multiple rendered fragments belonging to the same ChatGPT turn should
      // be one Markdown section. Merge them before checking role alternation.
      const collapsed = globalThis.ChatGPTConversationGraph
        .collapseAndValidateDomMessages(ordered);
      ordered.length = 0;
      ordered.push(...collapsed);
      updateProgress(`Validated alternating ChatGPT chain: ${ordered.length} messages.`);
    }

    updateProgress(`Parsed ${ordered.length} messages. Found ${mediaQueue.length} media attachments.`);

    // ----- Fetch local media (Sequential & Base64 transfer) -----
    const failedFetches = mediaResolutionFailures.map(failure => ({
      url: failure.url,
      filename: failure.filename,
      error: failure.error,
    }));
    const savedMedia = []; // [{ filename, base64, type }]

    const localQueue = mediaQueue.filter(item => item.isLocal);
    const remoteQueue = mediaQueue.filter(item => !item.isLocal);

    if (localQueue.length > 0) {
      for (let i = 0; i < localQueue.length; i++) {
        checkCancelled();
        const item = localQueue[i];
        updateProgress(`Fetching local attachment ${i+1}/${localQueue.length}: ${item.filename}...`);
        try {
          let blob = null;

          if (item.url.startsWith('blob:')) {
            // blob: URLs (Gemini generated images, etc.) often can't be fetched — try canvas first.
            if (item.kind === 'image') {
              const imgEl = Array.from(document.querySelectorAll('img')).find(el => el.src === item.url);
              if (imgEl && imgEl.naturalWidth) {
                const cvs = document.createElement('canvas');
                cvs.width = imgEl.naturalWidth;
                cvs.height = imgEl.naturalHeight;
                cvs.getContext('2d').drawImage(imgEl, 0, 0);
                blob = await new Promise(resolve => cvs.toBlob(resolve, 'image/png'));
              }
            } else if (item.kind === 'video') {
              const vidEl = Array.from(document.querySelectorAll('video')).find(el => {
                const s = el.src || (el.querySelector('source') && el.querySelector('source').src) || '';
                return s === item.url;
              });
              if (vidEl && vidEl.videoWidth) {
                const cvs = document.createElement('canvas');
                cvs.width = vidEl.videoWidth;
                cvs.height = vidEl.videoHeight;
                cvs.getContext('2d').drawImage(vidEl, 0, 0);
                blob = await new Promise(resolve => cvs.toBlob(resolve, 'image/png'));
              }
            }
            // Fall back to fetch if canvas didn't work (e.g. data: URLs or other blob types)
            if (!blob || !blob.size) {
              const res = await fetch(item.url, {
                credentials: 'include',
                signal: abortController.signal,
              });
              if (!res.ok) throw new Error('HTTP ' + res.status);
              blob = await res.blob();
            }
          } else {
            const res = await fetch(item.url, {
              credentials: 'include',
              signal: abortController.signal,
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            blob = await res.blob();
          }

          const base64Data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            let settled = false;
            const cleanup = () => {
              abortController.signal.removeEventListener('abort', onAbort);
            };
            const finish = (fn, value) => {
              if (settled) return;
              settled = true;
              cleanup();
              fn(value);
            };
            const onAbort = () => {
              if (settled) return;
              settled = true;
              cleanup();
              try { reader.abort(); } catch (e) {}
              reject(new Error('Export cancelled.'));
            };
            reader.onloadend = () => {
              if (abortController.signal.aborted) onAbort();
              else finish(resolve, reader.result.split(',')[1]);
            };
            reader.onerror = () => finish(reject, reader.error || new Error('FileReader failed.'));
            reader.onabort = onAbort;
            abortController.signal.addEventListener('abort', onAbort, { once: true });
            if (abortController.signal.aborted) {
              onAbort();
              return;
            }
            reader.readAsDataURL(blob);
          });

          savedMedia.push({ filename: item.filename, base64: base64Data, type: blob.type });
        } catch (err) {
          console.warn('[Exporter] Local fetch failed for', item.filename, err);
          failedFetches.push({ url: item.url, filename: item.filename, error: String(err.message || err) });
        }
      }
    }

    checkCancelled();

    const title = (claudeApiData && claudeApiData.name) ||
      document.title.replace(/[-|].*(Claude|ChatGPT|Gemini|Grok).*/i, '').trim() ||
      (`${siteName} Conversation`);
    const date = new Date().toISOString();

    return {
      title,
      siteName,
      date,
      exporterVersion: chrome.runtime.getManifest().version,
      messageCount: ordered.length,
      history: isChatGPT && chatGptApiMessages ? { status: "complete", basis: "Authoritative ChatGPT root-to-current conversation chain" } : { status: "page_capture", basis: "Conversation messages loaded from the provider page" },
      messages: ordered.map(m => ({ role: m.role, text: m.text })),
      savedMedia,
      remoteQueue,
      failedFetches,
      mediaDiagnostics: {
        chatGptRenderedSweep: chatGptMediaSweepResult,
      },
    };
    } finally {
      document.removeEventListener('__exportCancel', onExportCancel);
    }
  }
})();
