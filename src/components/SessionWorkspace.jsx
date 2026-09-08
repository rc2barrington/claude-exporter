import { useEffect, useState } from "react";
import { Dropzone } from "./Dropzone.jsx";
import { LocalSessionPicker } from "./LocalSessionPicker.jsx";
import { SessionList } from "./SessionList.jsx";
import { SessionPreview } from "./SessionPreview.jsx";
import { Switch } from "./Switch.jsx";
import { readFileAsText } from "../utils/files.js";
import { generateMarkdown } from "../generators/markdown.js";
import { generateHtml } from "../generators/html.js";
import { downloadBlob, sanitizeFilename, copyToClipboard } from "../utils/download.js";
import { StatsPanel } from "./StatsPanel.jsx";
import { bundleZip } from "../utils/zip.js";
import {
  isFsAccessSupported,
  getSavedDirectory,
  verifyPermission,
  pickDirectory,
  collectFiles,
  forgetDirectory,
} from "../utils/dirHandle.js";

// Shared workspace UI for Codex and OpenCode imports and local discovery.
// Pass:
//   accept            file extensions to accept
//   parseFile(file)   async (file: File) => parsedSession | null
//   showToolToggles   bool — sources that carry tool_use/tool_result blocks
//   sourceLabel       header text for the dropzone
//   noMatchHelp       optional node rendered when a scan yields zero sessions,
//                     for sources whose files browsers tend to miss (hidden dirs)
export function SessionWorkspace({ accept, parseFile, showToolToggles, sourceLabel, folderAccess, noMatchHelp, localSource }) {
  // Defaults favour a complete, ready-to-read transcript: everything the
  // session contained, untruncated, with no metadata header.
  const [includeThinking, setIncludeThinking] = useState(true);
  const [includeTools, setIncludeTools] = useState(true);
  const [includeResults, setIncludeResults] = useState(true);
  const [frontmatter, setFrontmatter] = useState(false);
  const [truncateChars, setTruncateChars] = useState(0);
  const [parsedSession, setParsedSession] = useState(null);
  const [availableSessions, setAvailableSessions] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [parseError, setParseError] = useState("");
  const [copied, setCopied] = useState(false);
  const [dirBusy, setDirBusy] = useState(false);
  const [dirError, setDirError] = useState("");
  const [dirRemembered, setDirRemembered] = useState(false);
  const [showNoMatchHelp, setShowNoMatchHelp] = useState(false);

  const fsSupported = isFsAccessSupported();
  const showFolderAccess = !!folderAccess && fsSupported;

  // On mount, note whether we've already remembered this folder so the button
  // can read "reload" instead of "open".
  useEffect(() => {
    if (!showFolderAccess) return;
    let cancelled = false;
    getSavedDirectory(folderAccess.id).then((h) => {
      if (!cancelled && h) setDirRemembered(true);
    });
    return () => {
      cancelled = true;
    };
  }, [showFolderAccess, folderAccess]);

  const opts = { includeThinking, includeTools, includeResults, truncateChars: Number(truncateChars) || 0, frontmatter };

  const processFiles = async (files) => {
    setParseError("");
    setShowNoMatchHelp(false);
    if (!files || files.length === 0) return;
    const exts = accept.split(",").map((s) => s.trim().toLowerCase());
    const valid = files.filter((f) => exts.some((ext) => f.name.toLowerCase().endsWith(ext)));
    if (valid.length === 0) {
      setParseError(`No valid ${accept} files found.`);
      setShowNoMatchHelp(true);
      return;
    }

    const results = [];
    for (const file of valid) {
      try {
        const text = await readFileAsText(file);
        // Pass the full file set (not just `valid`) so parsers can find
        // sidecar files of other extensions alongside each transcript.
        const parsed = await parseFile(file, text, files);
        if (parsed && parsed.messages && parsed.messages.length > 0) {
          results.push({ ...parsed, fileName: file.name });
        }
      } catch {
        // Skip unreadable file
      }
    }

    if (results.length === 0) {
      setParseError("No valid chat messages found.");
      setShowNoMatchHelp(true);
      return;
    }

    if (results.length === 1) {
      setParsedSession(results[0]);
      setAvailableSessions([]);
    } else {
      // Sort newest-first by default
      results.sort((a, b) => {
        const da = new Date(a.endedAt || a.startedAt || a.date || 0).getTime() || 0;
        const db = new Date(b.endedAt || b.startedAt || b.date || 0).getTime() || 0;
        return db - da;
      });
      setAvailableSessions(results);
      setSelected(new Set());
      setParsedSession(null);
    }
  };

  const downloadSingle = (session) => {
    const md = generateMarkdown(session, opts);
    downloadBlob(`${sanitizeFilename(session.title, "export")}.md`, md);
  };

  const downloadSingleHtml = (session) => {
    const html = generateHtml(session, opts);
    downloadBlob(`${sanitizeFilename(session.title, "export")}.html`, html, "text/html;charset=utf-8");
  };

  const handleCopy = async () => {
    if (!parsedSession) return;
    const md = generateMarkdown(parsedSession, opts);
    const ok = await copyToClipboard(md);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const handleBulkDownload = async () => {
    if (selected.size === 0) return;
    const picks = availableSessions.filter((_, i) => selected.has(i));
    if (picks.length === 1) {
      downloadSingle(picks[0]);
      return;
    }
    const files = picks.map((s) => ({
      filename: `${sanitizeFilename(s.title, "export")}.md`,
      content: generateMarkdown(s, opts),
    }));
    const blob = await bundleZip(files);
    downloadBlob(`ai-chat-export-${new Date().toISOString().slice(0, 10)}.zip`, blob, "application/zip");
  };

  const toggle = (idx) => {
    const next = new Set(selected);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelected(next);
  };
  const toggleAll = () => {
    if (selected.size === availableSessions.length) setSelected(new Set());
    else setSelected(new Set(availableSessions.map((_, i) => i)));
  };

  const reset = () => {
    setParsedSession(null);
    setAvailableSessions([]);
    setSelected(new Set());
    setParseError("");
    setShowNoMatchHelp(false);
  };

  // One-click open of a remembered folder (or pick it the first time).
  const openFolder = async () => {
    if (!folderAccess) return;
    setParseError("");
    setDirError("");
    setShowNoMatchHelp(false);
    setDirBusy(true);
    try {
      let handle = await getSavedDirectory(folderAccess.id);
      if (handle && !(await verifyPermission(handle, "read"))) {
        handle = null; // permission lost/denied — fall back to the picker
      }
      if (!handle) {
        const startIn = await getSavedDirectory(folderAccess.id);
        handle = await pickDirectory(folderAccess.id, startIn);
      }
      if (!handle) return;
      setDirRemembered(true);
      const files = await collectFiles(handle, folderAccess.include, folderAccess.enterDir);
      if (files.length === 0) {
        // The browser handed back a handle but the folder yielded nothing —
        // either the picked folder is genuinely empty/was moved, or Chrome
        // blocked the pick of a hidden folder and returned an unenumerable
        // handle. (Note the FSA walk itself does list dot-entries; it's the
        // drag-and-drop and <input webkitdirectory> paths that silently skip
        // hidden folders.) Reusing this handle on the next visit would just
        // fail again, so forget it and show the source's rescue help.
        await forgetDirectory(folderAccess.id);
        setDirRemembered(false);
        setShowNoMatchHelp(true);
        setDirError(
          folderAccess.emptyHint ||
            `No ${sourceLabel} files found in "${handle.name}". Pick the folder that contains your conversations.`
        );
        return;
      }
      await processFiles(files);
    } catch (err) {
      // User dismissing the picker throws AbortError — that's not an error.
      if (!err || err.name !== "AbortError") {
        setDirError((err && err.message) || "Could not open that folder.");
      }
    } finally {
      setDirBusy(false);
    }
  };

  return (
    <div>
      {localSource && <LocalSessionPicker source={localSource} onLoad={sessions => {
        setSelected(new Set());
        setParseError("");
        setParsedSession(sessions.length === 1 ? sessions[0] : null);
        setAvailableSessions(sessions.length === 1 ? [] : sessions);
      }} />}
      <div className="card-panel">
        <p className="card-title">Export Settings</p>
        <div className="config-group">
          {showToolToggles && (
            <Switch
              label="Include Thinking Logs"
              hint="Exports the assistant's internal reasoning inside a collapsible element"
              checked={includeThinking}
              onChange={setIncludeThinking}
            />
          )}
          {showToolToggles && (
            <Switch
              label="Include Tool Executions"
              hint="Exports terminal command runs, file edits, and tool calls"
              checked={includeTools}
              onChange={setIncludeTools}
            />
          )}
          {showToolToggles && (
            <Switch
              label="Include Tool Results"
              hint="Exports the output produced by tool executions (paired with above)"
              checked={includeResults}
              onChange={setIncludeResults}
              disabled={!includeTools}
            />
          )}
          <Switch
            label="YAML Frontmatter"
            hint="Prepend a YAML metadata block (works well in Obsidian, Hugo, Jekyll)"
            checked={frontmatter}
            onChange={setFrontmatter}
          />
          {showToolToggles && (
            <div className="config-item">
              <div className="config-info">
                <span className="config-label">Truncate long tool fields</span>
                <span className="config-subtext">Max characters per string in tool_use input / tool_result output. 0 disables truncation.</span>
              </div>
              <input
                type="number"
                min="0"
                step="500"
                value={truncateChars}
                onChange={(e) => setTruncateChars(e.target.value)}
                style={{
                  width: 100,
                  padding: "6px 10px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#e2e8f0",
                  borderRadius: 6,
                  fontSize: 13,
                }}
              />
            </div>
          )}
        </div>

        {!parsedSession && availableSessions.length === 0 && (
          <>
            {showFolderAccess && (
              <div style={{ textAlign: "center", marginBottom: 18 }}>
                <button
                  onClick={openFolder}
                  className="btn-primary"
                  disabled={dirBusy}
                  style={{ opacity: dirBusy ? 0.6 : 1, cursor: dirBusy ? "default" : "pointer" }}
                >
                  {dirBusy
                    ? "⏳ Opening…"
                    : dirRemembered
                      ? `🔄 ${folderAccess.reopenLabel || folderAccess.label}`
                      : `📂 ${folderAccess.label}`}
                </button>
                <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.6, marginTop: 10, maxWidth: 520, marginInline: "auto" }}>
                  {folderAccess.hint}
                </p>
                {dirError && (
                  <div style={{ color: "#ef4444", fontSize: 13, marginTop: 10, fontWeight: 500 }}>⚠️ {dirError}</div>
                )}
                {dirError && showNoMatchHelp && noMatchHelp}
                <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "20px auto 4px", maxWidth: 360, color: "#475569", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                  <span style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
                  or drag manually
                  <span style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.08)" }} />
                </div>
              </div>
            )}
            <Dropzone
              accept={accept}
              onFiles={processFiles}
              title={`Drag & drop your ${sourceLabel} file(s) here`}
              description={`Supports ${accept}. Drop a folder to scan everything inside.`}
            />
          </>
        )}

        {!parsedSession && availableSessions.length > 0 && (
          <SessionList
            sessions={availableSessions}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onSelect={setParsedSession}
            onBulkDownload={handleBulkDownload}
            onClear={reset}
          />
        )}

        {parseError && (
          <div style={{ color: "#ef4444", fontSize: 13, marginTop: 14, textAlign: "center", fontWeight: 500 }}>
            ⚠️ {parseError}
          </div>
        )}
        {parseError && showNoMatchHelp && noMatchHelp}
      </div>

      {parsedSession && (
        <div style={{ animation: "fadeIn 0.4s ease" }}>
          <div className="card-panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20 }}>
            <div>
              <h3 style={{ fontSize: 18, fontWeight: 700, color: "#f8fafc", margin: "0 0 4px" }}>{parsedSession.title}</h3>
              <div style={{ fontSize: 13, color: "#64748b" }}>
                <span>📄 {parsedSession.fileName}</span>
                <span style={{ margin: "0 8px" }}>•</span>
                <span>💬 {parsedSession.messages.length} messages</span>
                {parsedSession.date && (
                  <>
                    <span style={{ margin: "0 8px" }}>•</span>
                    <span>📅 {parsedSession.date}</span>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                onClick={availableSessions.length > 0 ? () => setParsedSession(null) : reset}
                className="btn-secondary"
                style={{
                  padding: "10px 16px",
                  background: "rgba(255,255,255,0.1)",
                  border: "none",
                  color: "#fff",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {availableSessions.length > 0 ? "← Back to List" : "Change File"}
              </button>
              <button onClick={handleCopy} className="btn-primary">
                {copied ? "✓ Copied" : "📋 Copy as Markdown"}
              </button>
              <button onClick={() => downloadSingle(parsedSession)} className="btn-primary btn-success">
                💾 Download Markdown
              </button>
              <button
                onClick={() => downloadSingleHtml(parsedSession)}
                className="btn-primary"
                style={{
                  background: "linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)",
                  boxShadow: "0 4px 20px rgba(59, 130, 246, 0.25)"
                }}
              >
                🌐 Download Standalone HTML
              </button>
            </div>
          </div>

          <StatsPanel session={parsedSession} />

          <div style={{ marginBottom: 40 }}>
            <p className="card-title">Live Preview</p>
            <SessionPreview
              session={parsedSession}
              includeThinking={includeThinking}
              includeTools={includeTools}
              includeResults={includeResults}
            />
          </div>
        </div>
      )}
    </div>
  );
}
