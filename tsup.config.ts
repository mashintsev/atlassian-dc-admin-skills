import { defineConfig } from "tsup";

// The CLI is bundled with all dependencies into the skill folder, so the skill
// runs with plain `node` and no node_modules next to it.
export default defineConfig({
  entry: { "atlassian-admin": "src/cli.ts" },
  outDir: "atlassian-dc-admin/scripts",
  outExtension: () => ({ js: ".mjs" }),
  format: ["esm"],
  target: "node20",
  platform: "node",
  noExternal: [/.*/],
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
