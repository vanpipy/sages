/**
 * Build Self-Contained Tools Script
 *
 * Uses esbuild to bundle each tool file into a self-contained module in tool/
 * that can be deployed to ~/.config/opencode/tool/sages/
 *
 * External imports (@opencode-ai/plugin, zod) are kept as-is (external)
 * Internal imports are bundled inline
 */

import * as esbuild from "esbuild";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_TOOLS = join(ROOT, "src", "tools");
const OUTPUT_DIR = join(ROOT, "tool");

// Packages that are external (provided by OpenCode runtime)
const EXTERNAL_PACKAGES = [
  "@opencode-ai/plugin",
  "@opencode-ai/sdk",
  "zod",
];

/**
 * Bundle a single file with esbuild
 */
async function bundleFile(inputPath: string, outputPath: string): Promise<void> {
  const relPath = relative(ROOT, inputPath);
  console.log(`Bundling: ${relPath}`);

  try {
    await esbuild.build({
      entryPoints: [inputPath],
      outfile: outputPath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "es2022",
      sourcemap: false,
      minify: false,
      logLevel: "warning",
      external: EXTERNAL_PACKAGES,
      // Don't inject process.env or other Node.js globals
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      // Keep import statements for external modules
      banner: {
        js: `/**
 * Self-contained Sages Tool
 * Generated from: ${relPath}
 * Date: ${new Date().toISOString()}
 *
 * NOTE: External dependencies (@opencode-ai/plugin, zod) are resolved at runtime.
 */`,
      },
    });
    console.log(`  -> ${relative(ROOT, outputPath)}`);
  } catch (err) {
    console.error(`  ERROR: ${err}`);
    throw err;
  }
}

/**
 * Main build function
 */
async function build() {
  console.log("Building self-contained Sages tools with esbuild...\n");
  console.log(`Root: ${ROOT}`);
  console.log(`Source: ${SRC_TOOLS}`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  // Create output directory
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Tool files to bundle
  const toolFiles = [
    { input: "fuxi-tools.ts", output: "fuxi-tools.js" },
    { input: "qiaochui-tools.ts", output: "qiaochui-tools.js" },
    { input: "luban-tools.ts", output: "luban-tools.js" },
    { input: "gaoyao-tools.ts", output: "gaoyao-tools.js" },
    { input: "workflow-tools.ts", output: "workflow-tools.js" },
  ];

  // Bundle each tool
  for (const { input, output } of toolFiles) {
    const srcPath = join(SRC_TOOLS, input);
    if (!existsSync(srcPath)) {
      console.log(`Skipping ${input} (not found)`);
      continue;
    }
    await bundleFile(srcPath, join(OUTPUT_DIR, output));
  }

  // Create an index.js that re-exports all tools
  const indexContent = `/**
 * Sages Tools Index
 * Re-exports all self-contained tools
 */

export * from "./fuxi-tools.js";
export * from "./qiaochui-tools.js";
export * from "./luban-tools.js";
export * from "./gaoyao-tools.js";
export * from "./workflow-tools.js";
`;

  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(OUTPUT_DIR, "index.js"), indexContent);
  console.log(`  -> ${relative(ROOT, join(OUTPUT_DIR, "index.js"))}`);

  console.log("\nBuild complete!");
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
