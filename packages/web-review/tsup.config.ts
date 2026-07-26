import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "next/index": "src/next/index.ts",
    "server/index": "src/server/index.ts",
    "drizzle/index": "src/drizzle/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Each entry is bundled independently (no shared chunks). esbuild
  // preserves the "use client" directive prologue as the first statement
  // of a bundled entry, but splitting can hoist shared code above an
  // entry's own directive when multiple entries are code-split together.
  // Disabling splitting keeps every entry self-contained so the directive
  // is guaranteed to stay the first line of the client entries (index,
  // next/index), while it never appears in the server/drizzle entries
  // because those source files never contain it.
  splitting: false,
  external: ["react", "react-dom", "next", "drizzle-orm", "@zumer/snapdom"],
  outDir: "dist",
  async onSuccess() {
    copyFileSync("src/styles.css", "dist/styles.css");
  },
});
