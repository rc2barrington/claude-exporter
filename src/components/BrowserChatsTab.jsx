import { useState } from "react";
import { buildConsoleCode } from "../parsers/browserScript.js";
import { copyToClipboard } from "../utils/download.js";
import { Switch } from "./Switch.jsx";

const stepsFor = (repliesOnlyText) => [
  {
    num: "01",
    title: "Open a chat conversation",
    detail: "Open a ChatGPT, Gemini, Claude.ai, Grok, Google AI Mode conversation, or a Google Search page with an AI Overview.",
    icon: "💬",
  },
  {
    num: "02",
    title: "Open the console",
    detail: "Press F12 (or Cmd+Option+J on Mac) to open DevTools, then click the Console tab.",
    icon: "🛠",
  },
  {
    num: "03",
    title: "Paste & run the script",
    detail: `Click "Copy Console Script" above, paste into the console with Cmd+V, and press Enter. The ${
      repliesOnlyText ? ".txt file" : ".md file (or .zip when media is saved)"
    } downloads when the export finishes.`,
    icon: "📥",
  },
];

export function BrowserChatsTab() {
  const [copied, setCopied] = useState(false);
  const [repliesOnlyText, setRepliesOnlyText] = useState(false);

  const script = buildConsoleCode({ repliesOnlyText });
  const steps = stepsFor(repliesOnlyText);

  const handleCopy = async () => {
    const ok = await copyToClipboard(script);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div>
      <div className="card-panel" style={{ border: "1px solid rgba(124, 58, 237, 0.3)", background: "linear-gradient(135deg, rgba(124, 58, 237, 0.05) 0%, rgba(79, 70, 229, 0.05) 100%)", marginBottom: 24 }}>
        <p className="card-title" style={{ color: "#a78bfa", marginBottom: 12 }}>⚡ Chrome Extension (Recommended)</p>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: "#cbd5e1" }}>
          <p style={{ marginBottom: 12, fontWeight: 500 }}>
            Export ChatGPT, Claude.ai, Gemini, Grok, Google AI Overviews and Google AI Mode without pasting code into the developer console.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, textAlign: "left", background: "rgba(0, 0, 0, 0.2)", padding: 16, borderRadius: 10, border: "1px solid rgba(255, 255, 255, 0.02)", marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 8 }}><span style={{ color: "#a78bfa", fontWeight: 700 }}>1.</span> <span>Open Google Chrome and navigate to <code>chrome://extensions/</code></span></div>
            <div style={{ display: "flex", gap: 8 }}><span style={{ color: "#a78bfa", fontWeight: 700 }}>2.</span> <span>Enable <strong>Developer mode</strong> in the upper right.</span></div>
            <div style={{ display: "flex", gap: 8 }}><span style={{ color: "#a78bfa", fontWeight: 700 }}>3.</span> <span>Click <strong>Load unpacked</strong> and select the <code>chrome-extension/</code> folder in this project directory.</span></div>
          </div>
        </div>
      </div>

      <div className="card-panel" style={{ textAlign: "center" }}>
        <p className="card-title">Or: Copy the Browser Export Script</p>
        <button onClick={handleCopy} className="btn-primary" style={{ marginBottom: 12 }}>
          {copied ? "✓ Copied to Clipboard!" : "📋 Copy Console Script"}
        </button>
        <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.6, marginTop: 12 }}>
          {repliesOnlyText
            ? "Pasting this script in your browser console scrolls, dedupes, and saves a .txt containing only the assistant's replies with markdown formatting stripped. Your own messages and any images are left out."
            : "Pasting this script in your browser console scrolls, dedupes (by element identity, not text prefix), preserves fenced code blocks, and downloads your conversation with a YAML frontmatter header."}
        </p>
      </div>

      <div className="card-panel">
        <p className="card-title">Export Settings</p>
        <div className="config-group">
          <Switch
            label="Replies only, plain text (.txt)"
            hint="Saves a .txt of just the assistant's replies with markdown formatting removed. Your own messages, images, and the YAML header are left out."
            checked={repliesOnlyText}
            onChange={setRepliesOnlyText}
          />
        </div>
      </div>

      <div style={{ marginBottom: 32 }}>
        <p className="card-title">How to Use</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {steps.map((step, i) => (
            <div key={i} className="step-item">
              <span className="step-icon">{step.icon}</span>
              <div>
                <div className="step-title">
                  <span className="step-number">{step.num}</span>
                  {step.title}
                </div>
                <div className="step-detail">{step.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card-panel">
        <p className="card-title">Console Shortcuts</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "#cbd5e1", fontSize: 14 }}>macOS (Chrome/Firefox/Safari)</span>
            <div style={{ display: "flex", gap: 6 }}>
              {["⌘ Cmd", "⌥ Option", "J"].map((k, idx) => (
                <span key={idx}>
                  <kbd>{k}</kbd>
                  {idx < 2 && <span style={{ color: "#475569", margin: "0 2px" }}>+</span>}
                </span>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ color: "#cbd5e1", fontSize: 14 }}>Windows / Linux</span>
            <kbd>F12</kbd>
          </div>
        </div>
      </div>

      <details className="card-panel" style={{ cursor: "pointer" }}>
        <summary className="card-title" style={{ userSelect: "none" }}>View full script source</summary>
        <pre
          style={{
            background: "#050508",
            border: "1px solid rgba(255,255,255,0.05)",
            borderRadius: 8,
            padding: 16,
            marginTop: 16,
            fontSize: 11,
            lineHeight: 1.6,
            color: "#64748b",
            overflow: "auto",
            maxHeight: 300,
            whiteSpace: "pre-wrap",
            fontFamily: "JetBrains Mono, monospace",
          }}
        >
          {script}
        </pre>
      </details>
    </div>
  );
}
