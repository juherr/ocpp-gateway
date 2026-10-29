/**
 * Prism's language components (`prismjs/components/prism-*.js`) extend a
 * global `Prism`; Prism's core only defines it under Node. Imported before
 * any of them.
 */

import Prism from "prismjs/components/prism-core";

(globalThis as { Prism?: typeof Prism }).Prism = Prism;
