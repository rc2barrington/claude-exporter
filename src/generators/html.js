import { renderMarkdown } from "../utils/markdownRender.js";

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function truncateJson(value, limit) {
  if (!limit) return JSON.stringify(value, null, 2);
  const walk = (v) => {
    if (typeof v === "string") {
      if (v.length > limit) return v.slice(0, limit) + `\n…[truncated, ${v.length - limit} more chars]`;
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value), null, 2);
}

function truncateText(text, limit) {
  if (!limit || text.length <= limit) return text;
  return text.slice(0, limit) + `\n…[truncated, ${text.length - limit} more chars]`;
}

export function generateHtml(session, opts = {}) {
  const {
    includeThinking = true,
    includeTools = false,
    includeResults = false,
    truncateChars = 2000,
  } = opts;

  let bodyContent = "";

  for (const msg of session.messages) {
    const isUser = msg.role === "## You";
    const roleLabel = isUser
      ? "🧑 You"
      : (session.source === "Codex" ? "🧩 Codex" : "🤖 Claude");
    
    let blocksHtml = "";

    const filteredBlocks = isUser
      ? msg.blocks
      : msg.blocks.filter((b) => {
          if (b.type === "thinking") return includeThinking;
          if (b.type === "tool_use") return includeTools;
          if (b.type === "tool_result") return includeTools && includeResults;
          return true;
        });

    if (filteredBlocks.length === 0) continue;

    for (const block of filteredBlocks) {
      if (block.type === "text") {
        blocksHtml += `<div class="markdown-body">${renderMarkdown(block.text)}</div>`;
      } else if (block.type === "thinking") {
        blocksHtml += `
          <details class="thinking">
            <summary>Thinking Process</summary>
            <pre>${escapeHtml(block.thinking)}</pre>
          </details>
        `;
      } else if (block.type === "tool_use") {
        const input = truncateJson(block.input, truncateChars);
        blocksHtml += `
          <div class="tool-block">
            <div class="tool-name">🛠 Tool Executed: ${escapeHtml(block.name)}</div>
            <pre class="tool-payload"><code>${escapeHtml(input)}</code></pre>
          </div>
        `;
      } else if (block.type === "tool_result") {
        const text = truncateText(String(block.content || ""), truncateChars);
        const label = block.is_error ? "⚠ Tool Error" : "✓ Tool Result";
        blocksHtml += `
          <div class="tool-block" style="${block.is_error ? 'border-color: #ef4444;' : ''}">
            <div class="tool-name" style="${block.is_error ? 'color: #ef4444;' : 'color: #10b981;'}">${escapeHtml(label)}</div>
            <pre class="tool-payload"><code>${escapeHtml(text)}</code></pre>
          </div>
        `;
      }
    }

    bodyContent += `
      <div class="message ${isUser ? 'user' : 'assistant'}">
        <div class="role">${roleLabel}</div>
        <div class="bubble-content">${blocksHtml}</div>
      </div>
    `;
  }

  const sourceLabel = session.source || "AI chat";
  const dateStr = session.date ? ` on ${session.date}` : "";
  const subtitle = `Exported from ${sourceLabel}${dateStr}`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(session.title)}</title>
  <style>
    :root {
      --bg-color: #0f0f23;
      --card-bg: rgba(15, 23, 42, 0.45);
      --border-color: rgba(255, 255, 255, 0.08);
      --text-color: #f1f5f9;
      --text-muted: #94a3b8;
      --user-bg: rgba(124, 58, 237, 0.08);
      --user-border: rgba(124, 58, 237, 0.15);
      --assistant-bg: rgba(37, 99, 235, 0.06);
      --assistant-border: rgba(37, 99, 235, 0.12);
      --code-bg: #050508;
      --inline-code-bg: rgba(124, 58, 237, 0.12);
      --inline-code-color: #c4b5fd;
      --pre-border: rgba(255, 255, 255, 0.06);
    }
    
    [data-theme="light"] {
      --bg-color: #f8fafc;
      --card-bg: #ffffff;
      --border-color: #cbd5e1;
      --text-color: #0f172a;
      --text-muted: #64748b;
      --user-bg: rgba(124, 58, 237, 0.05);
      --user-border: rgba(124, 58, 237, 0.2);
      --assistant-bg: rgba(37, 99, 235, 0.04);
      --assistant-border: rgba(37, 99, 235, 0.15);
      --code-bg: #f1f5f9;
      --inline-code-bg: rgba(124, 58, 237, 0.08);
      --inline-code-color: #6d28d9;
      --pre-border: #cbd5e1;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-color);
      margin: 0;
      padding: 40px 20px;
      line-height: 1.6;
      transition: background-color 0.3s, color 0.3s;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 20px;
      margin-bottom: 30px;
      flex-wrap: wrap;
      gap: 15px;
    }
    .header-info h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      font-weight: 800;
    }
    .meta {
      font-size: 13px;
      color: var(--text-muted);
    }
    .controls {
      display: flex;
      gap: 10px;
    }
    .btn {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      color: var(--text-color);
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover {
      background: var(--border-color);
    }
    .message {
      margin-bottom: 24px;
      padding: 20px;
      border-radius: 12px;
      border: 1px solid transparent;
    }
    .message.user {
      background-color: var(--user-bg);
      border-color: var(--user-border);
    }
    .message.assistant {
      background-color: var(--assistant-bg);
      border-color: var(--assistant-border);
    }
    .role {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
    }
    .user .role {
      color: #a78bfa;
    }
    .assistant .role {
      color: #60a5fa;
    }
    [data-theme="light"] .user .role {
      color: #7c3aed;
    }
    [data-theme="light"] .assistant .role {
      color: #2563eb;
    }
    .markdown-body {
      font-size: 14px;
      line-height: 1.6;
    }
    .markdown-body p { margin: 0 0 10px; }
    .markdown-body p:last-child { margin-bottom: 0; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3,
    .markdown-body h4, .markdown-body h5, .markdown-body h6 {
      margin: 16px 0 8px;
      font-weight: 700;
      line-height: 1.3;
    }
    .markdown-body h1 { font-size: 20px; }
    .markdown-body h2 { font-size: 18px; }
    .markdown-body h3 { font-size: 16px; }
    .markdown-body ul, .markdown-body ol {
      margin: 0 0 10px;
      padding-left: 20px;
    }
    .markdown-body li { margin: 4px 0; }
    .markdown-body blockquote {
      border-left: 3px solid #7c3aed;
      padding-left: 12px;
      color: var(--text-muted);
      margin: 12px 0;
      font-style: italic;
    }
    .markdown-body a {
      color: #a78bfa;
      text-decoration: underline;
    }
    [data-theme="light"] .markdown-body a {
      color: #6d28d9;
    }
    .markdown-body table {
      border-collapse: collapse;
      width: 100%;
      margin: 15px 0;
      font-size: 13px;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid var(--border-color);
      padding: 8px 12px;
      text-align: left;
    }
    .markdown-body th { background: rgba(255, 255, 255, 0.04); }
    [data-theme="light"] .markdown-body th { background: rgba(0, 0, 0, 0.02); }
    .markdown-body pre {
      position: relative;
      background-color: var(--code-bg);
      border: 1px solid var(--pre-border);
      border-radius: 8px;
      padding: 16px;
      overflow-x: auto;
      margin: 15px 0;
    }
    .markdown-body code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 12px;
    }
    .markdown-body :not(pre) > code {
      background-color: var(--inline-code-bg);
      color: var(--inline-code-color);
      padding: 2px 6px;
      border-radius: 4px;
    }
    /* Copy button style */
    .copy-code-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      opacity: 0;
      transition: opacity 0.2s;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--border-color);
      color: var(--text-color);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      z-index: 10;
    }
    .markdown-body pre:hover .copy-code-btn {
      opacity: 1;
    }
    .copy-code-btn:hover {
      background: var(--text-color);
      color: var(--bg-color);
    }
    /* Collapsible thinking blocks styling */
    details.thinking {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px;
      margin-top: 12px;
    }
    [data-theme="light"] details.thinking {
      background: rgba(0, 0, 0, 0.02);
    }
    details.thinking summary {
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
      outline: none;
    }
    details.thinking pre {
      margin-top: 10px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text-muted);
      margin-bottom: 0;
    }
    /* Tool block styling */
    .tool-block {
      background: var(--code-bg);
      border: 1px solid var(--pre-border);
      border-radius: 8px;
      padding: 12px;
      margin-top: 12px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    }
    .tool-name {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 6px;
      color: #f43f5e;
    }
    .tool-payload {
      font-size: 11px;
      margin: 0;
      white-space: pre-wrap;
      overflow-x: auto;
    }

    /* Print media CSS */
    @media print {
      body {
        background-color: white !important;
        color: black !important;
        padding: 0 !important;
      }
      .controls, .copy-code-btn {
        display: none !important;
      }
      header {
        border-bottom: 1px solid #cbd5e1 !important;
      }
      .message {
        background-color: white !important;
        border: 1px solid #cbd5e1 !important;
        color: black !important;
        page-break-inside: avoid;
      }
      .markdown-body pre {
        background-color: #f8fafc !important;
        border: 1px solid #cbd5e1 !important;
      }
      details.thinking {
        background: #f8fafc !important;
        border: 1px solid #cbd5e1 !important;
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-info">
        <h1>${escapeHtml(session.title)}</h1>
        <div class="meta">${escapeHtml(subtitle)}</div>
      </div>
      <div class="controls">
        <button class="btn" id="theme-toggle" aria-label="Toggle dark/light theme">
          <span id="theme-toggle-icon">☀️</span> <span id="theme-toggle-text">Light Mode</span>
        </button>
        <button class="btn" onclick="window.print()">
          🖨️ Print / Save PDF
        </button>
      </div>
    </header>

    <main>
      ${bodyContent}
    </main>
  </div>

  <script>
    // Theme Toggle script
    const themeToggle = document.getElementById('theme-toggle');
    const toggleIcon = document.getElementById('theme-toggle-icon');
    const toggleText = document.getElementById('theme-toggle-text');
    
    // Detect system preference
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    let currentTheme = localStorage.getItem('theme') || (systemPrefersDark ? 'dark' : 'light');
    
    function setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('theme', theme);
      if (theme === 'dark') {
        toggleIcon.textContent = '☀️';
        toggleText.textContent = 'Light Mode';
      } else {
        toggleIcon.textContent = '🌙';
        toggleText.textContent = 'Dark Mode';
      }
      currentTheme = theme;
    }
    
    // Initialize
    setTheme(currentTheme);
    
    themeToggle.addEventListener('click', () => {
      setTheme(currentTheme === 'dark' ? 'light' : 'dark');
    });

    // Copy Code Blocks Button Setup
    document.querySelectorAll('.markdown-body pre').forEach(pre => {
      // Ensure we don't double add buttons or add them to empty blocks
      if (pre.querySelector('.copy-code-btn')) return;
      
      const button = document.createElement('button');
      button.className = 'copy-code-btn';
      button.type = 'button';
      button.innerText = 'Copy';
      
      button.addEventListener('click', () => {
        const codeElement = pre.querySelector('code');
        let code = '';
        if (codeElement) {
          code = codeElement.textContent;
        } else {
          const clone = pre.cloneNode(true);
          const btn = clone.querySelector('.copy-code-btn');
          if (btn) btn.remove();
          code = clone.textContent;
        }
        navigator.clipboard.writeText(code).then(() => {
          button.innerText = 'Copied!';
          setTimeout(() => { button.innerText = 'Copy'; }, 2000);
        }).catch(err => {
          console.error('Failed to copy text: ', err);
          button.innerText = 'Error';
          setTimeout(() => { button.innerText = 'Copy'; }, 2000);
        });
      });
      
      pre.appendChild(button);
    });
  </script>
</body>
</html>`;
}
