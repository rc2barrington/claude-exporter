import { useMemo, useState } from "react";
import { renderMarkdown } from "../utils/markdownRender.js";

// Escapes special HTML characters to prevent rendering issues.
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Highlights search query occurrences within safe HTML blocks.
function highlightText(html, query) {
  if (!query) return html;
  const escaped = query.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => {
      if (part.startsWith("<")) return part;
      return part.replace(regex, '<mark class="preview-highlight">$1</mark>');
    })
    .join("");
}

// Renders a single parsed session as the macOS-style live preview window.
// Text content is run through marked + DOMPurify so fenced code, lists,
// and inline formatting look right instead of as plain strings.
export function SessionPreview({ session, includeThinking, includeTools, includeResults }) {
  const [searchQuery, setSearchQuery] = useState("");

  const items = useMemo(() => {
    return session.messages.map((msg) => {
      const isUser = msg.role === "## You";
      const blocks = isUser
        ? msg.blocks
        : msg.blocks.filter((b) => {
            if (b.type === "thinking") return includeThinking;
            if (b.type === "tool_use") return includeTools;
            if (b.type === "tool_result") return includeTools && includeResults;
            return true;
          });
      return { isUser, blocks, role: msg.role };
    }).filter((m) => m.blocks.length > 0);
  }, [session, includeThinking, includeTools, includeResults]);

  const matchCount = useMemo(() => {
    if (!searchQuery.trim()) return 0;
    let count = 0;
    const escaped = searchQuery.trim().replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    items.forEach((m) => {
      m.blocks.forEach((block) => {
        if (block.type === "text" && block.text) {
          const matches = block.text.match(regex);
          if (matches) count += matches.length;
        } else if (block.type === "thinking" && block.thinking) {
          const matches = block.thinking.match(regex);
          if (matches) count += matches.length;
        } else if (block.type === "tool_use") {
          const str = JSON.stringify(block.input);
          const matches = str.match(regex);
          if (matches) count += matches.length;
        } else if (block.type === "tool_result" && block.content) {
          const matches = String(block.content).match(regex);
          if (matches) count += matches.length;
        }
      });
    });
    return count;
  }, [items, searchQuery]);

  return (
    <div className="preview-window">
      <div className="preview-header">
        <div>
          <span className="preview-dot" style={{ backgroundColor: "#ef4444" }}></span>
          <span className="preview-dot" style={{ backgroundColor: "#f59e0b" }}></span>
          <span className="preview-dot" style={{ backgroundColor: "#10b981" }}></span>
        </div>
        <span className="preview-title">{session.title}.md</span>
        <span style={{ width: 42 }}></span>
      </div>

      <div className="preview-search-container">
        <input
          type="text"
          className="preview-search-input"
          placeholder="Search conversation..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery.trim() && (
          <span className="preview-search-stats">
            {matchCount} {matchCount === 1 ? "match" : "matches"}
          </span>
        )}
      </div>

      <div className="preview-body">
        <div style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: 16, marginBottom: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: "#ffffff", marginBottom: 8 }}># {session.title}</h2>
          <div style={{ color: "#64748b", fontStyle: "italic", fontSize: 12 }}>
            {session.date
              ? `> Exported from ${session.source || "AI chat"} on ${session.date}`
              : `> Exported from ${session.source || "AI chat"}`}
          </div>
        </div>

        {items.map((m, idx) => {
          const roleLabel = m.isUser ? "🧑 You" : roleEmojiFor(session.source) + " " + roleNameFor(session.source);
          return (
            <div key={idx} className={`preview-chat-bubble ${m.isUser ? "user" : "assistant"}`}>
              <div className="bubble-role">{roleLabel}</div>
              {m.blocks.map((block, bIdx) => {
                if (block.type === "text") {
                  const rawHtml = renderMarkdown(block.text);
                  const html = searchQuery.trim() ? highlightText(rawHtml, searchQuery.trim()) : rawHtml;
                  return (
                    <div
                      key={bIdx}
                      className="bubble-content markdown-body"
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  );
                }
                if (block.type === "thinking") {
                  const escThinking = escapeHtml(block.thinking);
                  const html = searchQuery.trim() ? highlightText(escThinking, searchQuery.trim()) : escThinking;
                  return (
                    <details key={bIdx} className="preview-thinking" open>
                      <summary>Thinking Process</summary>
                      <pre dangerouslySetInnerHTML={{ __html: html }} />
                    </details>
                  );
                }
                if (block.type === "tool_use") {
                  const rawInput = JSON.stringify(block.input, null, 2);
                  const escInput = escapeHtml(rawInput);
                  const html = searchQuery.trim() ? highlightText(escInput, searchQuery.trim()) : escInput;
                  return (
                    <div key={bIdx} className="preview-tool-use">
                      <div className="tool-name">🛠 Tool Executed: {block.name}</div>
                      <pre className="tool-payload" dangerouslySetInnerHTML={{ __html: html }} />
                    </div>
                  );
                }
                if (block.type === "tool_result") {
                  const rawResult = String(block.content || "");
                  const escResult = escapeHtml(rawResult);
                  const html = searchQuery.trim() ? highlightText(escResult, searchQuery.trim()) : escResult;
                  return (
                    <div key={bIdx} className="preview-tool-use" style={block.is_error ? { borderColor: "#ef4444" } : null}>
                      <div className="tool-name">{block.is_error ? "⚠ Tool Error" : "✓ Tool Result"}</div>
                      <pre className="tool-payload" dangerouslySetInnerHTML={{ __html: html }} />
                    </div>
                  );
                }
                return null;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function roleNameFor(source) {
  if (source === "Codex") return "Codex";
  return source || "Assistant";
}
function roleEmojiFor(source) {
  if (source === "Codex") return "🧩";
  return "🤖";
}
