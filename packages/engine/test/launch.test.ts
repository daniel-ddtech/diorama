import { describe, expect, it } from "vitest";

import { buildArgs, launchChrome } from "../src/launch.js";

describe("launchChrome", () => {
  it("reports how to configure a missing Chrome binary", async () => {
    await expect(launchChrome({
      binary: "/definitely/missing/diorama-chrome",
      userDataDir: "/tmp/diorama-profile",
      extensionDir: "/tmp/diorama-extension",
    })).rejects.toThrow(/Pass opts\.binary or set DIORAMA_CHROME/);
  });

  it("builds the headless and unpacked-extension arguments", () => {
    const args = buildArgs({
      userDataDir: "/tmp/diorama-profile",
      extensionDir: "/tmp/diorama-extension",
    });

    expect(args).toContain("--headless=new");
    expect(args).toContain("--load-extension=/tmp/diorama-extension");
    expect(args).toContain("--disable-extensions-except=/tmp/diorama-extension");
  });
});
