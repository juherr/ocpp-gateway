import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewerAssets } from "./server";

const FILES = { html: "index.html", js: "viewer.js", css: "viewer.css" } as const;

/**
 * Reads the viewer's page and assets, built into `dist/viewer/` by
 * `npm run build` (sources in `web/viewer/`). Read once, at startup: a
 * missing file fails fast with its path instead of serving a broken page.
 */
export function loadViewerAssets(dir: string): ViewerAssets {
  const read = (name: string): string => {
    const path = join(dir, name);
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`viewer asset missing: ${path} (run \`npm run build\`)`);
      }
      throw err;
    }
  };
  return { html: read(FILES.html), js: read(FILES.js), css: read(FILES.css) };
}
