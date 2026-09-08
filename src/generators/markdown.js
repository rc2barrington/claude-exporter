// Renders a parsed session into a markdown string.
//
// opts:
//   includeThinking  bool   - wrap thinking blocks in <details>
//   includeTools     bool   - render tool_use blocks
//   includeResults   bool   - render tool_result blocks (paired with includeTools)
//   truncateChars    number - max chars for tool_use input fields and tool_result content (0 = no truncation)
//   frontmatter      bool   - prepend a YAML frontmatter block

const NL = "\n";

export function generateMarkdown(session, opts = {}) {
  const {
    includeThinking = true,
    includeTools = false,
    includeResults = false,
    truncateChars = 0,
    frontmatter = false,
  } = opts;

  let md = "";

  if (frontmatter) {
    md += "---" + NL;
    md += `title: ${yamlString(session.title)}` + NL;
    md += `source: ${yamlString(session.source || "Unknown")}` + NL;
    if (session.startedAt) md += `started_at: ${session.startedAt}` + NL;
    if (session.endedAt) md += `ended_at: ${session.endedAt}` + NL;
    md += `message_count: ${session.messages.length}` + NL;
    md += "---" + NL + NL;
  }

  md += `# ${session.title}${NL}${NL}`;
  for (const warning of session.warnings || []) md += `> Export warning: ${warning}${NL}${NL}`;
  const sourceLabel = session.source || "AI chat";
  if (session.date) {
    md += `> Exported from ${sourceLabel} on ${session.date}${NL}${NL}`;
  } else {
    md += `> Exported from ${sourceLabel}${NL}${NL}`;
  }
  md += `---${NL}${NL}`;

  const rendered = [];
  for (const msg of session.messages) {
    let body = "";
    if (msg.role === "## You") {
      body = msg.blocks.map((b) => b.text || "").join(NL).trim();
    } else {
      body = msg.blocks
        .map((block) => renderBlock(block, { includeThinking, includeTools, includeResults, truncateChars }))
        .filter(Boolean)
        .join(NL + NL)
        .trim();
    }
    if (body) rendered.push({ role: msg.role, body });
  }

  rendered.forEach((m, i) => {
    md += `${m.role}${NL}${NL}${m.body}${NL}${NL}`;
    if (i < rendered.length - 1) md += `---${NL}${NL}`;
  });

  return md;
}

function renderBlock(block, opts) {
  if (block.type === "text") return block.text || "";
  if (block.type === "thinking") {
    if (!opts.includeThinking) return "";
    return `<details>\n<summary>Thinking Process</summary>\n\n${block.thinking}\n\n</details>`;
  }
  if (block.type === "tool_use") {
    if (!opts.includeTools) return "";
    const input = truncateJson(block.input, opts.truncateChars);
    return `**Tool Use: \`${block.name}\`**\n\`\`\`json\n${input}\n\`\`\``;
  }
  if (block.type === "tool_result") {
    if (!opts.includeTools || !opts.includeResults) return "";
    const text = truncateText(String(block.content || ""), opts.truncateChars);
    const label = block.is_error ? "Tool Result (error)" : "Tool Result";
    return `**${label}**\n\`\`\`\n${text}\n\`\`\``;
  }
  return "";
}

function truncateJson(value, limit) {
  if (!limit) return JSON.stringify(value, null, 2);
  // Truncate long string fields in-place before stringifying.
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

function yamlString(v) {
  if (v == null) return '""';
  const s = String(v);
  // Quote if contains anything that could confuse a YAML reader.
  if (/[:#\-?&*!|>'"%@`\n]/.test(s)) return JSON.stringify(s);
  return s;
}
