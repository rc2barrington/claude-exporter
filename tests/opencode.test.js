import { expect, it } from "vitest";
import { parseOpenCode } from "../src/parsers/opencode.js";
import { generateMarkdown } from "../src/generators/markdown.js";

it("exports OpenCode text, files, reasoning, calls and results without duplicate bookkeeping", () => {
  const session = parseOpenCode({ info: { title: "Test", time: { created: 1000, updated: 2000 } }, messages: [
    { info: { role: "user", id: "1" }, parts: [{ type: "text", text: "First prompt" }, { type: "file", filename: "notes.md", url: "file:///tmp/notes.md" }] },
    { info: { role: "assistant", id: "2" }, parts: [{ type: "reasoning", text: "Summary" }, { type: "step-start" }, { type: "tool", tool: "read", callID: "call", state: { status: "completed", input: { file: "notes.md" }, output: "Contents" } }, { type: "text", text: "Done" }] },
  ] });
  expect(session.messages).toHaveLength(2);
  expect(session.messages[0].blocks[0].text).toBe("First prompt");
  const md = generateMarkdown(session, { includeThinking: true, includeTools: true, includeResults: true, truncateChars: 0 });
  for (const text of ["OpenCode", "First prompt", "notes.md", "Summary", "Contents", "Done"]) expect(md).toContain(text);
});

it("excludes the reverted tail of the active OpenCode conversation", () => {
  const session = parseOpenCode({ info: { revert: { messageID: "2" } }, messages: [1, 2, 3].map(id => ({ info: { id: String(id), role: "user" }, parts: [{ type: "text", text: `Prompt ${id}` }] })) });
  expect(session.messages).toHaveLength(1);
});

it("rejects unrelated JSON", () => { expect(() => parseOpenCode("{}")).toThrow(/Not an OpenCode/); });
