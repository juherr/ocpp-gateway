import Prism from "prismjs/components/prism-core";
import { describe, expect, it } from "vitest";
import {
  buildTokens,
  type Builder,
  HIGHLIGHT_MAX_CHARS,
  jsonTokens,
} from "../../../web/viewer/highlight";

/** What the page builds, as plain data: spans with their class, and text. */
type Built = string | { span: string; children: Built[] };

const tree: Builder<Built> = {
  text: (value) => value,
  span: (className, children) => ({ span: className, children }),
};

const textOf = (nodes: Built[]): string =>
  nodes.map((node) => (typeof node === "string" ? node : textOf(node.children))).join("");

const classesOf = (nodes: Built[]): string[] =>
  nodes.flatMap((node) =>
    typeof node === "string" ? [] : [node.span, ...classesOf(node.children)],
  );

describe("jsonTokens", () => {
  it("tokenizes pretty JSON with Prism's JSON grammar, losing no text", () => {
    const text = JSON.stringify({ a: "x", n: -1.5, t: true, z: null, l: [1] }, null, 2);
    const nodes = buildTokens(jsonTokens(text) ?? [], tree);

    expect(textOf(nodes)).toBe(text);
    expect(classesOf(nodes)).toEqual(
      expect.arrayContaining([
        "token property",
        "token string",
        "token number",
        "token boolean",
        "token null keyword",
        "token punctuation",
        "token operator",
      ]),
    );
  });

  it("keeps markup in a payload as text", () => {
    const text = JSON.stringify({ idTag: "<img src=x onerror=alert(1)>" }, null, 2);
    const nodes = buildTokens(jsonTokens(text) ?? [], tree);

    expect(textOf(nodes)).toBe(text);
    const string = nodes.find((node) => typeof node !== "string" && node.span === "token string");
    expect(string).toEqual({ span: "token string", children: ['"<img src=x onerror=alert(1)>"'] });
  });

  it("does not highlight text above the size cap", () => {
    expect(HIGHLIGHT_MAX_CHARS).toBe(256 * 1024);
    expect(jsonTokens("1".repeat(HIGHLIGHT_MAX_CHARS))).not.toBeNull();
    expect(jsonTokens("1".repeat(HIGHLIGHT_MAX_CHARS + 1))).toBeNull();
  });

  it("leaves Prism in manual mode: it never highlights the page by itself", () => {
    expect(Prism.manual).toBe(true);
  });
});

describe("buildTokens", () => {
  it("builds nested tokens, with their aliases as classes", () => {
    const stream = [
      "a",
      new Prism.Token("outer", ["b", new Prism.Token("inner", "c", ["x", "y"])], "alias"),
      new Prism.Token("leaf", "d"),
    ];

    expect(buildTokens(stream, tree)).toEqual([
      "a",
      {
        span: "token outer alias",
        children: ["b", { span: "token inner x y", children: ["c"] }],
      },
      { span: "token leaf", children: ["d"] },
    ]);
  });
});
