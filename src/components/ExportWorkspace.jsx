import { useEffect, useRef, useState } from "react";
import { parseCodexJsonl } from "../parsers/codexJsonl.js";
import { parseOpenCode } from "../parsers/opencode.js";
import { generateMarkdown } from "../generators/markdown.js";
import { downloadBlob, sanitizeFilename } from "../utils/download.js";
import { bundleZip } from "../utils/zip.js";
import { renderMarkdown as markdownToHtml } from "../utils/markdownRender.js";
import { getAllFilesFromDrop } from "../utils/files.js";
import { BatchReview } from "./BatchReview.jsx";
import { sessionFiles } from "../utils/sessionExport.js";

export function ExportWorkspace({ source }) {
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(location.hostname === "127.0.0.1" ? "Finding chats…" : "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(null);
  const [review, setReview] = useState(null);
  const [options, setOptions] = useState({ includeThinking: true, includeTools: true, includeResults: true, frontmatter: false, truncateChars: 0 });
  const picker = useRef(null);
  const folder = useRef(null);
  const controller = useRef(null);
  const local = location.hostname === "127.0.0.1";
  const name = source === "codex" ? "Codex" : "OpenCode";
  async function request(id, signal) {
    const response = await fetch(`/api/local-sessions?${new URLSearchParams({ source, ...(id ? { id } : {}) })}`, { headers: { "X-AI-Exporter": "local-sessions" }, signal });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Open the downloaded local app to find chats on this computer.");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not read local chats.");
    return data;
  }
  useEffect(() => {
    if (!local) return;
    const abort = new AbortController();
    controller.current = abort;
    request(null, abort.signal).then(setSessions).catch(e => { if (e.name !== "AbortError") setError(e.message); }).finally(() => setBusy(""));
    return () => abort.abort();
    // App remounts this workspace when the source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, local]);
  useEffect(() => () => controller.current?.abort(), []);
  async function work(label, action) {
    if (busy) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(label); setError(""); setNotice("");
    try { await action(abort.signal); }
    catch (e) { if (e.name === "AbortError") setNotice("Cancelled. No further files will be downloaded."); else setError(e.message); }
    finally { setBusy(""); }
  }
  async function importFiles(files) {
    await work("Reading files…", async signal => {
      const parsed = [], failures = [];
      for (const file of files) {
        signal.throwIfAborted();
        if (!file.name.toLowerCase().endsWith(source === "codex" ? ".jsonl" : ".json")) continue;
        try {
          const text = await file.text();
          const session = source === "codex" ? parseCodexJsonl(text, { fileName: file.name }) : parseOpenCode(text);
          if (!session.messages.length) throw new Error("No messages found");
          parsed.push({ id: crypto.randomUUID(), title: session.title, updatedAt: session.endedAt || session.startedAt, parsed: session });
        } catch (e) { failures.push(`${file.name}: ${e.message}`); }
      }
      signal.throwIfAborted();
      setSessions(parsed); setSelected(new Set()); setPreview(null);
      if (failures.length) setError(failures.join("\n"));
      if (!parsed.length && !failures.length) throw new Error(`Choose ${name} ${source === "codex" ? ".jsonl rollout" : ".json export"} files.`);
    });
  }
  const visible = sessions.filter(s => s.title.toLowerCase().includes(search.trim().toLowerCase()));
  const picks = sessions.filter(s => selected.has(s.id));
  async function exportSessions(snapshot) {
    setReview(null);
    await work(`Exporting ${snapshot.length} chat${snapshot.length === 1 ? "" : "s"}…`, async signal => {
      const files = [];
      const failures = [];
      let duplicates = 0;
      for (const [position, item] of snapshot.entries()) {
        const session = item.parsed || await request(item.id, signal);
        signal.throwIfAborted();
        const result = await sessionFiles(session, options, async (attachment, index, signal) => {
          let url = attachment.url;
          const headers = {};
          if (url.startsWith("file:")) {
            if (!local || item.parsed) throw new Error("Use automatic discovery in the local app to read this file");
            url = `/api/local-sessions?${new URLSearchParams({ source, id: item.id, attachment: index })}`;
            headers["X-AI-Exporter"] = "local-sessions";
          } else if (!/^(data:|https?:)/.test(url)) throw new Error("Unsupported attachment location");
          const response = await fetch(url, { headers, signal, credentials: "omit" });
          if (!response.ok) throw new Error(`File could not be read (HTTP ${response.status})`);
          return response.blob();
        }, signal);
        failures.push(...result.failures); duplicates += result.duplicates;
        const title = sanitizeFilename(session.title, "conversation");
        for (const file of result.files) files.push({ ...file, filename: snapshot.length > 1 ? `${position + 1}-${title}/${file.filename}` : result.files.length === 1 ? title + ".md" : file.filename });
      }
      signal.throwIfAborted();
      if (files.length === 1) downloadBlob(files[0].filename, files[0].content);
      else {
        const zip = await bundleZip(files); signal.throwIfAborted();
        downloadBlob("ai-chat-export.zip", zip, "application/zip");
      }
      setNotice(`${snapshot.length} chat${snapshot.length === 1 ? "" : "s"} exported. ${duplicates} exact duplicate image${duplicates === 1 ? "" : "s"} reused.${failures.length ? ` ${failures.length} attachments could not be saved: ${failures.join("; ")}` : ""}`);
    });
  }
  return <>
    {!local && <section className="panel local-intro">
      <div className="section-icon">↙</div>
      <div><h2>Get your {name} chats from this computer</h2><p>Download the local app, unzip it, and open <strong>Open AI Chat Exporter.command</strong>. Choose {name} and your saved chats appear automatically.</p>
        <div className="actions"><a className="button" href={`${import.meta.env.BASE_URL}downloads/ai-chat-exporter-local.zip`} download>Download local app for Mac</a><a className="text-link" href={`http://127.0.0.1:4178/ai-chat-exporter/?source=${source}`}>Open installed local app ↗</a></div>
        <p className="fine-print">Requires Node.js 22.13 or newer. <a href="https://nodejs.org/en/download">Get Node.js</a>. Everything runs on your computer.</p>
      </div>
    </section>}
    <section className="panel">
      <div className="section-header"><div><span className="eyebrow">2 · Select chats</span><h2>{local ? `Your ${name} chats` : "Or import saved files"}</h2></div>
        <div className="actions compact">{local && <button className="button secondary" disabled={!!busy} onClick={() => work("Finding chats…", async signal => { setSessions(await request(null, signal)); setSelected(new Set()); })}>Refresh chats</button>}<button className="button secondary" disabled={!!busy} onClick={() => picker.current.click()}>Import files</button></div>
      </div>
      <input ref={picker} type="file" multiple accept={source === "codex" ? ".jsonl" : ".json"} hidden onChange={e => { importFiles([...e.target.files]); e.target.value = ""; }} />
      <input ref={folder} type="file" webkitdirectory="true" hidden onChange={e => { importFiles([...e.target.files]); e.target.value = ""; }} />
      {!sessions.length ? <div className="import-zone" onDragOver={e => e.preventDefault()} onDrop={async e => { e.preventDefault(); if (!busy) importFiles(await getAllFilesFromDrop(e.dataTransfer.items)); }}>
        <span className="upload-mark">↑</span><h3>{local ? "No chats loaded yet" : "Drop your chat files here"}</h3>
        <p>{source === "codex" ? "Codex .jsonl rollout files" : "OpenCode .json exports"}</p>
        <button className="text-link" disabled={!!busy} onClick={() => folder.current.click()}>Choose a folder instead</button>
        <details className="import-help"><summary>Where are these files?</summary><p>{source === "codex" ? "Codex saves rollouts in ~/.codex/sessions. In the Mac file picker, press Cmd+Shift+G and paste that path." : "In OpenCode, use its export command: opencode export SESSION_ID > conversation.json. The local app above reads saved sessions directly, without this step."}</p></details>
      </div> : <>
        <div className="list-toolbar"><input aria-label="Search chats" type="search" placeholder="Search your chats…" value={search} onChange={e => setSearch(e.target.value)} /><span>{selected.size} selected · {sessions.length} total</span></div>
        <label className="select-visible"><input type="checkbox" disabled={!!busy} checked={visible.length > 0 && visible.every(s => selected.has(s.id))} onChange={e => setSelected(old => { const next = new Set(old); for (const s of visible) if (e.target.checked) next.add(s.id); else next.delete(s.id); return next; })} />Select visible chats</label>
        <div className="chat-list">{visible.map(s => <div className={`chat-row ${selected.has(s.id) ? "selected" : ""}`} key={s.id}>
          <input type="checkbox" aria-label={`Select ${s.title}`} checked={selected.has(s.id)} disabled={!!busy} onChange={() => setSelected(old => { const next = new Set(old); if (next.has(s.id)) next.delete(s.id); else next.add(s.id); return next; })} />
          <div className="chat-description"><strong>{s.title}</strong><span>{s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "Imported conversation"}{s.parsed ? ` · ${s.parsed.messages.length} messages` : ""}</span></div>
          <button className="text-link" disabled={!!busy} onClick={() => work("Opening preview…", async signal => setPreview(s.parsed || await request(s.id, signal)))}>Preview</button>
        </div>)}{!visible.length && <p className="empty-search">No chats match that search.</p>}</div>
      </>}
    </section>
    <details className="panel advanced"><summary>Export options <span>Full text included by default</span></summary><div className="option-grid">
      {[['includeThinking', 'Include saved reasoning'], ['includeTools', 'Include tool calls'], ['includeResults', 'Include tool results'], ['frontmatter', 'Add a metadata header']].map(([key, label]) => <label key={key}><input type="checkbox" checked={options[key]} disabled={!!busy} onChange={e => setOptions({ ...options, [key]: e.target.checked })} />{label}</label>)}
    </div><p className="fine-print">Message text and tool output are never shortened by the exporter.</p></details>
    {(error || notice || busy) && <div className={`status-message ${error ? "error" : ""}`} role="status">{error || busy || notice}{busy && <button className="text-link" onClick={() => controller.current?.abort()}>Cancel</button>}</div>}
    <div className="export-bar"><div><span className="eyebrow">3 · Export</span><strong>{picks.length ? `${picks.length} chat${picks.length === 1 ? "" : "s"} selected` : "Choose chats to export"}</strong><small>Markdown opens in any text editor and can be uploaded to an AI.</small></div><button className="button" disabled={!picks.length || !!busy} onClick={() => picks.length > 1 ? setReview([...picks]) : exportSessions([...picks])}>{picks.length > 1 ? "Review batch export →" : "Export Markdown ↓"}</button></div>
    {preview && <section className="panel"><div className="section-header"><h2>{preview.title}</h2><button className="text-link" onClick={() => setPreview(null)}>Close preview</button></div><div className="markdown-body preview-content" dangerouslySetInnerHTML={{ __html: markdownToHtml(generateMarkdown(preview, options)) }} /></section>}
    {review && <BatchReview sessions={review} onClose={() => setReview(null)} onConfirm={() => exportSessions(review)} />}
  </>;
}
