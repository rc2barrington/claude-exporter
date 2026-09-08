import { SessionWorkspace } from "./SessionWorkspace.jsx";
import { parseCodexJsonl } from "../parsers/codexJsonl.js";

export function CodexTab() {
  return <SessionWorkspace
    accept=".jsonl"
    localSource="codex"
    showToolToggles
    sourceLabel="Codex rollout"
    parseFile={async (file, text) => parseCodexJsonl(text, { fileName: file.name })}
    noMatchHelp={<p>Codex rollouts live in ~/.codex/sessions. Automatic discovery above avoids the folder picker.</p>}
    folderAccess={{
      id: "codex-sessions",
      label: "Choose a Codex folder manually",
      reopenLabel: "Reload remembered Codex folder",
      hint: "Optional fallback: choose ~/.codex/sessions. On macOS, Cmd+Shift+G lets you enter a hidden folder path.",
      emptyHint: "No Codex rollouts found. Select ~/.codex/sessions, or use automatic discovery in the local app.",
      include: name => name.toLowerCase().endsWith(".jsonl"),
      enterDir: () => true,
    }}
  />;
}
