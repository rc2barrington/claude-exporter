import JSZip from "jszip";
import { sanitizeFilename } from "./download.js";

// A Date shifted so that JSZip's UTC-based DOS timestamp encoding stores the
// local wall clock.
//
// JSZip builds each entry's timestamp with getUTCHours/getUTCFullYear, but the
// ZIP format defines that field as local time, so every extractor reads it back
// as local. West of UTC that makes extracted files look like they were modified
// hours in the future -- 5 hours in US Central.
export function zipLocalDate(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000);
}

// Bundles {filename, content} entries into a single .zip Blob.
// Disambiguates collisions by suffixing -2, -3, etc.
export async function bundleZip(files) {
  const zip = new JSZip();
  const used = new Set();
  const date = zipLocalDate();
  for (const f of files) {
    let name = f.filename || sanitizeFilename(f.title || "session") + ".md";
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n++;
      name = `${stem}-${n}${ext}`;
    }
    used.add(name);
    zip.file(name, f.content, { date });
  }
  zip.forEach((_path, entry) => { entry.date = date; });
  return zip.generateAsync({ type: "blob" });
}
