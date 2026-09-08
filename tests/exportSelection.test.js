import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await import("../chrome-extension/exportSelection.js");
});

describe("export target selection", () => {
  const tabs = [
    { id: 11, title: "First", url: "https://chatgpt.com/c/first" },
    { id: 22, title: "Second", url: "https://chatgpt.com/c/second" },
  ];

  it("requires two confirmations bound to the exact batch snapshot", () => {
    const check = globalThis.AIChatExporterSelection.hasBatchConfirmation;
    expect(check({}, tabs)).toBe(false);
    expect(check({ confirmation: { steps: 1, targetIds: [11, 22] } }, tabs)).toBe(false);
    expect(check({ confirmation: { steps: 2, targetIds: [11] } }, tabs)).toBe(false);
    expect(check({ confirmation: { steps: 2, targetIds: [11, 22] } }, tabs)).toBe(true);
    expect(check({}, [tabs[0]])).toBe(true);
  });

  it("excludes a chat immediately after it is unchecked", () => {
    const selection = globalThis.AIChatExporterSelection.createSelectionState([11, 22]);
    selection.set(22, false);

    expect(selection.ids()).toEqual([11]);
    expect(globalThis.AIChatExporterSelection.targetsForSelection(
      tabs,
      selection.ids()
    )).toEqual([
      { id: 11, title: "First", url: "https://chatgpt.com/c/first" },
    ]);
  });

  it("intersects numeric ids with details so stale details cannot add a tab", () => {
    expect(globalThis.AIChatExporterSelection.requestedTargets({
      tabs: [11],
      tabDetails: tabs,
    })).toEqual([
      { id: 11, title: "First", url: "https://chatgpt.com/c/first" },
    ]);
  });

  it("deduplicates ids and drops invalid or no-longer-detected tabs", () => {
    expect(globalThis.AIChatExporterSelection.targetsForSelection(
      tabs,
      [22, 22, "invalid", "", null, 0, 99]
    )).toEqual([
      { id: 22, title: "Second", url: "https://chatgpt.com/c/second" },
    ]);
  });

  it("supports a legacy popup that sends only numeric tab ids", () => {
    expect(globalThis.AIChatExporterSelection.requestedTargets({
      tabs: [11],
    })).toEqual([
      { id: 11, title: "Tab 11", url: "" },
    ]);
  });
});
