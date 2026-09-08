import { SessionWorkspace } from "./SessionWorkspace.jsx";
import { parseOpenCode } from "../parsers/opencode.js";

export function OpenCodeTab() {
  return <SessionWorkspace accept=".json" localSource="opencode" showToolToggles
    sourceLabel="OpenCode export (opencode export SESSION_ID)"
    parseFile={async (_file, text) => parseOpenCode(text)} />;
}
