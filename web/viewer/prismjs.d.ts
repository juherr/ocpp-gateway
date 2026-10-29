// Prism's core and grammars, imported one by one so the bundle carries only
// the JSON grammar; @types/prismjs types the package's main entry only.

declare module "prismjs/components/prism-core" {
  import type * as PrismType from "prismjs";
  const Prism: typeof PrismType;
  export default Prism;
}

declare module "prismjs/components/prism-json";
