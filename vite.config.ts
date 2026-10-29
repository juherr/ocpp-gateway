import { defineConfig } from "vite-plus";

// Vite+ drives this Node/TypeScript service's toolchain:
//   - `vp pack`  bundles src/index.ts → dist/ (Rolldown via tsdown)
//   - `vp lint`  / `vp fmt`  lint and format (Oxlint + Oxfmt)
// There is no Vite web app here, so `vp build` is not used.
export default defineConfig({
  lint: {
    ignorePatterns: ["dist/**"],
  },
  fmt: {
    // Markdown is excluded: Oxfmt's experimental Markdown formatting disagrees
    // across platforms (macOS strips the trailing newline, Linux requires it),
    // which made `vp fmt --check` flap between local and CI. Format code only.
    // The vendored Open OCPP Trace files stay byte-identical to upstream.
    ignorePatterns: ["dist/**", "**/*.md", "test/fixtures/open-ocpp-trace/**"],
  },
  test: {
    // deploy/cloudflare/src/forward.ts is runtime-agnostic, so its tests run here too.
    include: ["test/**/*.test.ts", "deploy/cloudflare/test/**/*.test.ts"],
    // Silence the logger for every test; logger tests install their own sink.
    setupFiles: ["./test/setup.ts"],
  },
  pack: [
    {
      entry: ["src/index.ts"],
      format: ["cjs"],
      sourcemap: true,
      dts: false,
    },
    // The viewer's page: one browser script (dist/viewer/viewer.js) plus the
    // html and css it needs, read by the gateway at viewer startup.
    {
      entry: { viewer: "web/viewer/app.ts" },
      format: ["iife"],
      platform: "browser",
      target: "es2022",
      tsconfig: "tsconfig.web.json",
      outDir: "dist/viewer",
      // tsdown names an iife `[name].iife.js`; the page loads /viewer.js.
      outputOptions: { entryFileNames: "[name].js" },
      minify: true,
      // No map: the viewer serves no viewer.js.map.
      sourcemap: false,
      dts: false,
      copy: ["web/viewer/index.html", "web/viewer/viewer.css"],
    },
  ],
});
