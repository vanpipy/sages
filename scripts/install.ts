/**
 * Install script for Four Sages Agents plugin
 *
 * 1. Copy src/agents/* to "$HOME/.config/opencode/agent"
 * 2. Run scripts/build-self-contained-tools.ts and copy tool/* to "$HOME/.config/opencode/tool"
 */

import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const AGENTS_SRC = join(PROJECT_ROOT, "src", "agents");
const AGENTS_DEST = join(process.env.HOME!, ".config", "opencode", "agent");

const BUILD_TOOLS_SCRIPT = join(PROJECT_ROOT, "scripts", "build-self-contained-tools.ts");
const TOOLS_DEST = join(process.env.HOME!, ".config", "opencode", "tool");

console.log("Installing Four Sages Agents plugin...\n");

// 1. Copy agents to ~/.config/opencode/agent
console.log("1/2: Copying agents...");
mkdirSync(AGENTS_DEST, { recursive: true });
if (existsSync(AGENTS_SRC)) {
  cpSync(AGENTS_SRC, AGENTS_DEST, { recursive: true });
  console.log(`   ✓ Copied agents to ${AGENTS_DEST}`);
} else {
  console.error(`   ✗ Source agents not found: ${AGENTS_SRC}`);
  process.exit(1);
}

// 2. Build tools and copy to ~/.config/opencode/tool
console.log("\n2/2: Building and copying tools...");
console.log(`   Running: bun ${BUILD_TOOLS_SCRIPT}`);
execSync(`bun "${BUILD_TOOLS_SCRIPT}"`, { cwd: PROJECT_ROOT });

mkdirSync(TOOLS_DEST, { recursive: true });
const TOOLS_SRC = join(PROJECT_ROOT, "tool");
if (existsSync(TOOLS_SRC)) {
  cpSync(TOOLS_SRC, TOOLS_DEST, { recursive: true });
  console.log(`   ✓ Copied tools to ${TOOLS_DEST}`);
} else {
  console.error(`   ✗ Built tools not found: ${TOOLS_SRC}`);
  process.exit(1);
}

console.log("\n✓ Four Sages Agents installed successfully!");
console.log(`\nAgents: ${AGENTS_DEST}`);
console.log(`Tools:  ${TOOLS_DEST}`);