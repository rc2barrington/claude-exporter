// JS logic for AI Chat Exporter Chrome Extension Popup

document.addEventListener("DOMContentLoaded", () => {
  const tabList = document.getElementById("tab-list");
  const exportBtn = document.getElementById("export-btn");
  const cancelBtn = document.getElementById("cancel-btn");
  const selectAllContainer = document.getElementById("select-all-container");
  const selectAllCheckbox = document.getElementById("select-all-checkbox");
  const detectedCount = document.getElementById("detected-count");
  const statusPanel = document.getElementById("status-panel");
  const toggleThinking = document.getElementById("toggle-thinking");
  const toggleTools = document.getElementById("toggle-tools");
  const toggleMedia = document.getElementById("toggle-media");

  let detectedTabs = [];
  const selection = globalThis.AIChatExporterSelection.createSelectionState([]);
  let popupExporting = false;
  let cancelRequested = false;
  let activeBatchTargetIds = new Set();

  // Older versions remembered checked rows in extension storage. Delete that
  // legacy value so it cannot return if Chrome briefly runs an older popup or
  // restores extension state during an unpacked-extension reload.
  chrome.storage.local.remove("selectedTabIds", () => {
    void chrome.runtime.lastError;
  });

  function applyExportingUi() {
    exportBtn.style.display = popupExporting ? "none" : "block";
    cancelBtn.style.display = popupExporting ? "block" : "none";
    cancelBtn.disabled = cancelRequested;
    cancelBtn.textContent = cancelRequested ? "Stopping..." : "Cancel Export";
    document.querySelectorAll(
      ".tab-select, #select-all-checkbox, .switch input"
    ).forEach(element => {
      element.disabled = popupExporting;
    });
  }

  // Log status message to panel
  function logStatus(message, type = "default", time = null) {
    const line = document.createElement("div");
    line.className = `status-line ${type}`;
    const displayTime = time || new Date().toLocaleTimeString();
    line.textContent = `[${displayTime}] ${message}`;
    statusPanel.appendChild(line);
    statusPanel.scrollTop = statusPanel.scrollHeight;
  }

  // Listen for progress messages from background.js
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "progress") {
      logStatus(request.message, request.type || "info", request.time);
      
      // A per-tab error is not the end of a multi-tab batch. Only a terminal
      // batch message may re-enable the controls. The old `type === "error"`
      // check re-enabled the popup after the first failure and launched a noisy
      // 120-tab rescan while the remaining exports were still running.
      const isTerminal =
        request.message === "Batch export sequence completed." ||
        request.message.startsWith("Batch export was cancelled.") ||
        request.message.startsWith("Batch export failed:");
      if (
        isTerminal
      ) {
        popupExporting = false;
        cancelRequested = false;
        activeBatchTargetIds = new Set();
        applyExportingUi();
        updateExportButtonState();
      }
    }
  });

  // Scan open tabs
  async function scanTabs() {
    detectedCount.textContent = "Scanning...";
    tabList.innerHTML = "";

    try {
      const tabs = await chrome.tabs.query({});

      // Filter for ChatGPT, Claude, and Gemini tabs. A tab that is still
      // loading when the popup opens has an empty url; pendingUrl holds
      // its destination.
      const tabUrl = (tab) => (tab.url || tab.pendingUrl || "").toLowerCase();
      detectedTabs = tabs.filter(tab => {
        try {
          const url = new URL(tabUrl(tab));
          return /(^|\.)(chatgpt\.com|chat\.openai\.com|claude\.ai|claude\.com|gemini\.google\.com|grok\.com)$/.test(url.hostname) ||
            (/^(www\.)?google\.com$/.test(url.hostname) && /^\/(search|aimode)\/?$/.test(url.pathname));
        } catch { return false; }
      });

      const windowCount = new Set(tabs.map(t => t.windowId)).size;

      // Surface the tab the popup was opened on: sort it to the top of
      // the list and flag it, so it's findable among many similar rows.
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTabId = activeTab ? activeTab.id : null;
      if (activeTabId !== null) {
        detectedTabs.sort((a, b) => (b.id === activeTabId) - (a.id === activeTabId));
        if (activeTab && !detectedTabs.some(t => t.id === activeTabId)) {
          let h = "";
          try { h = new URL(activeTab.url || activeTab.pendingUrl || "about:blank").hostname; } catch (e) {}
          logStatus(`Note: the tab you're on (${h || "unknown"}) is not a supported chat tab.`, "error");
        }
      }

      if (detectedTabs.length === 0) {
        selectAllContainer.style.display = "none";
        detectedCount.textContent = "0 tabs detected";
        tabList.innerHTML = `
          <div class="no-tabs">
            <div class="no-tabs-icon">💬</div>
            <p>No active AI chat tabs found.</p>
            <p style="font-size: 11px; margin-top: 4px; color: #64748b;">
              Open ChatGPT, Claude.ai, Google Gemini, or Grok and check back.
            </p>
          </div>
        `;
        exportBtn.disabled = true;
        applyExportingUi();
        return;
      }

      selectAllContainer.style.display = "flex";
      detectedCount.textContent = `${detectedTabs.length} chat tab(s) across ${windowCount} Chrome window(s)`;

      // A fresh popup starts with the in-memory selection's initial empty set.
      // Never restore old checks across popup openings. During an active batch,
      // show only the worker's locked targets so reopening still reports the
      // exact immutable batch that is already running.
      const availableIds = new Set(detectedTabs.map(tab => tab.id));
      const visibleSelection = popupExporting
        ? Array.from(activeBatchTargetIds)
        : selection.ids();
      selection.replace(visibleSelection.filter(id => availableIds.has(id)));

      // Populate list
      detectedTabs.forEach((tab) => {
        const item = document.createElement("div");
        item.className = "tab-item";
        const isCurrent = tab.id === activeTabId;
        if (isCurrent) item.classList.add("current-tab");

        // Determine site and badge style
        let siteClass = "site-chatgpt";
        let siteLabel = "ChatGPT";
        const url = (tab.url || tab.pendingUrl || "").toLowerCase();
        if (url.includes("claude.ai") || url.includes("claude.com")) {
          siteClass = "site-claude";
          siteLabel = "Claude";
        } else if (url.includes("gemini.google.com")) {
          siteClass = "site-gemini";
          siteLabel = "Gemini";
        } else if (url.includes("grok.com")) {
          siteClass = "site-grok";
          siteLabel = "Grok";
        } else if (/^https:\/\/(www\.)?google\.com\//.test(url)) {
          siteClass = "site-gemini";
          siteLabel = new URL(url).searchParams.get("udm") === "50" || url.includes("/aimode") ? "AI Mode" : "AI Overview";
        }

        item.innerHTML = `
          <input type="checkbox" autocomplete="off" class="tab-checkbox tab-select" data-tab-id="${tab.id}"${selection.has(tab.id) ? " checked" : ""} />
          <span class="site-badge ${siteClass}">${siteLabel}</span>
          <span class="tab-title" title="${escapeHtml(tab.title || "")}">${escapeHtml(tab.title || "Untitled Chat")}</span>
          ${isCurrent ? '<span class="site-badge current-badge">THIS TAB</span>' : ''}
        `;
        tabList.appendChild(item);
      });

      // Wire checkbox handlers
      const itemCheckboxes = document.querySelectorAll(".tab-select");
      itemCheckboxes.forEach(cb => {
        cb.addEventListener("change", () => {
          const id = Number(cb.getAttribute("data-tab-id"));
          if (popupExporting) {
            cb.checked = activeBatchTargetIds.has(id);
            return;
          }
          selection.set(id, cb.checked);
          updateExportButtonState();
        });
      });

      // Reflect the current popup-session selection in the button and Select
      // All states. Closing the popup intentionally discards this selection.
      updateExportButtonState();
      applyExportingUi();

    } catch (err) {
      logStatus(`Error scanning tabs: ${err.message || err}`, "error");
    }
  }

  // Update export button state based on selections
  function updateExportButtonState() {
    const availableIds = new Set(detectedTabs.map(tab => tab.id));
    const selectedIds = selection.ids().filter(id => availableIds.has(id));
    const selectedCount = selectedIds.length;
    exportBtn.disabled = popupExporting || selectedCount === 0;

    document.querySelectorAll(".tab-select").forEach(cb => {
      const id = Number(cb.getAttribute("data-tab-id"));
      cb.checked = selection.has(id);
    });

    const allCount = document.querySelectorAll(".tab-select").length;
    // With nothing selected, Select All must read unchecked rather than
    // "all zero are selected".
    selectAllCheckbox.checked = allCount > 0 && selectedCount === allCount;

  }

  // Select all / Deselect all
  selectAllCheckbox.addEventListener("change", (e) => {
    if (popupExporting) {
      e.target.checked = selection.ids().length === detectedTabs.length;
      return;
    }
    const checked = e.target.checked;
    selection.replace(checked ? detectedTabs.map(tab => tab.id) : []);
    updateExportButtonState();
  });

  // Helper to escape HTML tags
  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Note: markdown + zip assembly happens in offscreen.js (see buildMarkdown there),
  // which runs in a DOM context that can use FileReader/Blob and JSZip.

  // Main export action
  exportBtn.addEventListener("click", async () => {
    if (popupExporting) return;
    const targets = globalThis.AIChatExporterSelection.targetsForSelection(
      detectedTabs,
      selection.ids()
    );
    const targetTabIds = targets.map(target => target.id);

    if (targetTabIds.length === 0) return;
    if (targetTabIds.length > 1 && !(await confirmBatch(targets))) return;

    // Each run gets a clean status panel so stale scan and export messages do
    // not obscure the exact result of this batch.
    statusPanel.innerHTML = "";

    // Lock the exact snapshot before messaging the worker. A reopened popup
    // receives the same ids from getStatus and cannot visually edit a batch
    // that has already started.
    popupExporting = true;
    cancelRequested = false;
    activeBatchTargetIds = new Set(targetTabIds);
    applyExportingUi();

    logStatus(
      `Locked selection and delegating exactly ${targetTabIds.length} chat(s) to the background worker...`,
      "info"
    );

    chrome.runtime.sendMessage({
      action: "startExport",
      // Keep the numeric list for a previous service worker that may still be
      // alive during an unpacked-extension reload. The current worker prefers
      // tabDetails so it retains inactive cross-window URLs.
      tabs: targetTabIds,
      tabDetails: targets,
      confirmation: { steps: 2, targetIds: targetTabIds },
      options: {
        includeThinking: toggleThinking.checked,
        includeTools: toggleTools.checked,
        includeMedia: toggleMedia.checked
      }
    }, (response) => {
      if (chrome.runtime.lastError || !response || response.status !== "started") {
        const reason = chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : response && response.error || "The background worker rejected the batch.";
        logStatus(`Error launching background worker: ${reason}`, "error");
        popupExporting = false;
        cancelRequested = false;
        activeBatchTargetIds = new Set();
        applyExportingUi();
        updateExportButtonState();
      } else {
        activeBatchTargetIds = new Set(response.targetTabIds || targetTabIds);
        logStatus(
          `Background export started with ${activeBatchTargetIds.size} locked chat(s). ` +
          "You can click away or close this popup safely.",
          "success"
        );
      }
    });
  });

  function confirmBatch(targets) {
    return new Promise(resolve => {
      const dialog = document.createElement("dialog");
      dialog.style.cssText = "width:calc(100% - 28px);max-height:90vh;padding:22px;border:1px solid #64748b;border-radius:12px;background:#111827;color:#f8fafc;font:14px system-ui;";
      let step = 1;
      const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
      function render() {
        dialog.innerHTML = `<p>Batch confirmation ${step} of 2</p><h3>${step === 1 ? "Review selected chats" : "Confirm this batch export"}</h3><p>${targets.length} chats will be exported:</p><ul style="max-height:210px;overflow:auto;padding-left:20px">${targets.map(t => `<li style="margin:9px 0">${escapeHtml(t.title)}</li>`).join("")}</ul><div style="display:flex;gap:8px;margin-top:20px"><button data-cancel style="padding:10px">Cancel</button><button data-confirm style="padding:10px">${step === 1 ? "These chats are correct" : "Export " + targets.length + " chats now"}</button></div>`;
        dialog.querySelector("[data-cancel]").onclick = () => finish(false);
        dialog.querySelector("[data-confirm]").onclick = () => { if (step === 1) { step = 2; render(); } else finish(true); };
      }
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
      render(); document.body.appendChild(dialog); dialog.showModal();
    });
  }

  // Cancel export action
  cancelBtn.addEventListener("click", () => {
    if (cancelRequested) return;
    cancelRequested = true;
    applyExportingUi();
    logStatus("Cancel requested. Stopping active requests, packaging, and downloads...", "info");
    
    chrome.runtime.sendMessage({ action: "cancelExport" }, (response) => {
      if (chrome.runtime.lastError) {
        logStatus(`Error sending cancel: ${chrome.runtime.lastError.message}`, "error");
        cancelRequested = false;
        applyExportingUi();
      } else if (response && response.status === "idle") {
        logStatus("The background worker reports that no export is still running.", "info");
        popupExporting = false;
        cancelRequested = false;
        activeBatchTargetIds = new Set();
        applyExportingUi();
        updateExportButtonState();
      } else {
        if (popupExporting) {
          logStatus("Background worker accepted the cancellation.", "info");
        }
      }
    });
  });

  // Query background worker for current status and restore logs/UI if exporting
  chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
    if (chrome.runtime.lastError) {
      // Background worker might not be active/initialized yet
      popupExporting = false;
      activeBatchTargetIds = new Set();
      selection.replace([]);
      scanTabs();
      return;
    }

    if (response && response.logs && response.logs.length > 0) {
      // Load cached logs regardless of whether it's currently exporting
      statusPanel.innerHTML = "";
      response.logs.forEach(log => {
        logStatus(log.message, log.type, log.time);
      });
    }

    popupExporting = !!(response && response.isExporting);
    cancelRequested = !!(response && response.isCancelling);
    activeBatchTargetIds = new Set(
      response && Array.isArray(response.activeTargetIds)
        ? response.activeTargetIds
        : []
    );
    if (!popupExporting) selection.replace([]);
    // Run initial scan to discover tabs
    scanTabs();
  });
});
