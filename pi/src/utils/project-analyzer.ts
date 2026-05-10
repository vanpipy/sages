/**
 * Project Analyzer - Deep analysis of project structure and context
 * Used by Fuxi (伏羲) for generating rich MDD drafts
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

export interface ProjectContext {
  projectName: string;
  language: string;
  framework: string | null;
  projectType: "library" | "cli" | "web" | "api" | "mobile" | "desktop" | "monorepo" | "unknown";
  techStack: TechStackInfo;
  structure: ProjectStructure;
  patterns: string[];
  existingComponents: ComponentInfo[];
  keyFiles: KeyFileInfo[];
  dependencies: DependencyInfo[];
}

export interface TechStackInfo {
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  testing: string[];
  linting: string[];
}

export interface ProjectStructure {
  rootDir: string;
  srcDir: string | null;
  testDir: string | null;
  configDir: string | null;
  mainFile: string | null;
  hasPackageJson: boolean;
  hasTsConfig: boolean;
  hasGoMod: boolean;
  hasCargoToml: boolean;
  hasRequirements: boolean;
  directoryTree: DirectoryNode[];
}

export interface DirectoryNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: DirectoryNode[];
}

export interface ComponentInfo {
  name: string;
  path: string;
  type: "component" | "hook" | "utility" | "service" | "model" | "controller" | "handler";
  exports: string[];
  imports: string[];
}

export interface KeyFileInfo {
  path: string;
  purpose: string;
  lines: number;
}

export interface DependencyInfo {
  name: string;
  version: string;
  type: "production" | "development";
}

/**
 * Analyze project at the given directory
 */
export async function analyzeProject(cwd: string, request?: string): Promise<ProjectContext> {
  const packageJson = loadPackageJson(cwd);
  const projectName = packageJson?.name || basename(cwd);
  const language = detectLanguage(cwd, packageJson);
  const framework = detectFramework(packageJson, language, cwd);
  const projectType = detectProjectType(packageJson, framework, request);
  
  const techStack = analyzeTechStack(packageJson, language, cwd);
  const structure = analyzeStructure(cwd);
  const patterns = detectPatterns(cwd, language);
  const components = detectComponents(cwd, language);
  const keyFiles = detectKeyFiles(cwd, structure);
  
  return {
    projectName,
    language,
    framework,
    projectType,
    techStack,
    structure,
    patterns,
    existingComponents: components,
    keyFiles,
    dependencies: extractDependencies(packageJson),
  };
}

/**
 * Load package.json if exists
 */
function loadPackageJson(cwd: string): Record<string, any> | null {
  const packagePath = join(cwd, "package.json");
  if (existsSync(packagePath)) {
    try {
      return JSON.parse(readFileSync(packagePath, "utf-8"));
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Detect primary programming language
 */
function detectLanguage(cwd: string, packageJson: Record<string, any> | null): string {
  // Check package.json
  if (packageJson) {
    if (packageJson.dependencies?.react || packageJson.dependencies?.vue || packageJson.dependencies?.svelte) {
      return "typescript";
    }
    if (packageJson.java || packageJson.artifact) {
      return "java";
    }
  }

  // Check for language-specific config files FIRST (before scanning src/)
  if (existsSync(join(cwd, "go.mod"))) return "go";
  if (existsSync(join(cwd, "Cargo.toml"))) return "rust";
  if (existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "setup.py")) || existsSync(join(cwd, "pyproject.toml"))) return "python";
  if (existsSync(join(cwd, "pom.xml"))) return "java";
  if (existsSync(join(cwd, "composer.json"))) return "php";
  if (existsSync(join(cwd, ".csproj")) || existsSync(join(cwd, "*.sln"))) return "csharp";
  if (existsSync(join(cwd, "Makefile"))) return "c"; // Common for C/C++ projects
  
  // Count file extensions across the entire project (not just src/)
  const extCounts: Record<string, number> = {};
  
  // Scan multiple common directories for different languages
  const dirsToScan = ["src", "lib", "internal", "cmd", "pkg", "internal", "app", "packages"];
  for (const dir of dirsToScan) {
    const dirPath = join(cwd, dir);
    if (existsSync(dirPath)) {
      const files = getAllFiles(dirPath);
      for (const file of files.slice(0, 200)) { // Sample more files
        const ext = extname(file).toLowerCase();
        if (ext && !file.includes("node_modules")) {
          extCounts[ext] = (extCounts[ext] || 0) + 1;
        }
      }
    }
  }
  
  // Also scan root level for Go projects (which often don't have src/)
  if (Object.keys(extCounts).length === 0) {
    try {
      const rootFiles = readdirSync(cwd);
      for (const file of rootFiles) {
        if (file.endsWith(".go") || file.endsWith(".rs") || file.endsWith(".py")) {
          const ext = extname(file).toLowerCase();
          extCounts[ext] = (extCounts[ext] || 0) + 1;
        }
      }
    } catch { /* ignore */ }
  }

  const sorted = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    const topExt = sorted[0][0];
    const extToLang: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".go": "go",
      ".py": "python",
      ".java": "java",
      ".rs": "rust",
      ".rb": "ruby",
      ".php": "php",
      ".cs": "csharp",
      ".cpp": "cpp",
      ".c": "c",
    };
    return extToLang[topExt] || "typescript";
  }

  return "typescript"; // default
}

