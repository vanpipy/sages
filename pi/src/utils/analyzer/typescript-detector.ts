/**
 * TypeScript/JavaScript Language Detector
 * 
 * Detects TypeScript and JavaScript projects by:
 * 1. Looking for package.json
 * 2. Checking tsconfig.json
 * 3. Scanning .ts/.js files
 * 4. Parsing dependencies for framework detection
 * 
 * Supported Frameworks: React, Vue, Svelte, Angular, Next.js, NestJS, Express, etc.
 */

import { 
  BaseDetector, 
  LanguageInfo, 
  calculateConfidence 
} from "./base";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// ============================================================================
// TypeScript-Specific Patterns
// ============================================================================

const TS_PATTERNS = {
  ASYNC_AWAIT: "ts-async-await",
  GENERICS: "ts-generics",
  INTERFACES: "ts-interfaces",
  DECORATORS: "ts-decorators",
  TYPE_GUARDS: "ts-type-guards",
  UNION_TYPES: "ts-union-types",
  OPTIONAL_CHAINING: "ts-optional-chaining",
  NULLISH_COALESCING: "ts-nullish-coalescing",
};

const JS_PATTERNS = {
  PROMISES: "js-promises",
  CALLBACKS: "js-callbacks",
  EVENT_EMITTER: "js-event-emitter",
  MODULE_EXPORTS: "js-module-exports",
};

// ============================================================================
// TypeScript Detector Class
// ============================================================================

export class TypeScriptDetector extends BaseDetector {
  readonly language = "typescript";
  
  private tsFiles: string[] = [];
  
