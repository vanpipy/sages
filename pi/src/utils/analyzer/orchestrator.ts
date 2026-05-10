/**
 * Project Analyzer Orchestrator
 * 
 * Composes all language detectors and provides unified project analysis API.
 * Follows composition pattern for extensibility as new languages are added.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

// Import all language detectors
import { GoDetector } from "./go-detector";
import { TypeScriptDetector } from "./typescript-detector";
import { PythonDetector } from "./python-detector";
import { JavaDetector } from "./java-detector";

// Import types
import type {
  LanguageDetector,
  LanguageInfo,
  ProjectContext,
  TechStackInfo,
  ProjectStructure,
  DirectoryNode,
  KeyFileInfo,
  DependencyInfo,
} from "./base";

// ============================================================================
// Analyzer Configuration
// ============================================================================

interface AnalyzerConfig {
  maxFiles?: number;
  maxDepth?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
}

const DEFAULT_CONFIG: AnalyzerConfig = {
  maxFiles: 200,
  maxDepth: 3,
  includePatterns: ["*.go", "*.ts", "*.tsx", "*.js", "*.jsx", "*.py", "*.java"],
  excludePatterns: ["node_modules", ".git", "dist", "build", "__pycache__"],
};

// ============================================================================
// Project Analyzer Class
// ============================================================================

export class ProjectAnalyzer {
  private detectors: LanguageDetector[];
  private config: AnalyzerConfig;
  
  constructor(config?: AnalyzerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.detectors = [
      new GoDetector(),
      new TypeScriptDetector(),
      new PythonDetector(),
      new JavaDetector(),
    ];
  }
  
  /**
   * Get all registered detectors
   */
  getDetectors(): LanguageDetector[] {
    return [...this.detectors];
  }
  
  /**
   * Detect the primary language and return LanguageInfo
   */
  async detectLanguage(cwd: string): Promise<LanguageInfo | null> {
    let bestResult: LanguageInfo | null = null;
    let bestConfidence = 0;
    
    for (const detector of this.detectors) {
      if (detector.canHandle(cwd)) {
        const result = await detector.detect(cwd);
        if (result && result.confidence > bestConfidence) {
          bestResult = result;
          bestConfidence = result.confidence;
        }
      }
    }
    
    return bestResult;
  }
  
  /**
   * Detect project type based on language, framework, and request
   */
  detectProjectType(
    language: string,
    framework: string | null,
    request?: string
  ): string {
    // Framework-based detection
    if (framework) {
      switch (framework) {
        case "react":
        case "vue":
        case "svelte":
        case "next":
        case "nuxt":
          return "web";
        case "express":
        case "fastify":
        case "koa":
        case "gin":
        case "fiber":
        case "fastapi":
          return "api";
        case "electron":
          return "desktop";
        case "react-native":
        case "flutter":
          return "mobile";
        case "bubbletea":
        case "bubbles":
        case "cobra":
          return "cli";
        case "django":
        case "flask":
        case "spring-boot":
          return "web";
      }
    }
    
    // Language-based detection
    switch (language) {
      case "typescript":
      case "javascript":
        if (request) {
          if (/api|rest|endpoint|server/i.test(request)) return "api";
          if (/web|app|page|ui|frontend/i.test(request)) return "web";
          if (/cli|command|tool/i.test(request)) return "cli";
        }
        return "library";
      case "go":
        if (request) {
          if (/api|service|endpoint/i.test(request)) return "api";
          if (/cli|command/i.test(request)) return "cli";
        }
        return "cli";
      case "python":
        if (request) {
          if (/api|service/i.test(request)) return "api";
          if (/scraper|crawler/i.test(request)) return "script";
        }
        return "script";
      case "java":
        if (framework?.includes("spring")) return "web";
        return "backend";
      default:
        return "unknown";
    }
  }
  
  /**
   * Full project analysis - returns comprehensive ProjectContext
   */
  async analyze(cwd: string, request?: string): Promise<ProjectContext> {
    // 1. Detect language and frameworks
    const languageInfo = await this.detectLanguage(cwd);
    
    const projectName = basename(cwd);
    const language = languageInfo?.language || "unknown";
    
    // Filter out version strings from frameworks (e.g., "Go 1.21")
    const frameworks = (languageInfo?.frameworks || []).filter(f => 
      !f.match(/^(Go|Java|Python|TypeScript)\s+\d/)
    );
    const patterns = languageInfo?.patterns || [];
    const existingComponents = languageInfo?.components || [];
    
    // 2. Detect primary framework (first non-version framework)
    const framework = frameworks.length > 0 ? frameworks[0] : null;
    
    // 3. Detect project type
    const projectType = this.detectProjectType(language, framework, request);
    
    // 4. Analyze tech stack
    const techStack = this.analyzeTechStack(cwd, language, frameworks);
    
    // 5. Analyze project structure
    const structure = this.analyzeStructure(cwd, language);
    
    // 6. Detect key files
    const keyFiles = this.detectKeyFiles(cwd, structure);
    
    // 7. Extract dependencies
    const dependencies = this.extractDependencies(cwd, language);
    
    return {
      projectName,
      language,
      framework,
      projectType,
      techStack,
      structure,
      patterns,
      existingComponents,
      keyFiles,
      dependencies,
    };
  }
  
  // ========================================================================
  // Private Analysis Methods
  // ========================================================================
  
  private analyzeTechStack(cwd: string, language: string, frameworks: string[]): TechStackInfo {
    const techStack: TechStackInfo = {
      languages: [],
      frameworks: [],
      buildTools: [],
      testing: [],
      linting: [],
    };
    
    // Add detected frameworks
    techStack.frameworks = [...frameworks];
    
    // Language-specific detection
    switch (language) {
      case "go":
        this.analyzeGoTechStack(cwd, techStack);
        // Add Go version to languages if not already there
        if (!techStack.languages.some(l => l.startsWith("Go ")) && languageInfo) {
          const goVersion = languageInfo.frameworks.find(f => f.match(/^Go\s+\d/));
          if (goVersion) techStack.languages.push(goVersion);
        }
        break;
      case "typescript":
      case "javascript":
        this.analyzeNpmTechStack(cwd, techStack);
        break;
      case "python":
        this.analyzePythonTechStack(cwd, techStack);
        break;
      case "java":
        this.analyzeJavaTechStack(cwd, techStack);
        break;
    }
    
    return techStack;
  }
  
  private analyzeGoTechStack(cwd: string, techStack: TechStackInfo): void {
    const goModPath = join(cwd, "go.mod");
    if (existsSync(goModPath)) {
      try {
        const content = readFileSync(goModPath, "utf-8");
        
        // Go version
        const goVersion = content.match(/^go\s+(\d+\.\d+)/m);
        if (goVersion) {
          techStack.languages.push(`Go ${goVersion[1]}`);
        }
        
        // Build tools
        techStack.buildTools.push("go build", "go mod");
        
        // Frameworks already added from detector
      } catch { /* ignore */ }
    }
  }
  
  private analyzeNpmTechStack(cwd: string, techStack: TechStackInfo): void {
    const packageJsonPath = join(cwd, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const content = readFileSync(packageJsonPath, "utf-8");
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        
        // TypeScript
        if (deps.typescript) {
          techStack.languages.push("TypeScript");
        }
        
        // Testing
        const testFrameworks = ["vitest", "jest", "mocha", "tap", "ava"];
        for (const tf of testFrameworks) {
          if (deps[tf]) techStack.testing.push(tf);
        }
        
        // Linting
        if (deps.eslint) techStack.linting.push("eslint");
        if (deps.prettier) techStack.linting.push("prettier");
        
        // Build tools
        if (deps.vite) techStack.buildTools.push("vite");
        if (deps.webpack) techStack.buildTools.push("webpack");
      } catch { /* ignore */ }
    }
  }
  
  private analyzePythonTechStack(cwd: string, techStack: TechStackInfo): void {
    const requirementsPath = join(cwd, "requirements.txt");
    if (existsSync(requirementsPath)) {
      try {
        const content = readFileSync(requirementsPath, "utf-8");
        const lines = content.split("\n");
        
        for (const line of lines) {
          const trimmed = line.split(/[=<>!]/)[0].trim();
          
          if (trimmed === "pytest") techStack.testing.push("pytest");
          if (trimmed === "black") techStack.linting.push("black");
          if (trimmed === "ruff") techStack.linting.push("ruff");
          if (trimmed === "mypy") techStack.linting.push("mypy");
        }
      } catch { /* ignore */ }
    }
    
    techStack.languages.push("Python");
  }
  
  private analyzeJavaTechStack(cwd: string, techStack: TechStackInfo): void {
    const pomPath = join(cwd, "pom.xml");
    if (existsSync(pomPath)) {
      try {
        const content = readFileSync(pomPath, "utf-8");
        
        // Java version
        const javaVersion = content.match(/<java\.version>([^<]+)<\/java\.version>/);
        if (javaVersion) {
          techStack.languages.push(`Java ${javaVersion[1]}`);
        }
        
        // Build tools
        techStack.buildTools.push("maven");
      } catch { /* ignore */ }
    }
    
    const gradlePath = join(cwd, "build.gradle");
    if (existsSync(gradlePath)) {
      techStack.buildTools.push("gradle");
    }
  }
  
  private analyzeStructure(cwd: string, language: string): ProjectStructure {
    const srcDir = this.detectSourceDir(cwd, language);
    const testDir = this.detectTestDir(cwd, language);
    const configDir = this.detectConfigDir(cwd);
    
    // Check for language-specific config files
    const hasPackageJson = existsSync(join(cwd, "package.json"));
    const hasTsConfig = existsSync(join(cwd, "tsconfig.json"));
    const hasGoMod = existsSync(join(cwd, "go.mod"));
    const hasCargoToml = existsSync(join(cwd, "Cargo.toml"));
    const hasRequirements = existsSync(join(cwd, "requirements.txt"));
    
    // Build directory tree
    const directoryTree = this.buildDirectoryTree(cwd, this.config.maxDepth || 3);
    
    return {
      rootDir: cwd,
      srcDir,
      testDir,
      configDir,
      mainFile: this.detectMainFile(cwd, language),
      hasPackageJson,
      hasTsConfig,
      hasGoMod,
      hasCargoToml,
      hasRequirements,
      directoryTree,
    };
  }
  
  private detectSourceDir(cwd: string, language: string): string | null {
    const candidates: Record<string, string[]> = {
      go: ["src", "cmd", "internal", "pkg", "lib"],
      typescript: ["src", "lib", "app", "packages"],
      javascript: ["src", "lib", "app"],
      python: ["src", "lib", "app"],
      java: ["src/main/java", "src", "java"],
    };
    
    const dirs = candidates[language] || ["src"];
    for (const dir of dirs) {
      if (existsSync(join(cwd, dir))) {
        return dir;
      }
    }
    
    return null;
  }
  
  private detectTestDir(cwd: string, language: string): string | null {
    const candidates: Record<string, string[]> = {
      go: ["test", "tests", "_test"],
      typescript: ["test", "tests", "__tests__"],
      javascript: ["test", "tests"],
      python: ["test", "tests", "tests"],
      java: ["src/test/java", "test", "tests"],
    };
    
    const dirs = candidates[language] || ["test"];
    for (const dir of dirs) {
      if (existsSync(join(cwd, dir))) {
        return dir;
      }
    }
    
    return null;
  }
  
  private detectConfigDir(cwd: string): string | null {
    const candidates = ["config", "conf", "configs", ".config"];
    for (const dir of candidates) {
      if (existsSync(join(cwd, dir))) {
        return dir;
      }
    }
    return null;
  }
  
  private detectMainFile(cwd: string, language: string): string | null {
    const candidates: Record<string, string[]> = {
      go: ["main.go", "cmd/main.go"],
      typescript: ["src/index.ts", "src/main.ts", "index.ts"],
      javascript: ["src/index.js", "index.js", "main.js"],
      python: ["main.py", "app.py", "__main__.py"],
      java: ["src/main/java/Main.java", "src/Main.java"],
    };
    
    const files = candidates[language] || [];
    for (const file of files) {
      if (existsSync(join(cwd, file))) {
        return file;
      }
    }
    
    return null;
  }
  
  private buildDirectoryTree(dir: string, maxDepth: number, currentDepth = 0): DirectoryNode[] {
    if (currentDepth >= maxDepth) return [];
    
    try {
      const entries = readdirSync(dir);
      const nodes: DirectoryNode[] = [];
      
      for (const entry of entries) {
        // Skip excluded patterns
        if (this.config.excludePatterns?.some(p => entry.includes(p))) {
          continue;
        }
        
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          const node: DirectoryNode = {
            name: entry,
            path: fullPath,
            type: stat.isDirectory() ? "directory" : "file",
          };
          
          if (stat.isDirectory()) {
            node.children = this.buildDirectoryTree(fullPath, maxDepth, currentDepth + 1);
          }
          
          nodes.push(node);
        } catch { /* skip */ }
      }
      
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return [];
    }
  }
  
  private detectKeyFiles(cwd: string, structure: ProjectStructure): KeyFileInfo[] {
    const keyFiles: KeyFileInfo[] = [];
    
    // Common key files to look for
    const keyFilePatterns: Array<{ pattern: string; purpose: string }> = [
      { pattern: "go.mod", purpose: "Go module dependencies" },
      { pattern: "go.sum", purpose: "Go module checksums" },
      { pattern: "package.json", purpose: "npm package configuration" },
      { pattern: "tsconfig.json", purpose: "TypeScript configuration" },
      { pattern: "requirements.txt", purpose: "Python dependencies" },
      { pattern: "setup.py", purpose: "Python package configuration" },
      { pattern: "pyproject.toml", purpose: "Python project configuration" },
      { pattern: "pom.xml", purpose: "Maven build configuration" },
      { pattern: "build.gradle", purpose: "Gradle build configuration" },
      { pattern: "README.md", purpose: "Project documentation" },
      { pattern: "LICENSE", purpose: "License information" },
    ];
    
    for (const { pattern, purpose } of keyFilePatterns) {
      const path = join(cwd, pattern);
      if (existsSync(path)) {
        try {
          const stat = statSync(path);
          const lines = stat.isFile() ? this.countLines(path) : 0;
          keyFiles.push({ path, purpose, lines });
        } catch { /* skip */ }
      }
    }
    
    return keyFiles;
  }
  
  private countLines(filePath: string): number {
    try {
      const content = readFileSync(filePath, "utf-8");
      return content.split("\n").length;
    } catch {
      return 0;
    }
  }
  
  private extractDependencies(cwd: string, language: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    
    switch (language) {
      case "go":
        this.extractGoDependencies(cwd, deps);
        break;
      case "typescript":
      case "javascript":
        this.extractNpmDependencies(cwd, deps);
        break;
      case "python":
        this.extractPythonDependencies(cwd, deps);
        break;
      case "java":
        this.extractMavenDependencies(cwd, deps);
        break;
    }
    
    return deps;
  }
  
  private extractGoDependencies(cwd: string, deps: DependencyInfo[]): void {
    const goModPath = join(cwd, "go.mod");
    if (!existsSync(goModPath)) return;
    
    try {
      const content = readFileSync(goModPath, "utf-8");
      const inRequire = content.includes("require (");
      
      // Simple regex to extract module paths
      const moduleRegex = /\t(\S+)\s+(v?\d+\.\d+[.\d]*)/g;
      let match;
      
      while ((match = moduleRegex.exec(content)) !== null) {
        deps.push({
          name: match[1],
          version: match[2],
          type: "production",
        });
      }
    } catch { /* ignore */ }
  }
  
  private extractNpmDependencies(cwd: string, deps: DependencyInfo[]): void {
    const packageJsonPath = join(cwd, "package.json");
    if (!existsSync(packageJsonPath)) return;
    
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      
      for (const [name, version] of Object.entries(pkg.dependencies || {})) {
        deps.push({
          name,
          version: String(version),
          type: "production",
        });
      }
      
      for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
        deps.push({
          name,
          version: String(version),
          type: "development",
        });
      }
    } catch { /* ignore */ }
  }
  
  private extractPythonDependencies(cwd: string, deps: DependencyInfo[]): void {
    const requirementsPath = join(cwd, "requirements.txt");
    if (!existsSync(requirementsPath)) return;
    
    try {
      const content = readFileSync(requirementsPath, "utf-8");
      const lines = content.split("\n");
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        
        const match = trimmed.match(/^([^=<>!]+)([=<>!].+)?$/);
        if (match) {
          deps.push({
            name: match[1],
            version: match[2] || "latest",
            type: "production",
          });
        }
      }
    } catch { /* ignore */ }
  }
  
  private extractMavenDependencies(cwd: string, deps: DependencyInfo[]): void {
    // Simplified Maven dependency extraction
    const pomPath = join(cwd, "pom.xml");
    if (!existsSync(pomPath)) return;
    
    try {
      const content = readFileSync(pomPath, "utf-8");
      
      // Extract dependencies (simplified)
      const depRegex = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>\s*<version>([^<]+)<\/version>/g;
      let match;
      
      while ((match = depRegex.exec(content)) !== null) {
        deps.push({
          name: `${match[1]}:${match[2]}`,
          version: match[3],
          type: "production",
        });
      }
    } catch { /* ignore */ }
  }
}

// ============================================================================
// Backward Compatibility Alias
// ============================================================================

export const analyzeProject = async (cwd: string, request?: string): Promise<ProjectContext> => {
  const analyzer = new ProjectAnalyzer();
  return analyzer.analyze(cwd, request);
};

// ============================================================================
// Export for convenience
// ============================================================================

export default new ProjectAnalyzer();