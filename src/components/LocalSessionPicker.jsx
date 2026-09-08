import { useState } from "react";

export function LocalSessionPicker({ source, onLoad }) {
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isLocal = location.hostname === "127.0.0.1";
  async function request(id) {
    const query = new URLSearchParams({ source, ...(id ? { id } : {}) });
    const response = await fetch(`/api/local-sessions?${query}`, { headers: { "X-AI-Exporter": "local-sessions" } });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Start the local app with npm run local first.");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Local session request failed.");
    return data;
  }
  async function run(action) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="card-panel">
    <p className="card-title">Open local {source === "codex" ? "Codex" : "OpenCode"} chats</p>
    <p>No folder picker. The local app discovers session storage automatically; nothing is selected by default.</p>
    {!isLocal ? <p>For automatic discovery, run <code>npm run local</code> in the exporter project, then open the local address it prints. File import below also works on the hosted website.</p> : <>
      <button className="btn-primary" disabled={busy} onClick={() => run(async () => { setSessions(await request()); setSelected(new Set()); })}>{busy ? "Working…" : "Find my chats"}</button>
      {sessions.length > 0 && <>
        <p>{sessions.length} sessions found. {selected.size} selected.</p>
        <input aria-label="Filter local sessions" placeholder="Search titles" value={filter} onChange={e => setFilter(e.target.value)} />
        <div style={{ maxHeight: 300, overflow: "auto", margin: "12px 0" }}>
          {sessions.filter(s => s.title.toLowerCase().includes(filter.toLowerCase())).map(s => <label key={s.id} style={{ display: "block", padding: 6 }}>
            <input type="checkbox" checked={selected.has(s.id)} disabled={busy} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(s.id)) next.delete(s.id); else next.add(s.id); return next; })} /> {s.title}
          </label>)}
        </div>
        <button className="btn-primary" disabled={busy || !selected.size} onClick={() => run(async () => {
          const loaded = [];
          for (const id of selected) loaded.push(await request(id));
          onLoad(loaded);
        })}>Load {selected.size} selected chats</button>
      </>}
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
