import { generateMarkdown } from "../generators/markdown.js";
import "../../chrome-extension/exportCore.js";

export async function sessionFiles(session, options, loadAttachment, signal) {
  const messages = [{ text: generateMarkdown(session, options) }];
  const saved = [], failures = [];
  for (const [index, attachment] of (session.attachments || []).entries()) {
    signal.throwIfAborted();
    try {
      const blob = await loadAttachment(attachment, index, signal);
      if (!blob.size) throw new Error("Empty attachment");
      const label = attachment.label.replace(/[\\/:*?"<>|\p{Cc}]/gu, "-").replace(/^\.+/, "").slice(-180) || "attachment";
      const filename = `${index + 1}-${label}`;
      saved.push({ filename, blob, type: attachment.image ? "image/unknown" : attachment.mime });
      messages[0].text = messages[0].text.replaceAll(`(attachment:${index})`, `(<media/${filename}>)`);
    } catch (error) {
      signal.throwIfAborted();
      failures.push(`${attachment.label}: ${error.message}`);
      messages[0].text = messages[0].text.replaceAll(`(attachment:${index})`, `(attachment-unavailable) [File unavailable: ${attachment.label.replace(/[\r\n]/g, " ")}]`);
    }
  }
  const result = await globalThis.AIChatExporterCore.deduplicateImages(saved, messages, () => signal.throwIfAborted());
  const files = [{ filename: "conversation.md", content: messages[0].text }];
  for (const media of result.savedMedia) files.push({ filename: "media/" + media.filename, content: await media.blob.arrayBuffer() });
  signal.throwIfAborted();
  return { files, failures, duplicates: result.duplicates };
}
