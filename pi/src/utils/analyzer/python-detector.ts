/**
 * Python Language Detector
 * 
 * Detects Python projects by:
 * 1. Looking for requirements.txt, setup.py, pyproject.toml
 * 2. Scanning .py files
 * 3. Parsing dependencies for framework detection
 * 
 * Supported Frameworks: Django, Flask, FastAPI, Pandas, NumPy, etc.
 */

import { 
  BaseDetector, 
  LanguageInfo, 
  calculateConfidence 
} from "./base";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Python-Specific Patterns
// ============================================================================

const PY_PATTERNS = {
  TYPE_HINTS: "py-type-hints",
  DECORATORS: "py-decorators",
  ASYNC_AWAIT: "py-async-await",
  dataclasses: "py-dataclasses",
  CONTEXT_MANAGERS: "py-context-managers",
  LIST_COMPREHENSIONS: "py-list-comprehensions",
  TYPE_ANNOTATIONS: "py-type-annotations",
  MATCH_CASE: "py-match-case",
};

// ============================================================================
// Python Detector Class
// ============================================================================

export class PythonDetector extends BaseDetector {
  readonly language = "python";
  
  private pyFiles: string[] = [];
  
  canHandle(cwd: string): boolean {
    // Primary check: Python config files
    const configFiles = [
      "requirements.txt",
      "setup.py",
      "pyproject.toml",
      "Pipfile",
      " poetry.lock"
    ];
    
    for (const file of configFiles) {
      if (existsSync(join(cwd, file))) {
        return true;
      }
    }
    
    // Fallback: check for .py files in common directories
    const dirsToCheck = ["src", "lib", "app", "scripts", "tests"];
    for (const dir of dirsToCheck) {
      const dirPath = join(cwd, dir);
      if (existsSync(dirPath)) {
        const files = this.getAllFiles(dirPath);
        if (files.some(f => f.endsWith(".py"))) {
          return true;
        }
      }
    }
    
    // Check root level for .py files
    try {
      const entries = readdirSync(cwd);
      if (entries.some(e => e.endsWith(".py"))) {
        return true;
      }
    } catch { /* ignore */ }
    
    return false;
  }
  
  async analyze(cwd: string): Promise<LanguageInfo> {
    const frameworks: string[] = [];
    const patterns: string[] = [];
    const components: string[] = [];
    
    // 1. Parse Python config files for dependencies and frameworks
    this.parseConfigFiles(cwd, frameworks);
    
    // 2. Scan source files for patterns
    this.pyFiles = this.getPyFiles(cwd);
    this.detectPatterns(this.pyFiles, patterns);
    this.detectComponents(cwd, components);
    
    // 3. Calculate confidence
    const hasConfig = this.hasPythonConfig(cwd);
    const confidence = calculateConfidence(hasConfig, this.pyFiles.length, 50);
    
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
  
  private hasPythonConfig(cwd: string): boolean {
    const configFiles = [
      "requirements.txt",
      "setup.py",
      "pyproject.toml",
      "Pipfile"
    ];
    
    for (const file of configFiles) {
      if (existsSync(join(cwd, file))) {
        return true;
      }
    }
    return false;
  }
  
  private parseConfigFiles(cwd: string, frameworks: string[]): void {
    // Parse requirements.txt
    const requirementsPath = join(cwd, "requirements.txt");
    if (existsSync(requirementsPath)) {
      try {
        const content = readFileSync(requirementsPath, "utf-8");
        this.parseRequirements(content, frameworks);
      } catch { /* ignore */ }
    }
    
    // Parse setup.py
    const setupPath = join(cwd, "setup.py");
    if (existsSync(setupPath)) {
      try {
        const content = readFileSync(setupPath, "utf-8");
        this.parseSetupPy(content, frameworks);
      } catch { /* ignore */ }
    }
    
    // Parse pyproject.toml
    const pyprojectPath = join(cwd, "pyproject.toml");
    if (existsSync(pyprojectPath)) {
      try {
        const content = readFileSync(pyprojectPath, "utf-8");
        this.parsePyproject(content, frameworks);
      } catch { /* ignore */ }
    }
  }
  
  private parseRequirements(content: string, frameworks: string[]): void {
    const frameworkMap: Record<string, string> = {
      "django": "django",
      "flask": "flask",
      "fastapi": "fastapi",
      "uvicorn": "uvicorn",
      "pandas": "pandas",
      "numpy": "numpy",
      "scipy": "scipy",
      "scikit-learn": "sklearn",
      "tensorflow": "tensorflow",
      "torch": "pytorch",
      "pytest": "pytest",
      "unittest": "unittest",
      "black": "black",
      "ruff": "ruff",
      "mypy": "mypy",
      "boto3": "boto3",
      "redis": "redis",
      "psycopg2": "postgres",
      "pymongo": "mongodb",
    };
    
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.split(/[=<>!]/)[0].trim();
      if (trimmed && frameworkMap[trimmed]) {
        frameworks.push(frameworkMap[trimmed]);
      }
    }
  }
  