/**
 * Detect framework from package.json or project files
 */
function detectFramework(packageJson: Record<string, any> | null, language: string, cwd?: string): string | null {
  const projectDir = cwd || ".";

  if (!packageJson && language !== "go") {
    return null;
  }

  const deps = packageJson ? { ...packageJson.dependencies, ...packageJson.devDependencies } : {};

  if (language === "typescript" || language === "javascript") {
    if (deps.react) return "react";
    if (deps.vue) return "vue";
    if (deps.svelte) return "svelte";
    if (deps.angular) return "angular";
    if (deps.next) return "next";
    if (deps.nuxt) return "nuxt";
    if (deps.express || deps.fastify || deps.koa) return "express";
    if (deps.electron) return "electron";
    if (deps["@nestjs/core"]) return "nestjs";
    if (deps["@charmbracelet/bubbletea"]) return "bubbletea";
    if (deps["@charmbracelet/bubbles"]) return "bubbles";
    if (deps.arcade || deps.dgram) return "node";
    return null;
  }

  if (language === "go") {
    // Check go.mod for framework/library hints
    const goModPath = join(projectDir, "go.mod");
    if (existsSync(goModPath)) {
      try {
        const content = readFileSync(goModPath, "utf-8");
        if (content.includes("github.com/charmbracelet/bubbletea")) return "bubbletea";
        if (content.includes("github.com/charmbracelet/bubbles")) return "bubbles";
        if (content.includes("github.com/charmbracelet/lipgloss")) return "lipgloss";
        if (content.includes("github.com/gin-gonic/gin")) return "gin";
        if (content.includes("github.com/gofiber")) return "fiber";
        if (content.includes("github.com/spf13/cobra")) return "cobra";
        if (content.includes("github.com/spf13/viper")) return "viper";
        if (content.includes("github.com/golang")) return "stdlib";
      } catch { /* ignore */ }
    }
    return null;
  }

  if (language === "python") {
    if (deps.django) return "django";
    if (deps.flask) return "flask";
    if (deps.fastapi) return "fastapi";
    if (deps.requests) return "requests";
  }

  return null;
}

/**
 * Detect project type from context
 */
function detectProjectType(
  packageJson: Record<string, any> | null,
  framework: string | null,
  request?: string
): ProjectContext["projectType"] {
  const req = request?.toLowerCase() || "";
  
  // Check request hints
  if (req.includes("cli") || req.includes("command") || req.includes("terminal")) {
    return "cli";
  }
  if (req.includes("api") || req.includes("rest") || req.includes("endpoint")) {
    return "api";
  }
  if (req.includes("web") || req.includes("frontend") || req.includes("ui")) {
    return "web";
  }
  if (req.includes("mobile")) {
    return "mobile";
  }

  // Check framework hints
  if (framework) {
    switch (framework) {
      case "express":
      case "fastify":
      case "koa":
      case "nestjs":
      case "gin":
      case "fiber":
      case "django":
      case "flask":
      case "fastapi":
        return "api";
      case "react":
      case "vue":
      case "svelte":
      case "angular":
      case "next":
      case "nuxt":
        return "web";
      case "electron":
        return "desktop";
      case "bubbletea":
      case "bubbles":
        return "cli";
    }
  }

  // Check package.json for hints
  if (packageJson) {
    const scripts = packageJson.scripts || {};
    if (scripts.build && scripts.dev) return "web";
    if (scripts.start && !scripts.dev) return "api";
    if (scripts.test) return "library";
  }

  return "unknown";
}

