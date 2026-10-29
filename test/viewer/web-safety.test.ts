import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The page renders OCPP payloads, which are untrusted: its sources never use
 * a sink that would interpret them as HTML or code, and keep to the viewer's
 * CSP (no inline script nor style).
 */

const WEB = join(__dirname, "..", "..", "web", "viewer");
const files = readdirSync(WEB, { recursive: true, encoding: "utf8" }).filter((name) =>
  /\.(ts|html|css)$/.test(name),
);

const FORBIDDEN: [string, RegExp][] = [
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["document.write", /\bdocument\s*\.\s*write(ln)?\b/],
  ["eval", /\beval\s*\(/],
  ["new Function", /\bnew\s+Function\b/],
  ["string timer", /\bset(Timeout|Interval)\s*\(\s*["'`]/],
  ["DOMParser", /\bDOMParser\b/],
  ["createContextualFragment", /\bcreateContextualFragment\b/],
  ["srcdoc", /\bsrcdoc\b/],
  ["inline handler property", /\.\s*on[a-z]+\s*=(?!=)/],
];

describe("viewer page sources", () => {
  it("are found", () => {
    expect(files).toEqual(
      expect.arrayContaining(["app.ts", "model.ts", "sse.ts", "index.html", "viewer.css"]),
    );
  });

  it.each(files)("%s uses no HTML or code sink", (name) => {
    const source = readFileSync(join(WEB, name), "utf8");
    for (const [label, pattern] of FORBIDDEN) {
      expect(pattern.test(source), `${name} uses ${label}`).toBe(false);
    }
  });

  it("index.html has no inline script, style nor handler, and loads its own assets", () => {
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//i);
    expect(html).toContain('<script src="/viewer.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="/viewer.css" />');
  });
});