  private parseSetupPy(content: string, frameworks: string[]): void {
    // Simple regex-based detection
    const frameworkMap = [
      "django", "flask", "fastapi", "pandas", "numpy", "pytest"
    ];
    
    for (const fw of frameworkMap) {
      if (content.includes(fw)) {
        frameworks.push(fw);
      }
    }
  }
  
  private parsePyproject(content: string, frameworks: string[]): void {
    // TOML-like parsing
    const frameworkMap: Record<string, string> = {
      "django": "django",
      "flask": "flask",
      "fastapi": "fastapi",
      "pytest": "pytest",
      "ruff": "ruff",
      "mypy": "mypy",
    };
    
    for (const [dep, fw] of Object.entries(frameworkMap)) {
      if (content.includes(dep)) {
        frameworks.push(fw);
      }
    }
  }
  
  private getPyFiles(cwd: string): string[] {
    const dirsToScan = ["src", "lib", "app", "scripts", "tests", "scripts"];
    const files: string[] = [];
    
    for (const dir of dirsToScan) {
      const dirPath = join(cwd, dir);
      if (existsSync(dirPath)) {
        files.push(...this.getAllFiles(dirPath).filter(f => f.endsWith(".py")));
      }
    }
    
    // Also check root
    if (files.length === 0) {
      try {
        const entries = readdirSync(cwd);
        for (const entry of entries) {
          if (entry.endsWith(".py")) {
            files.push(join(cwd, entry));
          }
        }
      } catch { /* ignore */ }
    }
    
    return files.slice(0, 200);
  }
  
  private detectPatterns(files: string[], patterns: string[]): void {
    let hasTypeHints = false;
    let hasDecorators = false;
    let hasAsync = false;
    let hasDataclasses = false;
    let hasContextManagers = false;
    
    for (const file of files.slice(0, 50)) {
      try {
        const content = readFileSync(file, "utf-8");
        
        if (!hasTypeHints && /:\s*(int|str|bool|list|dict|None)\b/.test(content)) {
          hasTypeHints = true;
          patterns.push(PY_PATTERNS.TYPE_HINTS);
        }
        
        if (!hasDecorators && /@/.test(content)) {
          hasDecorators = true;
          patterns.push(PY_PATTERNS.DECORATORS);
        }
        
        if (!hasAsync && /\basync\s+def\b/.test(content)) {
          hasAsync = true;
          patterns.push(PY_PATTERNS.ASYNC_AWAIT);
        }
        
        if (!hasDataclasses && /@dataclass/.test(content)) {
          hasDataclasses = true;
          patterns.push(PY_PATTERNS.dataclasses);
        }
        
        if (!hasContextManagers && /with\s+.*:\s*#/.test(content) || content.includes("__enter__")) {
          hasContextManagers = true;
          patterns.push(PY_PATTERNS.CONTEXT_MANAGERS);
        }
      } catch { /* skip */ }
    }
    
    if (patterns.length === 0) {
      patterns.push(PY_PATTERNS.TYPE_HINTS);
    }
  }
  
  private detectComponents(cwd: string, components: string[]): void {
    const componentDirs = [
      "src", "lib", "app", "scripts", "tests", "models", 
      "views", "controllers", "services", "api", "utils"
    ];
    
    for (const dir of componentDirs) {
      const path = join(cwd, dir);
      if (existsSync(path)) {
        try {
          const stat = statSync(path);
          if (stat.isDirectory()) {
            components.push(dir);
          }
        } catch { /* ignore */ }
      }
    }
  }
}

// ============================================================================
// Export for convenience
// ============================================================================

export default new PythonDetector();