/**
 * Java Language Detector
 * 
 * Detects Java projects by:
 * 1. Looking for pom.xml (Maven) or build.gradle (Gradle)
 * 2. Scanning .java files
 * 3. Parsing dependencies for framework detection
 * 
 * Supported Frameworks: Spring Boot, Spring MVC, Jakarta EE, JUnit, etc.
 */

import { 
  BaseDetector, 
  LanguageInfo, 
  calculateConfidence 
} from "./base";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Java-Specific Patterns
// ============================================================================

const JAVA_PATTERNS = {
  ANNOTATIONS: "java-annotations",
  GENERICS: "java-generics",
  LAMBDA_EXPRESSIONS: "java-lambda-expressions",
  STREAMS: "java-streams",
  OPTIONAL: "java-optional",
  RECORD: "java-record",
  SEALED_CLASSES: "java-sealed-classes",
  DEPENDENCY_INJECTION: "java-dependency-injection",
};

// ============================================================================
// Java Detector Class
// ============================================================================

export class JavaDetector extends BaseDetector {
  readonly language = "java";
  
  private javaFiles: string[] = [];
  
  canHandle(cwd: string): boolean {
    // Primary check: Build files
    const buildFiles = [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "pom.xml",
      ".classpath",
      "settings.gradle"
    ];
    
    for (const file of buildFiles) {
      if (existsSync(join(cwd, file))) {
        return true;
      }
    }
    
    // Fallback: check for .java files in common directories
    const dirsToCheck = ["src", "java", "src/main/java", "src/test/java"];
    for (const dir of dirsToCheck) {
      const dirPath = join(cwd, dir);
      if (existsSync(dirPath)) {
        const files = this.getAllFiles(dirPath);
        if (files.some(f => f.endsWith(".java"))) {
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
    
    // 1. Parse build files for dependencies and frameworks
    this.parseBuildFiles(cwd, frameworks);
    
    // 2. Scan source files for patterns
    this.javaFiles = this.getJavaFiles(cwd);
    this.detectPatterns(this.javaFiles, patterns);
    this.detectComponents(cwd, components);
    
    // 3. Calculate confidence
    const hasBuildFile = this.hasBuildFile(cwd);
    const confidence = calculateConfidence(hasBuildFile, this.javaFiles.length, 50);
    
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
  
  private hasBuildFile(cwd: string): boolean {
    const buildFiles = ["pom.xml", "build.gradle", "build.gradle.kts"];
    for (const file of buildFiles) {
      if (existsSync(join(cwd, file))) {
        return true;
      }
    }
    return false;
  }
  
  private parseBuildFiles(cwd: string, frameworks: string[]): void {
    // Parse pom.xml (Maven)
    const pomPath = join(cwd, "pom.xml");
    if (existsSync(pomPath)) {
      try {
        const content = readFileSync(pomPath, "utf-8");
        this.parsePomXml(content, frameworks);
      } catch { /* ignore */ }
    }
    
    // Parse build.gradle (Gradle)
    const gradlePath = join(cwd, "build.gradle");
    if (existsSync(gradlePath)) {
      try {
        const content = readFileSync(gradlePath, "utf-8");
        this.parseGradle(content, frameworks);
      } catch { /* ignore */ }
    }
  }
  
  private parsePomXml(content: string, frameworks: string[]): void {
    // Framework detection from dependencies
    const frameworkMap: Record<string, string> = {
      "spring-boot": "spring-boot",
      "spring-web": "spring-mvc",
      "spring-data": "spring-data",
      "spring-security": "spring-security",
      "spring-core": "spring",
      "jakarta.servlet": "jakarta-ee",
      "javax.servlet": "java-ee",
      "hibernate": "hibernate",
      "junit": "junit",
      "mockito": "mockito",
      "selenium": "selenium",
      "apache-poi": "apache-poi",
      "guava": "guava",
    };
    
    for (const [dep, fw] of Object.entries(frameworkMap)) {
      if (content.includes(dep)) {
        frameworks.push(fw);
      }
    }
    
    // Detect Java version
    const javaVersionMatch = content.match(/<java\.version>([^<]+)<\/java\.version>/);
    if (javaVersionMatch) {
      frameworks.push(`Java ${javaVersionMatch[1]}`);
    }
  }
  
  private parseGradle(content: string, frameworks: string[]): void {
    // Framework detection from dependencies
    const frameworkMap: Record<string, string> = {
      "spring-boot-starter": "spring-boot",
      "spring-web": "spring-mvc",
      "spring-data-jpa": "spring-data",
      "hibernate": "hibernate",
      "junit": "junit",
      "mockk": "mockito",
    };
    
    for (const [dep, fw] of Object.entries(frameworkMap)) {
      if (content.includes(dep)) {
        frameworks.push(fw);
      }
    }
  }
  
  private getJavaFiles(cwd: string): string[] {
    const dirsToScan = ["src", "java", "app", "main", "test"];
    const files: string[] = [];
    
    for (const dir of dirsToScan) {
      // Check multiple subdirectories
      const candidates = [
        join(cwd, dir),
        join(cwd, "src", dir),
        join(cwd, "src", "main", dir),
        join(cwd, "src", "test", dir),
      ];
      
      for (const dirPath of candidates) {
        if (existsSync(dirPath)) {
          files.push(...this.getAllFiles(dirPath).filter(f => f.endsWith(".java")));
        }
      }
    }
    
    return files.slice(0, 200);
  }
  
  private detectPatterns(files: string[], patterns: string[]): void {
    let hasAnnotations = false;
    let hasGenerics = false;
    let hasLambdas = false;
    let hasStreams = false;
    let hasOptional = false;
    let hasRecords = false;
    
    for (const file of files.slice(0, 50)) {
      try {
        const content = readFileSync(file, "utf-8");
        
        if (!hasAnnotations && /@(?:Component|Service|Controller|Repository|Autowired)/.test(content)) {
          hasAnnotations = true;
          patterns.push(JAVA_PATTERNS.ANNOTATIONS);
        }
        
        if (!hasGenerics && /<[A-Z][a-zA-Z]*<|List<|Map<|Set<|Optional</.test(content)) {
          hasGenerics = true;
          patterns.push(JAVA_PATTERNS.GENERICS);
        }
        
        if (!hasLambdas && /->\s*[{(]|\(\)\s*->/.test(content)) {
          hasLambdas = true;
          patterns.push(JAVA_PATTERNS.LAMBDA_EXPRESSIONS);
        }
        
        if (!hasStreams && /\.stream\(\)|\.filter\(|\.map\(|\.collect\(/.test(content)) {
          hasStreams = true;
          patterns.push(JAVA_PATTERNS.STREAMS);
        }
        
        if (!hasOptional && /Optional\./.test(content)) {
          hasOptional = true;
          patterns.push(JAVA_PATTERNS.OPTIONAL);
        }
        
        if (!hasRecords && /record\s+\w+/.test(content)) {
          hasRecords = true;
          patterns.push(JAVA_PATTERNS.RECORD);
        }
      } catch { /* skip */ }
    }
    
    if (patterns.length === 0) {
      patterns.push(JAVA_PATTERNS.ANNOTATIONS);
    }
  }
  
  private detectComponents(cwd: string, components: string[]): void {
    const componentDirs = [
      "src/main/java", "src/test/java", "src/main/resources",
      "models", "services", "controllers", "repositories",
      "config", "entity", "dto", "exception"
    ];
    
    for (const dir of componentDirs) {
      const path = join(cwd, dir);
      if (existsSync(path)) {
        try {
          const stat = statSync(path);
          if (stat.isDirectory()) {
            // Extract component name from path
            const name = dir.split("/").pop() || dir;
            components.push(name);
          }
        } catch { /* ignore */ }
      }
    }
  }
}

// ============================================================================
// Export for convenience
// ============================================================================

export default new JavaDetector();