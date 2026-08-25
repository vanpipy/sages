/**
 * Go Language Detector
 * 
 * Detects Go projects by:
 * 1. Looking for go.mod file
 * 2. Scanning .go files
 * 3. Parsing dependencies for framework detection
 * 
 * Supported Frameworks: Bubble Tea, Cobra, Viper, Gin, Fiber
 */

import { 
  BaseDetector, 
  LanguageInfo, 
  calculateConfidence 
} from "./base";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Go-Specific Patterns
// ============================================================================

const GO_PATTERNS = {
  ERROR_HANDLING: "go-error-handling",
  INTERFACES: "go-interfaces",
  GOROUTINES: "go-goroutines",
  CHANNELS: "go-channels",
  DEFER: "go-defer",
  CONTEXT: "go-context",
  STRUCT_TAGS: "go-struct-tags",
};

// ============================================================================
// Go Detector Class
// ============================================================================

export class GoDetector extends BaseDetector {
  readonly language = "go";
  
  private goFiles: string[] = [];
  
  canHandle(cwd: string): boolean {
    // Primary check: go.mod exists
    if (existsSync(join(cwd, "go.mod"))) {
      return true;
    }
    
    // Fallback: check for .go files in common directories
    const dirsToCheck = ["src", "cmd", "internal", "pkg", "lib"];
    for (const dir of dirsToCheck) {
      const dirPath = join(cwd, dir);
      if (existsSync(dirPath)) {
        const files = this.getAllFiles(dirPath);
        if (files.some(f => f.endsWith(".go"))) {
          return true;
        }
      }
    }
    
    // Check root level for .go files
    try {
      const entries = readdirSync(cwd);
      if (entries.some(e => e.endsWith(".go"))) {
        return true;
      }
    } catch { /* ignore */ }
    
    return false;
  }
  
  async analyze(cwd: string): Promise<LanguageInfo> {
    const frameworks: string[] = [];
    const patterns: string[] = [];
    const components: string[] = [];
    
    // Parse go.mod for dependencies
    const goModPath = join(cwd, "go.mod");
    const goModContent = this.readFile(goModPath);
    if (goModContent) {
      this.parseDependencies(goModContent, frameworks);
    }
    
    // 2. Scan source files for patterns
    this.goFiles = this.getGoFiles(cwd);
    this.detectPatterns(this.goFiles, patterns);
    this.detectComponents(cwd, components);
    
    // 3. Calculate confidence
    const hasGoMod = existsSync(goModPath);
    const confidence = calculateConfidence(hasGoMod, this.goFiles.length, 50);
    
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
  
  private parseDependencies(content: string, frameworks: string[]): void {
    // Framework detection from import paths
    const frameworkMap: Record<string, string> = {
      "charm.land/bubbletea": "bubbletea",
      "charm.land/bubbles": "bubbles",
      "charm.land/lipgloss": "lipgloss",
      "github.com/charmbracelet/bubbletea": "bubbletea",
      "github.com/charmbracelet/bubbles": "bubbles",
      "github.com/charmbracelet/lipgloss": "lipgloss",
      "github.com/spf13/cobra": "cobra",
      "github.com/spf13/viper": "viper",
      "github.com/gin-gonic/gin": "gin",
      "github.com/gofiber/fiber": "fiber",
      "github.com/golang-jwt/jwt": "jwt",
      "github.com/go-redis/redis": "redis",
      "github.com/jmoiron/sqlx": "sqlx",
      "github.com/lib/pq": "postgres",
    };
    
    for (const [importPath, framework] of Object.entries(frameworkMap)) {
      if (content.includes(importPath)) {
        frameworks.push(framework);
      }
    }
  }
  
  private getGoFiles(cwd: string): string[] {
    const dirsToScan = ["src", "cmd", "internal", "pkg", "lib", "app"];
    const files: string[] = [];
    
    for (const dir of dirsToScan) {
      const dirPath = join(cwd, dir);
      if (existsSync(dirPath)) {
        files.push(...this.getAllFiles(dirPath).filter(f => f.endsWith(".go")));
      }
    }
    
    // Also check root for single-file Go projects
    if (files.length === 0) {
      try {
        const entries = readdirSync(cwd);
        for (const entry of entries) {
          if (entry.endsWith(".go")) {
            files.push(join(cwd, entry));
          }
        }
      } catch { /* ignore */ }
    }
    
    return files.slice(0, 200); // Limit to 200 files for performance
  }
  
  private detectPatterns(files: string[], patterns: string[]): void {
    let hasErrorHandling = false;
    let hasInterfaces = false;
    let hasGoroutines = false;
    let hasDefer = false;
    let hasContext = false;
    let hasStructTags = false;
    
    for (const file of files.slice(0, 50)) { // Sample first 50 files
      try {
        const content = readFileSync(file, "utf-8");
        
        // Check for patterns
        if (!hasErrorHandling && /return\s+.*err/.test(content)) {
          hasErrorHandling = true;
          patterns.push(GO_PATTERNS.ERROR_HANDLING);
        }
        
        if (!hasInterfaces && /type\s+\w+\s+interface\s*{/.test(content)) {
          hasInterfaces = true;
          patterns.push(GO_PATTERNS.INTERFACES);
        }
        
        if (!hasGoroutines && /go\s+func|go\s+\w+\(/.test(content)) {
          hasGoroutines = true;
          patterns.push(GO_PATTERNS.GOROUTINES);
        }
        
        if (!hasDefer && /defer\s+/.test(content)) {
          hasDefer = true;
          patterns.push(GO_PATTERNS.DEFER);
        }
        
        if (!hasContext && /context\.Context|context\.WithCancel/.test(content)) {
          hasContext = true;
          patterns.push(GO_PATTERNS.CONTEXT);
        }
        
        if (!hasStructTags && /`\w+:"[^"]+"/.test(content)) {
          hasStructTags = true;
          patterns.push(GO_PATTERNS.STRUCT_TAGS);
        }
      } catch { /* skip */ }
    }
    
    // Add common patterns if none found
    if (patterns.length === 0) {
      patterns.push(GO_PATTERNS.ERROR_HANDLING);
    }
  }
  
  private detectComponents(cwd: string, components: string[]): void {
    // Detect existing components by directory structure
    const componentDirs = ["internal", "pkg", "cmd", "api", "handlers", "services", "models"];
    
    for (const dir of componentDirs) {
      const path = join(cwd, dir);
      if (existsSync(path)) {
        try {
          const stat = statSync(path);
          if (stat.isDirectory()) {
            components.push(dir);
          }
        } catch { /* skip */ }
      }
    }
    
    // Detect specific Go patterns from file naming
    const goFiles = this.getGoFiles(cwd);
    const fileNames = goFiles.map(f => f.split("/").pop() || "");
    
    if (fileNames.some(f => f.includes("_test.go"))) {
      components.push("testing");
    }
    if (fileNames.some(f => f.includes("_handler") || f.includes("handler"))) {
      components.push("handlers");
    }
    if (fileNames.some(f => f.includes("_service") || f.includes("service"))) {
      components.push("services");
    }
    if (fileNames.some(f => f.includes("_model") || f.includes("model"))) {
      components.push("models");
    }
  }
}

// ============================================================================
// Export for convenience
// ============================================================================

export default new GoDetector();
