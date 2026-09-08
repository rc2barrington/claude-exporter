import { attachmentText } from "./attachments.js";
// Accepts the official `opencode export` JSON shape and local database exports.
export function parseOpenCode(input) {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  if (!data?.info || !Array.isArray(data.messages)) throw new Error("Not an OpenCode session export.");
  const messages = [];
  const attachments = [];
  for (const entry of data.messages) {
    const info = entry.info || {};
    if (data.info.revert?.messageID && info.id === data.info.revert.messageID) break;
    if (!["user", "assistant"].includes(info.role)) continue;
    const blocks = [];
    for (const part of entry.parts || []) {
      if (part.type === "text" && part.text) blocks.push({ type: "text", text: part.text });
      if (part.type === "reasoning" && part.text) blocks.push({ type: "thinking", thinking: part.text });
      if (part.type === "file") {
        blocks.push({ type: "text", text: attachmentText(part, attachments) });
      }
      if (part.type === "tool") {
        const state = part.state || {};
        blocks.push({ type: "tool_use", id: part.callID, name: part.tool || "tool", input: state.input || {} });
        if (state.output != null || state.error != null) blocks.push({
          type: "tool_result", tool_use_id: part.callID,
          content: typeof (state.output ?? state.error) === "string" ? (state.output ?? state.error) : JSON.stringify(state.output ?? state.error),
          is_error: state.status === "error",
        });
      }
    }
    if (blocks.length) messages.push({ role: info.role === "user" ? "## You" : "## OpenCode", blocks });
  }
  const iso = value => value ? new Date(value).toISOString() : "";
  return { title: data.info.title || "OpenCode session", source: "OpenCode", messages, attachments,
    startedAt: iso(data.info.time?.created), endedAt: iso(data.info.time?.updated) };
}
