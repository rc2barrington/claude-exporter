// Shared by the extension and the copyable console exporter.
globalThis.AIChatExporterBrowserAdapters = (() => {
  const label = text => String(text || "").replace(/[[\]\r\n]/g, " ").trim();
  function imageLabel(image, isGemini = false) {
    const alt = (image.getAttribute("alt") || "").trim();
    // Generic accessibility labels are not evidence of image provenance.
    if (isGemini && /^(?:an?\s+)?(?:ai[- ]generated(?:\s+image)?|generated\s+(?:image|by\s+gemini)|image\s+generated\s+by\s+(?:ai|gemini))[.!]?$/i.test(alt)) return "Image";
    return label(alt) || "Image";
  }
  function isGoogleSearch(href) {
    try { const u = new URL(href); return /^(www\.)?google\.com$/.test(u.hostname) && /^\/(search|aimode)\/?$/.test(u.pathname); }
    catch { return false; }
  }
  function extractGoogle(doc, href, { includeMedia = true } = {}) {
    if (!isGoogleSearch(href)) throw new Error("Not a supported Google Search page.");
    const url = new URL(href);
    const mode = url.searchParams.get("udm") === "50" || url.pathname.startsWith("/aimode") || !!doc.querySelector('[jsname="RH7zg"]');
    const remoteQueue = [], media = new Map();
    function link(value) {
      if (!value) return "";
      try {
        let result = new URL(value, href);
        if (/^(www\.)?google\.com$/.test(result.hostname) && result.pathname === "/url") result = new URL(result.searchParams.get("q") || result.searchParams.get("url"));
        return /^(https?:|data:|blob:)$/.test(result.protocol) ? result.href.replace(/[<>\r\n]/g, "") : "";
      } catch { return ""; }
    }
    function render(node) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return "";
      const tag = node.tagName.toLowerCase();
      // Google's image viewer is a button, but its picture is answer content.
      if (node.matches('[data-im][role="button"]')) return [...node.querySelectorAll("img")].map(render).join("\n");
      if (["script", "style", "svg", "button", "input", "textarea", "noscript"].includes(tag) ||
          node.matches('[hidden],[role="button"],[role="checkbox"],[role="dialog"],[aria-hidden="true"],[data-container-id="rhs-col"],[data-xid="Gd7Hsc"]') ||
          /(?:^|;)\s*display\s*:\s*none\b/i.test(node.getAttribute("style") || "")) return "";
      if (tag === "img") {
        const alt = imageLabel(node);
        const displayed = link(node.currentSrc || node.getAttribute("src") || node.getAttribute("data-src"));
        let descriptor;
        try { descriptor = JSON.parse(node.closest("[data-im]")?.getAttribute("data-im") || "null"); } catch { /* use rendered image */ }
        const src = link(descriptor?.[3]?.[0]) || displayed;
        const sourceUrl = link(descriptor?.[4]?.["2003"]?.[2]);
        if (!src || /favicon|logo|icon/i.test(alt) || (node.getAttribute("width") && Number(node.getAttribute("width")) <= 32)) return "";
        let target = src;
        if (includeMedia) {
          if (!media.has(src)) {
            const ext = src.match(/\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i)?.[1] || "png";
            const filename = `google-image-${media.size + 1}.${ext}`;
            media.set(src, filename);
            remoteQueue.push({ url: src, fallbackUrl: displayed !== src ? displayed : "", filename, kind: "image", alt });
          }
          target = `media/${media.get(src)}`;
        }
        return `\n\n![${alt}](${target})${sourceUrl ? `\n[Image source](<${sourceUrl}>)` : ""}\n\n`;
      }
      if (tag === "pre") {
        const body = node.textContent.trim();
        const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(m => m[0].length + 1)));
        return `\n\n${fence}\n${body}\n${fence}\n\n`;
      }
      if (tag === "table") {
        const rows = [...node.querySelectorAll("tr")].filter(row => row.closest("table") === node).map(row =>
          [...row.children].filter(c => /^(TD|TH)$/.test(c.tagName)).map(cell =>
            [...cell.childNodes].map(render).join("").trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>")));
        if (!rows.length) return "";
        const width = Math.max(...rows.map(row => row.length));
        const line = row => "| " + Array.from({ length: width }, (_, i) => row[i] || "").join(" | ") + " |";
        return "\n\n" + [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n") + "\n\n";
      }
      const text = [...node.childNodes].map(render).join("");
      if (tag === "a") {
        const target = link(node.getAttribute("href"));
        return target ? `[${text.trim() || label(node.getAttribute("aria-label")) || "Source"}](<${target}>)` : text;
      }
      if (tag === "br") return "\n";
      if (tag === "li") return `\n- ${text.trim()}\n`;
      if (tag === "strong" || tag === "b") return text.trim() ? `**${text.trim()}**` : "";
      if (tag === "code") return `\`${text}\``;
      if (tag === "p") return "\n\n" + text + "\n\n";
      if (tag === "th" || tag === "td") return text.replace(/\|/g, "\\|").trim() + " | ";
      if (tag === "tr") return "\n| " + text;
      if (/^h[1-6]$/.test(tag) || node.getAttribute("role") === "heading") return `\n\n### ${text.trim()}\n\n`;
      if (["div", "section", "ul", "ol"].includes(tag)) return "\n" + text + "\n";
      return text;
    }
    const clean = node => render(node).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const messages = [];
    const siteName = mode ? "Google AI Mode" : "Google AI Overview";
    if (mode) {
      // Each live RH7zg block owns a query and main answer column. The RHS
      // contains repeated source snippets, not additional assistant turns.
      const turns = [...doc.querySelectorAll('[jsname="RH7zg"]')];
      if (!turns.length) throw new Error("AI Mode conversation has not loaded, or its layout is unsupported.");
      for (const turn of turns) {
        const query = turn.querySelector('[jsname="eFVkfb"]');
        const answer = turn.querySelector('[data-container-id="main-col"], [jsname="KFl8ub"]');
        if (!query || !answer || answer.querySelector('[data-complete="false"]') || !clean(answer)) throw new Error("An AI Mode turn is incomplete. Wait for the response to finish and retry.");
        messages.push({ role: "## You", text: query.textContent.trim() }, { role: `## ${siteName}`, text: clean(answer) });
      }
    } else {
      const answer = doc.querySelector('#m-x-content [data-container-id="main-col"], #m-x-content [jsname="KFl8ub"]');
      if (!answer) throw new Error("No AI Overview found. Ordinary search results are not an AI conversation.");
      const text = clean(answer);
      if (!text) throw new Error("The AI Overview has not loaded yet.");
      messages.push({ role: "## You", text: url.searchParams.get("q") || "Google Search" }, { role: `## ${siteName}`, text });
    }
    return { title: messages[0].text, siteName, date: new Date().toISOString(), messageCount: messages.length,
      messages, savedMedia: [], remoteQueue, failedFetches: [] };
  }
  async function exportGoogle(doc, href, options = {}) {
    const signal = options.signal;
    const cancelled = () => Object.assign(new Error("Export cancelled."), { name: "AbortError" });
    const wait = () => new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(cancelled()); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 250);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    const scroll = doc.scrollingElement || doc.documentElement;
    const original = scroll.scrollTop;
    const observedQueries = new Set();
    let last = "", stable = 0;
    try {
      // No tab activation, window movement, or clipboard dependency.
      for (let i = 0; i < 32; i++) {
        if (signal?.aborted) throw cancelled();
        if (doc.location?.href && doc.location.href !== href) throw new Error("The Google page changed during export. Export the intended conversation again.");
        scroll.scrollTop = i < 12 ? 0 : scroll.scrollHeight;
        await wait();
        const data = extractGoogle(doc, href, options);
        for (const query of doc.querySelectorAll('[jsname="RH7zg"] [jsname="eFVkfb"]')) observedQueries.add(query);
        const signature = JSON.stringify(data.messages);
        stable = signature === last ? stable + 1 : 0;
        last = signature;
        if (i >= 15 && stable >= 4) {
          if ([...observedQueries].some(query => !doc.contains(query))) throw new Error("Google unloaded earlier turns during the scan. No partial history was exported.");
          return data;
        }
      }
      throw new Error("Google's response is still changing. Wait until it finishes before exporting.");
    } finally { scroll.scrollTop = original; }
  }
  return { imageLabel, isGoogleSearch, extractGoogle, exportGoogle };
})();
