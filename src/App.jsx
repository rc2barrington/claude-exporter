import { useState } from "react";
import "./App.css";
import { BrowserSetup } from "./components/BrowserSetup.jsx";
import { ExportWorkspace } from "./components/ExportWorkspace.jsx";

const sources = [
  { id: "browser", icon: "◎", name: "Browser chats", detail: "ChatGPT, Gemini, Claude & more" },
  { id: "codex", icon: "›_", name: "Codex", detail: "Desktop and CLI conversations" },
  { id: "opencode", icon: "⌘", name: "OpenCode", detail: "Local coding sessions" },
];
export default function App() {
  const initial = new URLSearchParams(location.search).get("source");
  const [source, setSource] = useState(sources.some(s => s.id === initial) ? initial : "browser");
  const active = sources.find(s => s.id === source);
  return <div className="app-shell">
    <header className="site-header"><a className="brand" href="./"><span className="brand-icon">↓</span>AI Chat Exporter<span className="version">0.2.0</span></a><a className="github-link" href="https://github.com/rc2barrington/ai-chat-exporter">View on GitHub ↗</a></header>
    <div className="app-layout">
      <aside className="source-sidebar"><span className="eyebrow">1 · Choose a source</span><nav aria-label="Conversation source">{sources.map(s => <button key={s.id} className={source === s.id ? "source active" : "source"} aria-pressed={source === s.id} onClick={() => setSource(s.id)}><span className="source-icon">{s.icon}</span><span><strong>{s.name}</strong><small>{s.detail}</small></span>{source === s.id && <span className="active-dot" />}</button>)}</nav>
        <div className="privacy-card"><span className="privacy-dot" /><strong>Private by design</strong><p>Your conversations stay on your computer. No sign-up, uploads to our servers, or usage tracking.</p></div>
        <a className="sidebar-help" href="https://github.com/rc2barrington/ai-chat-exporter/issues">Report a problem ↗</a>
      </aside>
      <main><div className="page-heading"><span className="eyebrow">{active.name}</span><h1>Keep the whole conversation.</h1><p>Save readable chats and attachments. Ready for your files, notes, or your next AI conversation.</p></div>
        {source === "browser" ? <BrowserSetup /> : <ExportWorkspace key={source} source={source} />}
        <footer>AI Chat Exporter <span>·</span> Made to keep your conversations yours.</footer>
      </main>
    </div>
  </div>;
}
