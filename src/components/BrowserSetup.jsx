import { useState } from "react";
import { buildConsoleCode } from "../parsers/browserScript.js";
import { copyToClipboard } from "../utils/download.js";

export function BrowserSetup() {
  const [copied, setCopied] = useState(false);
  return <>
    <section className="panel browser-intro"><span className="eyebrow">2 · Connect your browser</span><h2>Export directly from your open chats</h2><p>The Chrome extension finds your open conversations. Choose the chats you want, include attachments, and save them as readable Markdown.</p>
      <div className="provider-pills">{["ChatGPT", "Claude.ai", "Gemini", "Grok", "Google AI Mode", "AI Overviews"].map(p => <span key={p}>{p}</span>)}</div>
      <a className="button" href={`${import.meta.env.BASE_URL}downloads/ai-chat-exporter-extension.zip`} download>Download Chrome extension ↓</a>
      <span className="release-note">v0.2.0 · No account or subscription</span>
    </section>
    <section className="panel"><div className="section-header"><h2>A one-time setup</h2><span className="badge">About a minute</span></div><ol className="setup-steps">
      <li><span>1</span><div><h3>Download and unzip</h3><p>Keep the extension folder somewhere permanent, such as Documents.</p></div></li>
      <li><span>2</span><div><h3>Add it to Chrome</h3><p>Open <code>chrome://extensions</code>, turn on Developer mode, choose <strong>Load unpacked</strong>, and select the unzipped extension folder.</p></div></li>
      <li><span>3</span><div><h3>Choose chats, then export</h3><p>Click the extension icon. Everything starts unselected. Exports keep running while you use other tabs; batches require two confirmations.</p></div></li>
    </ol><p className="fine-print">Updating? Replace the contents of your existing extension folder and click Reload in Chrome.</p></section>
    <details className="panel advanced"><summary>Use a console script instead <span>Optional fallback</span></summary><p>Open a supported chat, open the browser developer console, then paste the script. Some sites block attachment downloads from console scripts.</p><button className="button secondary" onClick={async () => setCopied(await copyToClipboard(buildConsoleCode()))}>{copied ? "Copied" : "Copy export script"}</button></details>
    <div className="output-note"><span>↓</span><p><strong>One conversation, one export.</strong> Text-only chats save as .md. Chats with downloaded attachments save as a ZIP. Exact duplicate images share one file, while every message stays in place.</p></div>
  </>;
}
