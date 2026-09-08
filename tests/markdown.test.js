import { describe, it, expect } from "vitest";
import { generateMarkdown } from "../src/generators/markdown.js";

const session = {
  title: "Test Session",
  date: "2026-05-01 12:00",
  startedAt: "2026-05-01T12:00:00Z",
  endedAt: "2026-05-01T12:01:00Z",
  source: "Claude Code",
  messages: [
    { role: "## You", blocks: [{ type: "text", text: "hi" }] },
    {
      role: "## Claude",
      blocks: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "hello" },
        { type: "tool_use", name: "bash", input: { cmd: "ls" } },
        { type: "tool_result", content: "file1\nfile2", is_error: false },
      ],
    },
  ],
};

describe("generateMarkdown", () => {
  it("hides thinking when includeThinking is false", () => {
    const md = generateMarkdown(session, { includeThinking: false, includeTools: false });
    expect(md).not.toContain("internal");
    expect(md).not.toContain("Thinking Process");
  });

  it("includes tool_use only when toggled on", () => {
    const md = generateMarkdown(session, { includeTools: true });
    expect(md).toContain("Tool Use: `bash`");
    expect(md).not.toContain("Tool Result");
  });

  it("includes tool_result only when both toggles are on", () => {
    const md = generateMarkdown(session, { includeTools: true, includeResults: true });
    expect(md).toContain("Tool Result");
    expect(md).toContain("file1");
  });

  it("emits a YAML frontmatter when requested", () => {
    const md = generateMarkdown(session, { frontmatter: true });
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("source: Claude Code");
    expect(md).toContain("started_at: 2026-05-01T12:00:00Z");
  });

  it("truncates long strings inside tool_use input", () => {
    const longStr = "x".repeat(5000);
    const big = {
      ...session,
      messages: [
        { role: "## Claude", blocks: [{ type: "tool_use", name: "n", input: { huge: longStr } }] },
      ],
    };
    const md = generateMarkdown(big, { includeTools: true, truncateChars: 100 });
    expect(md).toContain("truncated, 4900 more chars");
  });

  it("falls back gracefully when source is missing", () => {
    const noSrc = { ...session, source: undefined };
    const md = generateMarkdown(noSrc, {});
    expect(md).toContain("Exported from AI chat");
  });
});
