import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { buildConsoleCode } from "../src/parsers/browserScript.js";

const source = readFileSync(new URL("../chrome-extension/browserAdapters.js", import.meta.url), "utf8");
const context = { URL, setTimeout, clearTimeout };
vm.runInNewContext(source, context);
const adapters = context.AIChatExporterBrowserAdapters;
const documentFor = html => parseHTML(`<html><body>${html}</body></html>`).document;
const turn = (question, answer) => `<div jsname="RH7zg"><span jsname="eFVkfb">${question}</span><div data-container-id="main-col">${answer}</div><div data-container-id="rhs-col">Duplicated snippet</div></div>`;

describe("Google Search adapters", () => {
  it("exports AI Overviews, not the ordinary search results around them", () => {
    const doc = documentFor('<h1>Search</h1><div id="m-x-content"><div jsname="KFl8ub"><p>Blue light scatters.</p><a href="https://science.nasa.gov/">NASA</a><button>Copy</button><script>SECRET STATE</script></div></div><div>Ordinary result</div>');
    const result = adapters.extractGoogle(doc, "https://www.google.com/search?q=sky");
    expect(result.siteName).toBe("Google AI Overview");
    expect(result.messages.map(m => m.role)).toEqual(["## You", "## Google AI Overview"]);
    expect(result.messages[1].text).toContain("[NASA](<https://science.nasa.gov/>)");
    expect(result.messages[1].text).not.toMatch(/Copy|SECRET|Ordinary/);
    expect(result.remoteQueue).toEqual([]);
  });
  it("preserves the first question, follow-ups, repeated text, and citations in order", () => {
    const doc = documentFor(turn("First question", '<p>Same answer</p><a href="https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fsource">Source</a>') + turn("Follow-up", "Same answer"));
    const result = adapters.extractGoogle(doc, "https://www.google.com/search?udm=50&q=Follow-up");
    expect(result.messages.map(m => m.text)).toEqual(["First question", "Same answer\n\n[Source](<https://example.com/source>)", "Follow-up", "Same answer"]);
  });
  it("does not pass ordinary results or incomplete AI Mode turns off as complete exports", () => {
    expect(() => adapters.extractGoogle(documentFor("Just search results"), "https://www.google.com/search?q=test")).toThrow(/No AI Overview/);
    expect(() => adapters.extractGoogle(documentFor('<div jsname="RH7zg"><span jsname="eFVkfb">Question</span></div>'), "https://www.google.com/search?udm=50")).toThrow(/incomplete/);
    expect(adapters.isGoogleSearch("https://evil.test/?url=google.com/search")).toBe(false);
  });
  it("excludes live Google's feedback block and hidden legal boilerplate", () => {
    const doc = documentFor(turn("Question", '<p>Actual answer</p><div data-xid="Gd7Hsc">Send feedback<div>Privacy policy</div></div><div style="display: none">Legal request</div>'));
    expect(adapters.extractGoogle(doc, "https://www.google.com/search?udm=50").messages[1].text).toBe("Actual answer");
  });
  it("preserves Markdown tables and code containing backtick fences", () => {
    const doc = documentFor(turn("Formatting", '<table><tr><th>Item</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table><pre>```example```</pre>'));
    const text = adapters.extractGoogle(doc, "https://www.google.com/search?udm=50").messages[1].text;
    expect(text).toContain("| Item | Value |\n| --- | --- |\n| A | 1 |");
    expect(text).toContain("````\n```example```\n````");
  });
  it("deduplicates image files without deleting repeated image references", () => {
    const doc = documentFor(turn("Images", '<img src="https://example.com/photo.jpg" alt="Photo"><img src="https://example.com/photo.jpg" alt="Photo">'));
    const result = adapters.extractGoogle(doc, "https://www.google.com/search?udm=50");
    expect(result.remoteQueue).toHaveLength(1);
    expect(result.messages[1].text.match(/media\/google-image-1.jpg/g)).toHaveLength(2);
    const withoutMedia = adapters.extractGoogle(doc, "https://www.google.com/search?udm=50", { includeMedia: false });
    expect(withoutMedia.remoteQueue).toEqual([]);
    expect(withoutMedia.messages[1].text).toContain("https://example.com/photo.jpg");
  });
  it("captures overview viewer images with original source attribution and a rendered fallback", () => {
    const doc = documentFor('<div id="m-x-content"><div jsname="KFl8ub"><div role="button" data-im=""><img alt="Museum photo" src="https://www.gstatic.com/thumb.jpg"></div></div></div>');
    doc.querySelector("[data-im]").setAttribute("data-im", JSON.stringify([0, "id", [], ["https://museum.test/original.jpg"], { "2003": [null, null, "https://museum.test/article"] }]));
    const result = adapters.extractGoogle(doc, "https://www.google.com/search?q=museum");
    expect(result.remoteQueue[0]).toMatchObject({ url: "https://museum.test/original.jpg", fallbackUrl: "https://www.gstatic.com/thumb.jpg" });
    expect(result.messages[1].text).toContain("[Image source](<https://museum.test/article>)");
  });
  it("cancels a background scan promptly and restores the scroll position", async () => {
    vi.useFakeTimers();
    try {
      const doc = documentFor(turn("Question", "Answer"));
      doc.documentElement.scrollTop = 142;
      const controller = new AbortController();
      const pending = adapters.exportGoogle(doc, "https://www.google.com/search?udm=50", { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(doc.documentElement.scrollTop).toBe(142);
    } finally { vi.useRealTimers(); }
  });
});

describe("image provenance and console parity", () => {
  it.each(["AI-generated image", "Generated image", "Image generated by Gemini", "Generated by Gemini"])("does not treat Gemini's generic alt label %s as provenance", alt => {
    const doc = documentFor(`<a href="https://museum.test/photo"><img alt="${alt}" src="https://museum.test/photo.jpg"></a>`);
    expect(adapters.imageLabel(doc.querySelector("img"), true)).toBe("Image");
    expect(doc.querySelector("a").getAttribute("href")).toBe("https://museum.test/photo");
  });
  it("preserves descriptive image labels", () => {
    expect(adapters.imageLabel(documentFor('<img alt="Saturn photographed by Cassini">').querySelector("img"), true)).toBe("Saturn photographed by Cassini");
  });
  it("embeds the shared adapter and produces syntactically valid console scripts", () => {
    for (const repliesOnlyText of [false, true]) {
      const script = buildConsoleCode({ repliesOnlyText });
      expect(() => new vm.Script(script)).not.toThrow();
      expect(script).toContain(source);
      expect(script).not.toContain("media-fetch-errors.tsv");
      expect(script).toContain("else if (JSZip && savedMedia.length > 0)");
    }
  });
});
