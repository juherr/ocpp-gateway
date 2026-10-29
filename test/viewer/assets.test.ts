import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadViewerAssets } from "../../src/viewer/assets";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function assetsDir(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "viewer-assets-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("loadViewerAssets", () => {
  it("reads the page, its script and its style from the directory", () => {
    const path = assetsDir({
      "index.html": "<!doctype html><title>t</title>",
      "viewer.js": "/* js */",
      "viewer.css": "/* css — utf-8 */",
    });

    expect(loadViewerAssets(path)).toEqual({
      html: "<!doctype html><title>t</title>",
      js: "/* js */",
      css: "/* css — utf-8 */",
    });
  });

  it("fails with a message naming the missing file and how to build it", () => {
    const path = assetsDir({ "index.html": "<!doctype html>", "viewer.css": "" });

    expect(() => loadViewerAssets(path)).toThrow(
      `viewer asset missing: ${join(path, "viewer.js")} (run \`npm run build\`)`,
    );
  });
});