/**
 * Analyze tech stack from package.json or go.mod
 */
function analyzeTechStack(packageJson: Record<string, any> | null, language?: string, cwd?: string): TechStackInfo {
  const result: TechStackInfo = {
    languages: [],
    frameworks: [],
    buildTools: [],
    testing: [],
    linting: [],
  };

  // For Go projects, analyze go.mod
  if (language === "go") {
    const goModPath = join(cwd || ".", "go.mod");
    if (existsSync(goModPath)) {
      try {
        const content = readFileSync(goModPath, "utf-8");
        // Extract Go version
        const goVersion = content.match(/^go\s+(\d+\.\d+)/m);
        if (goVersion) {
          result.languages.push(`Go ${goVersion[1]}`);
        }
        
        // Detect frameworks/libraries from imports
        const frameworks = [];
        if (content.includes("github.com/charmbracelet/bubbletea")) {
          frameworks.push("bubbletea");
        }
        if (content.includes("github.com/charmbracelet/bubbles")) {
          frameworks.push("bubbles");
        }
        if (content.includes("github.com/charmbracelet/lipgloss")) {
          frameworks.push("lipgloss");
        }
        if (content.includes("github.com/spf13/cobra")) {
          frameworks.push("cobra");
        }
        if (content.includes("github.com/spf13/viper")) {
          frameworks.push("viper");
        }
        if (content.includes("github.com/gomodule/redigo")) {
          result.testing.push("redigo");
        }
        result.frameworks = frameworks;
        result.buildTools.push("go build");
        result.buildTools.push("go mod");
      } catch { /* ignore */ }
    }
    return result;
  }

  if (!packageJson) return result;

  const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };

  // Languages (implied by tools used)
  if (allDeps.typescript || allDeps["@types/node"]) result.languages.push("TypeScript");
  if (allDeps.babel || allDeps["@babel/core"]) result.languages.push("JavaScript (ES6+)");
  
  // Frameworks
  const frameworkKeys = [
    "react", "vue", "svelte", "angular", "next", "nuxt",
    "express", "fastify", "koa", "@nestjs/core",
    "gin", "gofiber",
    "django", "flask", "fastapi",
  ];
  for (const key of frameworkKeys) {
    if (allDeps[key]) {
      result.frameworks.push(key.replace("@", "").replace("core", ""));
    }
  }

  // Build tools
  const buildKeys = ["webpack", "vite", "esbuild", "rollup", "parcel", "tsc", "swc"];
  for (const key of buildKeys) {
    if (allDeps[key]) result.buildTools.push(key);
  }

  // Testing
  const testKeys = ["jest", "vitest", "mocha", "tap", "ava", "pytest", "unittest", "testing-library"];
  for (const key of testKeys) {
    if (allDeps[key]) result.testing.push(key);
  }

  // Linting
  const lintKeys = ["eslint", "prettier", "stylelint", "ruff", "pylint"];
  for (const key of lintKeys) {
    if (allDeps[key]) result.linting.push(key);
  }

  return result;
}

/**
 * Analyze project directory structure
 */
function analyzeStructure(cwd: string): ProjectStructure {
  const srcDir = existsSync(join(cwd, "src")) ? "src" 
    : existsSync(join(cwd, "lib")) ? "lib"
    : existsSync(join(cwd, "internal")) ? "internal"
    : null;

  const testDir = existsSync(join(cwd, "test")) ? "test"
    : existsSync(join(cwd, "tests")) ? "tests"
    : existsSync(join(cwd, "__tests__")) ? "__tests__"
    : existsSync(join(cwd, "test")) ? join(srcDir || ".", "test")
    : null;

  const configDir = existsSync(join(cwd, "config")) ? "config"
    : existsSync(join(cwd, "configs")) ? "configs"
    : existsSync(join(cwd, ".config")) ? ".config"
    : null;

  // Find main entry file
  const mainFiles = ["index.ts", "main.ts", "index.tsx", "App.tsx", "main.go", "main.py", "main.rs"];
  let mainFile: string | null = null;
  for (const mf of mainFiles) {
    if (existsSync(join(cwd, mf))) {
      mainFile = mf;
      break;
    }
    if (srcDir && existsSync(join(cwd, srcDir, mf))) {
      mainFile = join(srcDir, mf);
      break;
    }
  }

  return {
    rootDir: cwd,
    srcDir,
    testDir,
    configDir,
    mainFile,
    hasPackageJson: existsSync(join(cwd, "package.json")),
    hasTsConfig: existsSync(join(cwd, "tsconfig.json")),
    hasGoMod: existsSync(join(cwd, "go.mod")),
    hasCargoToml: existsSync(join(cwd, "Cargo.toml")),
    hasRequirements: existsSync(join(cwd, "requirements.txt")),
    directoryTree: buildDirectoryTree(cwd, 3),
  };
}

