// Parses Codex CLI rollout transcripts
// (~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl).
//
// Every line is { timestamp, type, payload }. Verified against 127 local
// sessions, the shape that matters is:
//
//   { type: "session_meta",  payload: { id, timestamp, cwd, cli_version, ... } }
//   { type: "response_item", payload: { type: "message", role, content: [...] } }
//   { type: "response_item", payload: { type: "reasoning", summary: [...] } }
//   { type: "response_item", payload: { type: "custom_tool_call"|"function_call", ... } }
//   { type: "response_item", payload: { type: "...call_output", output: [...] } }
//
// Three details drive this parser:
//
//   - `event_msg` records mirror the same conversation as UI events
//     (agent_message, user_message, agent_reasoning). Reading both would
//     duplicate every message, so only `response_item` is used.
//   - Assistant output arrives in many consecutive parts. Runs of five or
//     more are common, so assistant text, reasoning and tool calls sharing a
//     turn are merged into one turn rather than emitted as separate messages.
//   - `developer` messages are injected instructions (skills_instructions,
//     app-context), never conversation, so they are dropped.

import { attachmentText } from "./attachments.js";

export function parseCodexJsonl(fileContent, opts = {}) {
  const lines = String(fileContent || "").split("\n");
  const messages = [];
  const attachments = [];
  const warnings = [];
  let firstTimestamp = null;
  let lastTimestamp = null;
  let meta = null;
  let currentTurn = null;

  const noteTimestamp = (ts) => {
    if (!ts) return;
    const t = new Date(ts).getTime();
    if (Number.isNaN(t)) return;
    if (firstTimestamp == null || t < firstTimestamp) firstTimestamp = t;
    if (lastTimestamp == null || t > lastTimestamp) lastTimestamp = t;
  };

  // Assistant-side blocks are appended to the open turn; anything else closes it.
  const pushAssistant = (block, ts) => {
    if (!block) return;
    if (!currentTurn) {
      currentTurn = { role: "## Codex", blocks: [], timestamp: ts };
      messages.push(currentTurn);
    }
    currentTurn.blocks.push(block);
    if (ts) currentTurn.timestamp = ts;
  };

  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      warnings.push(`Source record ${lineIndex + 1} could not be parsed. Its contents are not included in this export.`);
      continue;
    }

    noteTimestamp(obj.timestamp);

    if (obj.type === "session_meta" && obj.payload && !meta) {
      meta = obj.payload;
      noteTimestamp(obj.payload.timestamp);
      continue;
    }

    if (obj.type !== "response_item") continue;
    const p = obj.payload;
    if (!p || typeof p !== "object") continue;

    switch (p.type) {
      case "message": {
        if (!["user", "assistant"].includes(p.role)) break; // injected instructions
        const text = collectText(p.content, attachments);
        if (p.role === "user") {
          const cleaned = cleanUserText(text);
          if (!cleaned) break; // pure scaffolding turn
          currentTurn = null;
          messages.push({
            role: "## You",
            blocks: [{ type: "text", text: cleaned }],
            timestamp: obj.timestamp,
          });
        } else if (text.trim()) {
          pushAssistant({ type: "text", text: text.trim() }, obj.timestamp);
        }
        break;
      }

      case "agent_message": {
        // Sub-agent reply routed back into the thread.
        const text = collectText(p.content);
        if (text.trim()) pushAssistant({ type: "text", text: text.trim() }, obj.timestamp);
        break;
      }

      case "reasoning": {
        // summary[] carries readable reasoning; encrypted_content is opaque.
        const think = collectText(p.summary);
        if (think.trim()) pushAssistant({ type: "thinking", thinking: think.trim() }, obj.timestamp);
        break;
      }

      case "custom_tool_call":
        pushAssistant(
          { type: "tool_use", id: p.call_id || p.id, name: p.name || "tool", input: parseMaybeJson(p.input) },
          obj.timestamp
        );
        break;

      case "function_call":
        pushAssistant(
          { type: "tool_use", id: p.call_id || p.id, name: p.name || "tool", input: parseMaybeJson(p.arguments) },
          obj.timestamp
        );
        break;

      case "custom_tool_call_output":
      case "function_call_output": {
        const out = collectText(p.output, attachments);
        pushAssistant(
          { type: "tool_result", tool_use_id: p.call_id, content: out, is_error: false },
          obj.timestamp
        );
        break;
      }

      default:
        break;
    }
  }

  const startedAt = firstTimestamp ? new Date(firstTimestamp).toISOString() : "";
  const endedAt = lastTimestamp ? new Date(lastTimestamp).toISOString() : "";
  const date = startedAt ? new Date(startedAt).toLocaleString() : "";

  return {
    title: deriveTitle(opts.title, messages, meta, opts.fileName),
    date,
    startedAt,
    endedAt,
    messages,
    attachments,
    warnings,
    source: "Codex",
  };
}

// Rollout files carry no thread name, so fall back through: an explicitly
// supplied title, the first user message, then the file's own name.
function deriveTitle(explicit, messages, meta, fileName) {
  if (explicit && explicit.trim()) return explicit.trim();

  const firstUser = messages.find((m) => m.role === "## You");
  if (firstUser) {
    const text = (firstUser.blocks[0] && firstUser.blocks[0].text) || "";
    const line = text.split("\n").find((l) => l.trim());
    if (line) {
      const t = line.trim().replace(/^#+\s*/, "");
      return t.length > 60 ? t.slice(0, 60).trimEnd() + "…" : t;
    }
  }

  if (fileName) {
    const m = String(fileName).match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (m) return `Codex Session ${m[1]} ${m[2]}:${m[3]}`;
  }
  if (meta && meta.timestamp) return `Codex Session ${String(meta.timestamp).slice(0, 10)}`;
  return "Codex Session";
}

function collectText(content, attachments) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (!b || typeof b !== "object") return "";
      // input_text / output_text / summary_text all use `text`.
      if (typeof b.text === "string") return b.text;
      if (attachments && ["input_image", "image", "input_file", "file"].includes(b.type)) return attachmentText(b, attachments);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseMaybeJson(value) {
  if (value == null) return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// Reconstruct slash-command invocations and remove injected XML scaffolding.
function cleanUserText(raw) {
  if (!raw) return "";
  let text = raw;

  const commandName = matchTag(text, "command-name");
  const commandArgs = matchTag(text, "command-args");

  const dropTags = [
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "local-command-caveat",
    "system-reminder",
    "environment_context",
    "recommended_plugins",
    "task-notification",
    "turn_aborted",
    "app-context",
    "skills_instructions",
  ];
  for (const tag of dropTags) {
    text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "g"), "");
    text = text.replace(new RegExp(`<\\/?${tag}>`, "g"), "");
  }

  text = text.trim();

  if (commandName) {
    const invocation = [commandName, commandArgs].filter(Boolean).join(" ").trim();
    return text ? `${invocation}\n\n${text}` : invocation;
  }
  return text;
}

function matchTag(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : "";
}
