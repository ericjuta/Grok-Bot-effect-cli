import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(repoRoot, "dist/cli/grok-bot.mjs");

await mkdir(path.dirname(outfile), { recursive: true });
await build({
  absWorkingDir: repoRoot,
  entryPoints: ["source/cli/main.ts"],
  outfile,
  bundle: true,
  // Keep npm packages as runtime dependencies. Bundling platform-node pulls
  // undici's CommonJS dynamic requires into ESM, which Node correctly supports
  // when left at the package boundary but esbuild cannot rewrite safely.
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: true,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});
await chmod(outfile, 0o755);

const result = await stat(outfile);
process.stdout.write(`${path.relative(repoRoot, outfile)} (${result.size} bytes)\n`);
