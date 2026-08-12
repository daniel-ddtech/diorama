import { describe, expect, it } from "vitest";

import { makeTabsQueryShim } from "../src/shim.js";

describe("makeTabsQueryShim", () => {
  it("targets the requested stage tab and supports promise and callback callers", () => {
    const source = makeTabsQueryShim(4242);

    expect(source).toContain("x.id === 4242");
    expect(source).toContain('typeof cb === "function"');
    expect(source).toContain("run.then(cb)");
    expect(source).toContain("return run");
    expect(source).toContain("q.currentWindow || q.lastFocusedWindow");
  });
});
