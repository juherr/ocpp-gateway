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
    ignorePatterns: ["dist/**", "**/*.md"],
  },
  pack: {
    entry: ["src/index.ts"],
    format: ["cjs"],
    sourcemap: true,
    dts: false,
  },
});