/**
 * Build directory tree up to maxDepth
 */
function buildDirectoryTree(dir: string, maxDepth: number, currentDepth = 0): DirectoryNode[] {
  if (currentDepth >= maxDepth) return [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith(".") && !e.name.startsWith("node_modules"))
      .slice(0, 20) // Limit entries per level
      .map(entry => {
        const fullPath = join(dir, entry.name);
        const node: DirectoryNode = {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? "directory" : "file",
        };
        if (entry.isDirectory()) {
          node.children = buildDirectoryTree(fullPath, maxDepth, currentDepth + 1);
        }
        return node;
      });
  } catch {
    return [];
  }
}

/**
 * Detect coding patterns from source files
 */
function detectPatterns(cwd: string, language: string): string[] {
  const patterns: string[] = [];
  const srcDir = join(cwd, "src");

  if (!existsSync(srcDir)) return patterns;

  // Read sample files to detect patterns
  const sampleFiles = getAllFiles(srcDir).slice(0, 20);

  for (const file of sampleFiles) {
    const content = readFileSync(file, "utf-8");
    const fileName = basename(file).toLowerCase();

    // TypeScript/React patterns
    if (language === "typescript") {
      if (content.includes("useState") || content.includes("useEffect")) {
        patterns.push("React Hooks");
      }
      if (content.includes("interface ") && content.includes("extends ")) {
        patterns.push("Interface Inheritance");
      }
      if (content.includes("type ") && content.includes("=") && content.includes("|")) {
        patterns.push("Union Types");
      }
      if (content.includes("async") && content.includes("await")) {
        patterns.push("Async/Await");
      }
      if (content.includes("export const") && content.includes("=>")) {
        patterns.push("Arrow Functions");
      }
      if (content.includes("@Component") || content.includes("@Injectable")) {
        patterns.push("Decorator Pattern");
      }
      if (fileName.includes("test") || fileName.includes("spec")) {
        patterns.push("Unit Testing");
      }
    }

    // Go patterns
    if (language === "go") {
      if (content.includes("func ") && content.includes("error") && content.includes("return")) {
        patterns.push("Error Handling");
      }
      if (content.includes("goroutine") || content.includes("go ") && content.includes("func")) {
        patterns.push("Concurrency (Goroutines)");
      }
      if (content.includes("chan ")) {
        patterns.push("Channels");
      }
      if (content.includes("interface {") && content.includes("}")) {
        patterns.push("Interface Types");
      }
      if (content.includes("struct {") && content.includes("}")) {
        patterns.push("Struct Types");
      }
    }

    // General patterns
    if (content.includes("TODO") || content.includes("FIXME")) {
      patterns.push("Code Comments");
    }
    if (content.includes("console.log") || content.includes("fmt.Println")) {
      patterns.push("Debug Logging");
    }
    if (content.includes("try") && content.includes("catch")) {
      patterns.push("Exception Handling");
    }
  }

  return [...new Set(patterns)]; // Deduplicate
}

/**
 * Detect existing components from source
 */
