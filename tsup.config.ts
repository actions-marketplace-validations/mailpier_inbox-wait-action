import { defineConfig } from "tsup";

// One self-contained file (the Node client is bundled in): GitHub runs dist/index.js as is, without npm install.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  outExtension: () => ({ js: ".js" }),
  platform: "node",
  target: "node20",
  bundle: true,
  noExternal: [/.*/],
  clean: true,
  dts: false,
  sourcemap: false,
});
