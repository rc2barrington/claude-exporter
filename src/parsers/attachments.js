// Only structured attachment records qualify. Never interpret paths in chat
// prose or tool commands as permission to read files from the computer.
export function attachmentText(part, attachments) {
  const url = typeof part.image_url === "object" ? part.image_url.url : part.image_url || part.url;
  if (typeof url !== "string" || !url) return "[Attachment unavailable in saved session]";
  const mime = part.mime || part.media_type || (/^data:([^;,]+)/.exec(url)?.[1]) || "";
  const image = part.type?.includes("image") || mime.startsWith("image/");
  let label = part.filename || "";
  if (!label && url.startsWith("file:")) { try { label = decodeURIComponent(new URL(url).pathname.split("/").pop()); } catch { /* keep fallback */ } }
  const extension = mime.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg").replace(/[^a-z0-9]/gi, "") || "bin";
  label = String(label || `attachment-${attachments.length + 1}.${extension}`).replace(/[[\]<>\r\n]/g, "");
  const index = attachments.length;
  attachments.push({ url, mime, image, label });
  return `${image ? "!" : ""}[${label}](attachment:${index})`;
}
