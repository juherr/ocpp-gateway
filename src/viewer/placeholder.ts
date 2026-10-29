import type { ViewerAssets } from "./server";

/**
 * Stand-in page until the viewer UI ships. Like the real page, it keeps to
 * the viewer's CSP: no inline script nor style.
 */
export const PLACEHOLDER_ASSETS: ViewerAssets = {
  html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>OCPP Gateway Viewer</title>
    <link rel="stylesheet" href="/viewer.css">
    <script src="/viewer.js" defer></script>
  </head>
  <body>
    <h1>OCPP Gateway Viewer</h1>
    <p>The live trace viewer UI ships in a later release.</p>
  </body>
</html>
`,
  js: "// The live trace viewer UI ships in a later release.\n",
  css: "body { font-family: system-ui, sans-serif; margin: 2rem; }\n",
};