function detectComponents(cwd: string, language: string): ComponentInfo[] {
  const components: ComponentInfo[] = [];
  const srcDir = join(cwd, "src");

  if (!existsSync(srcDir)) return components;

  const sourceFiles = getAllFiles(srcDir).filter(f => 
    !f.includes("node_modules") && 
    !f.includes(".test.") &&
    !f.includes(".spec.")
  ).slice(0, 50); // Limit to 50 files

  for (const file of sourceFiles) {
    const fileName = basename(file);
    const content = readFileSync(file, "utf-8");
    
    // Extract exports
    const exportMatches = content.match(/export\s+(?:const|function|class|type|interface)\s+(\w+)/g) || [];
    const exports = exportMatches.map(m => m.replace("export ", "").replace(/(const|function|class|type|interface)\s+/, ""));

    // Extract imports
    const importMatches = content.match(/import\s+.+\s+from\s+['"](.+)['"]/g) || [];
    const imports = importMatches.map(m => {
      const match = m.match(/from\s+['"](.+)['"]/);
      return match ? match[1] : "";
    }).filter(Boolean);

    // Determine component type
    let type: ComponentInfo["type"] = "component";
    if (fileName.includes("hook") || fileName.includes("use")) type = "hook";
    else if (fileName.includes("util") || fileName.includes("helper")) type = "utility";
    else if (fileName.includes("service") || fileName.includes("api")) type = "service";
    else if (fileName.includes("model") || fileName.includes("schema")) type = "model";
    else if (fileName.includes("controller")) type = "controller";
    else if (fileName.includes("handler")) type = "handler";

    if (exports.length > 0) {
      components.push({
        name: exports[0],
        path: file,
        type,
        exports,
        imports,
      });
    }
  }

  return components;
}

/**
 * Detect key configuration files
 */
function detectKeyFiles(cwd: string, structure: ProjectStructure): KeyFileInfo[] {
  const keyFiles: KeyFileInfo[] = [];

  const configFilePatterns = [
    { pattern: "tsconfig.json", purpose: "TypeScript configuration" },
    { pattern: "package.json", purpose: "Node.js dependencies and scripts" },
    { pattern: ".eslintrc*", purpose: "ESLint linting rules" },
    { pattern: ".prettierrc*", purpose: "Prettier code formatting" },
    { pattern: "go.mod", purpose: "Go module dependencies" },
    { pattern: "go.sum", purpose: "Go module checksums" },
    { pattern: "Cargo.toml", purpose: "Rust crate dependencies" },
    { pattern: "requirements.txt", purpose: "Python dependencies" },
    { pattern: ".github/workflows/*.yml", purpose: "CI/CD workflows" },
    { pattern: "docker-compose.yml", purpose: "Docker container orchestration" },
    { pattern: "Dockerfile", purpose: "Container image definition" },
  ];

  for (const { pattern, purpose } of configFilePatterns) {
    const matches = findFilesMatching(cwd, pattern);
    for (const match of matches) {
      if (existsSync(match)) {
        try {
          const stats = statSync(match);
          keyFiles.push({
            path: match,
            purpose,
            lines: stats.size / 100, // Approximate
          });
        } catch { /* ignore */ }
      }
    }
  }

  return keyFiles;
}

/**
 * Extract dependencies from package.json
 */
function extractDependencies(packageJson: Record<string, any> | null): DependencyInfo[] {
  if (!packageJson) return [];

  const deps: DependencyInfo[] = [];

  for (const [name, version] of Object.entries(packageJson.dependencies || {})) {
    deps.push({ name, version: String(version), type: "production" });
  }

  for (const [name, version] of Object.entries(packageJson.devDependencies || {})) {
    deps.push({ name, version: String(version), type: "development" });
  }

  return deps.sort((a, b) => {
    if (a.type !== b.type) return a.type === "production" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Get all files in directory recursively
 */
function getAllFiles(dir: string, files: string[] = []): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        getAllFiles(fullPath, files);
      } else {
        files.push(fullPath);
      }
    }
  } catch { /* ignore */ }
  return files;
}

/**
 * Find files matching a glob pattern
 */
function findFilesMatching(dir: string, pattern: string): string[] {
  const results: string[] = [];
  
  // Handle simple patterns
  if (!pattern.includes("*")) {
    results.push(join(dir, pattern));
    return results;
  }

  // Handle directory patterns like .github/workflows/*.yml
  const parts = pattern.split("/");
  let currentDir = dir;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "*") {
      try {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            results.push(...findFilesMatching(join(currentDir, entry.name), parts.slice(i + 1).join("/")));
          }
        }
      } catch { /* ignore */ }
      return results;
    } else {
      currentDir = join(currentDir, part);
    }
  }

  if (existsSync(currentDir)) {
    results.push(currentDir);
  }

  return results;
}

/**
 * Get directory name helper
 */
function dirname(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || ".";
}