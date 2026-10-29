/**
 * JSON syntax highlighting for the detail panel, with Prism's tokenizer only:
 * tokens become nodes through a `Builder` (spans and text nodes on the page),
 * never an HTML string, so a payload's content always stays text.
 */

import Prism from "prismjs/components/prism-core";
// prism-json registers its grammar on a global `Prism`, which the bundle does
// not define: `prism-global` provides it first (imports run in order).
import "./prism-global";
import "prismjs/components/prism-json";

// Prism highlights the page by itself once loaded unless `manual` is set; it
// checks again when that callback fires (DOMContentLoaded or the next frame),
// so setting it here, as the bundle starts, is enough.
Prism.manual = true;

/** Above this length of pretty-printed text, the payload is shown plain. */
export const HIGHLIGHT_MAX_CHARS = 256 * 1024;

/** Builds the nodes of a token stream: text for text, a span per token. */
export interface Builder<N> {
  text(value: string): N;
  span(className: string, children: N[]): N;
}

/** Prism's tokens of `text` as JSON; `null` above `HIGHLIGHT_MAX_CHARS`. */
export function jsonTokens(text: string): Prism.TokenStream | null {
  if (text.length > HIGHLIGHT_MAX_CHARS) return null;
  return Prism.tokenize(text, Prism.languages.json);
}

/** `token <type> <aliases>`, Prism's class names: the grammar's, never the payload's. */
function tokenClass(token: Prism.Token): string {
  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  return ["token", token.type, ...aliases].join(" ");
}

export function buildTokens<N>(stream: Prism.TokenStream, build: Builder<N>): N[] {
  if (typeof stream === "string") return [build.text(stream)];
  if (Array.isArray(stream)) return stream.flatMap((item) => buildTokens(item, build));
  return [build.span(tokenClass(stream), buildTokens(stream.content, build))];
}
