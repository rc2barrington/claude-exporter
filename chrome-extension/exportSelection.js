// Shared selection helpers for the popup and background worker. Keeping this
// logic outside the DOM gives both extension contexts the same fail-closed
// definition of which tab ids are authorized for one export batch.
(function (root) {
  function tabId(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const number = typeof value === "number" ? value : Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function uniqueTabIds(values) {
    const ids = [];
    const seen = new Set();
    for (const value of values || []) {
      const id = tabId(value);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  function targetsForSelection(detectedTabs, selectedIds) {
    const byId = new Map();
    for (const tab of detectedTabs || []) {
      const id = tabId(tab && tab.id);
      if (id !== null && !byId.has(id)) byId.set(id, tab);
    }

    return uniqueTabIds(selectedIds).flatMap(id => {
      const tab = byId.get(id);
      if (!tab) return [];
      return [{
        id,
        url: tab.url || tab.pendingUrl || "",
        title: tab.title || `Tab ${id}`,
      }];
    });
  }

  function requestedTargets(request) {
    const hasIds = Array.isArray(request && request.tabs);
    const hasDetails = Array.isArray(request && request.tabDetails);
    const requestedIds = uniqueTabIds(hasIds ? request.tabs : []);
    const requestedIdSet = new Set(requestedIds);
    const details = [];
    const seenDetails = new Set();

    if (hasDetails) {
      for (const detail of request.tabDetails) {
        const id = tabId(detail && detail.id);
        if (id === null || seenDetails.has(id)) continue;
        // Current popups send both arrays. Their intersection is the maximum
        // authorized set, so a stale detail can never add an unchecked tab.
        if (hasIds && !requestedIdSet.has(id)) continue;
        seenDetails.add(id);
        details.push({
          id,
          url: detail.url || "",
          title: detail.title || `Tab ${id}`,
        });
      }
      return details;
    }

    return requestedIds.map(id => ({ id, url: "", title: `Tab ${id}` }));
  }

  function createSelectionState(initialIds) {
    let selected = new Set(uniqueTabIds(initialIds));
    return {
      has(id) {
        const normalized = tabId(id);
        return normalized !== null && selected.has(normalized);
      },
      ids() {
        return Array.from(selected);
      },
      replace(ids) {
        selected = new Set(uniqueTabIds(ids));
        return this.ids();
      },
      set(id, checked) {
        const normalized = tabId(id);
        if (normalized === null) return this.ids();
        if (checked) selected.add(normalized);
        else selected.delete(normalized);
        return this.ids();
      },
    };
  }

  root.AIChatExporterSelection = {
    hasBatchConfirmation(request, targets) {
      if (targets.length < 2) return true;
      const confirmation = request && request.confirmation;
      return confirmation?.steps === 2 && JSON.stringify(uniqueTabIds(confirmation.targetIds)) === JSON.stringify(targets.map(t => t.id));
    },
    createSelectionState,
    requestedTargets,
    targetsForSelection,
    uniqueTabIds,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