  canHandle(cwd: string): boolean {
    // Primary check: package.json exists
    const packageJsonPath = join(cwd, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const content = readFileSync(packageJsonPath, "utf-8");
        const pkg = JSON.parse(content);
        
        // Check for TypeScript indicators
        if (pkg.dependencies || pkg.devDependencies) {
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps.typescript || deps["@types/node"] || deps.tsx || deps.ts) {
            return true;
          }
          // Check for TypeScript frameworks
          if (deps.react || deps.vue || deps.svelte || deps.angular) {
            return true;
          }
        }
      } catch { /* ignore */ }
    }
    
    // Fallback: check for tsconfig.json
    if (existsSync(join(cwd, "tsconfig.json"))) {
      return true;
    }
    
    // Fallback: check for .ts/.tsx files in common directories
    const dirsToCheck = ["src", "lib", "app", "pages", "components", "hooks"];
    for (const dir of dirsToCheck) {
      const dirPath = join(cwd, dir);
      if (existsSync(dirPath)) {
        const files = this.getAllFiles(dirPath);
        if (files.some(f => f.endsWith(".ts") || f.endsWith(".tsx"))) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  async analyze(cwd: string): Promise<LanguageInfo> {
    const frameworks: string[] = [];
    const patterns: string[] = [];
    const components: string[] = [];
    
    // 1. Parse package.json for dependencies and frameworks
    this.parsePackageJson(cwd, frameworks);
    
    // 2. Parse tsconfig.json for TypeScript version and settings
    this.parseTsConfig(cwd, frameworks);
    
    // 3. Scan source files for patterns
    this.tsFiles = this.getTsFiles(cwd);
    this.detectPatterns(this.tsFiles, patterns);
    this.detectComponents(cwd, components);
    
    // 4. Calculate confidence
    const hasPackageJson = existsSync(join(cwd, "package.json"));
    const hasTsConfig = existsSync(join(cwd, "tsconfig.json"));
    const confidence = calculateConfidence(hasPackageJson || hasTsConfig, this.tsFiles.length, 100);
    
    return {
      language: this.language,
      confidence,
      frameworks,
      patterns,
      components,
    };
  }
  
  // ========================================================================
  // Private Methods
  // ========================================================================
  
  private parsePackageJson(cwd: string, frameworks: string[]): void {
    const packageJsonPath = join(cwd, "package.json");
    if (!existsSync(packageJsonPath)) return;
    
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      
      // Detect frameworks
      const frameworkMap: Record<string, string> = {
        "react": "react",
        "vue": "vue",
        "svelte": "svelte",
        "@angular/core": "angular",
        "next": "next",
        "@nuxtjs/core": "nuxt",
        "express": "express",
        "fastify": "fastify",
        "koa": "koa",
        "@nestjs/core": "nestjs",
        "@charmbracelet/bubbletea": "bubbletea",
        "@charmbracelet/bubbles": "bubbles",
      };
      
      for (const [dep, framework] of Object.entries(frameworkMap)) {
        if (deps[dep]) {
          frameworks.push(framework);
        }
      }
      
      // Detect build tools
      if (deps.vite || deps["@vitejs/plugin-react"]) frameworks.push("vite");
      if (deps.webpack || deps["webpack-cli"]) frameworks.push("webpack");
      if (deps.typescript) frameworks.push("typescript");
      
      // Detect testing frameworks
      if (deps.vitest) frameworks.push("vitest");
      if (deps.jest) frameworks.push("jest");
      if (deps.mocha) frameworks.push("mocha");
      
      // Add node if no specific framework found
      const hasFramework = frameworks.some(f => 
        ['react', 'vue', 'svelte', 'angular', 'next', 'nestjs', 'express', 'fastify'].includes(f)
      );
      
      if (!hasFramework && (deps["@types/node"] || deps.arcade || deps.dgram)) {
        frameworks.push("node");
      }
      
      // If only typescript detected, add node as base
      if (frameworks.length === 1 && frameworks[0] === "typescript") {
        frameworks.push("node");
      }
    } catch { /* ignore */ }
  }
  
  private parseTsConfig(cwd: string, frameworks: string[]): void {
    const tsconfigPath = join(cwd, "tsconfig.json");
    if (!existsSync(tsconfigPath)) return;
    
    try {
      const content = readFileSync(tsconfigPath, "utf-8");
      const config = JSON.parse(content);
      
      // Check for JSX/TSX support
      if (config.compilerOptions?.jsx) {
        const jsxMap: Record<string, string> = {
          "react": "react",
          "react-jsx": "react",
          "react-native": "react-native",
          "vue": "vue",
        };
        const jsxMode = config.compilerOptions.jsx;
        if (jsxMap[jsxMode]) {
          if (!frameworks.includes(jsxMap[jsxMode])) {
            frameworks.push(jsxMap[jsxMode]);
          }
        }
      }
    } catch { /* ignore */ }
  }
  
  private getTsFiles(cwd: string): string[] {
    const dirsToScan = ["src", "lib", "app", "pages", "components", "hooks", "test"];
    const files: string[] = [];
    
    for (const dir of dirsToScan) {
      const dirPath = join(cwd, dir);
      if (existsSync(dirPath)) {
        files.push(...this.getAllFiles(dirPath).filter(
          f => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx")
        ));
      }
    }
    
    return files.slice(0, 200); // Limit for performance
  }
  
  private detectPatterns(files: string[], patterns: string[]): void {
    let hasAsync = false;
    let hasGenerics = false;
    let hasInterfaces = false;
    let hasDecorators = false;
    let hasPromises = false;
    
    for (const file of files.slice(0, 50)) {
      try {
        const content = readFileSync(file, "utf-8");
        
        if (!hasAsync && /\basync\s+(function|\()/ .test(content)) {
          hasAsync = true;
          patterns.push(TS_PATTERNS.ASYNC_AWAIT);
        }
        
        if (!hasGenerics && /<[A-Z]\w+>/.test(content)) {
          hasGenerics = true;
          patterns.push(TS_PATTERNS.GENERICS);
        }
        
        if (!hasInterfaces && /interface\s+\w+\s*[<{]/.test(content)) {
          hasInterfaces = true;
          patterns.push(TS_PATTERNS.INTERFACES);
        }
        
        if (!hasDecorators && /@(?:component|controller|service|injectable)/.test(content)) {
          hasDecorators = true;
          patterns.push(TS_PATTERNS.DECORATORS);
        }
        
        if (!hasPromises && /\.then\(|\.catch\(|new\s+Promise/.test(content)) {
          hasPromises = true;
          patterns.push(JS_PATTERNS.PROMISES);
        }
      } catch { /* skip */ }
    }
    
    // Add common patterns if none found
    if (patterns.length === 0) {
      patterns.push(TS_PATTERNS.ASYNC_AWAIT);
    }
  }
  
  private detectComponents(cwd: string, components: string[]): void {
    // Detect components by directory structure
    const componentDirs = [
      "components", "pages", "hooks", "utils", "services", 
      "api", "handlers", "middleware", "models", "types"
    ];
    
    for (const dir of componentDirs) {
      const path = join(cwd, "src", dir);
      if (existsSync(path)) {
        try {
          const stat = statSync(path);
          if (stat.isDirectory()) {
            components.push(dir);
          }
        } catch { /* skip */ }
      }
    }
  }
}

// ============================================================================
// JavaScript Detector (alias for TypeScript detector in JS projects)
// ============================================================================

export class JavaScriptDetector extends TypeScriptDetector {
  constructor() {
    super();
    // Override language for JS projects
    Object.defineProperty(this, 'language', {
      value: 'javascript',
      writable: false
    });
  }
}

// ============================================================================
// Export for convenience
// ============================================================================

export default new TypeScriptDetector();