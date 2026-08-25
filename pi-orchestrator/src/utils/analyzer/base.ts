/**
 * Analyzer Module - Base Types and Interfaces
 * 
 * This module defines the core interfaces for the language detection system.
 * Follows composition patterns for extensibility as new languages are added.
 * 
 * Supported Languages: Go, TypeScript, Python, Java
 */

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

// ============================================================================
// Core Interfaces
// ============================================================================

/**
 * Language information returned by a detector
 */
export interface LanguageInfo {
  /** Primary language (e.g., "go", "typescript", "python", "java") */
  language: string;
  /** Confidence score from 0 to 1 */
  confidence: number;
  /** Detected frameworks/libraries */
  frameworks: string[];
  /** Coding patterns detected */
  patterns: string[];
  /** Existing components found */
  components: string[];
}

/**
 * Interface for language detectors
 * Each language gets its own detector that can be composed together
 */
export interface LanguageDetector {
  /** Unique identifier for this language */
  readonly language: string;
  /** Detect language and return info */
  detect(cwd: string): Promise<LanguageInfo | null>;
  /** Check if this detector can handle the project */
  canHandle(cwd: string): boolean;
}

/**
 * Registry of all language detectors
 */
export type DetectorRegistry = Record<string, LanguageDetector>;

// ============================================================================
// Tech Stack Types
// ============================================================================

export interface TechStackInfo {
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  testing: string[];
  linting: string[];
}

// ============================================================================
// Project Structure Types
// ============================================================================

export interface DirectoryNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: DirectoryNode[];
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

// ============================================================================
// Key Files and Dependencies
// ============================================================================

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

// ============================================================================
// Full Project Context (Aggregated from all detectors)
// ============================================================================

export interface ProjectContext {
  projectName: string;
  language: string;
  framework: string | null;
  projectType: string;
  techStack: TechStackInfo;
  structure: ProjectStructure;
  patterns: string[];
  existingComponents: string[];
  keyFiles: KeyFileInfo[];
  dependencies: DependencyInfo[];
}

// ============================================================================
// Analyzer Base Class with Common Utilities
// ============================================================================

export abstract class BaseDetector implements LanguageDetector {
  abstract readonly language: string;
  
  protected cwd: string = "";
  
  detect(cwd: string): Promise<LanguageInfo | null> {
    this.cwd = cwd;
    if (!this.canHandle(cwd)) {
      return Promise.resolve(null);
    }
    return this.analyze(cwd);
  }
  
  abstract canHandle(cwd: string): boolean;
  abstract analyze(cwd: string): Promise<LanguageInfo>;
  
  /**
   * Common utility: Check if file exists
   */
  protected fileExists(path: string): boolean {
    return existsSync(path);
  }
  
  /**
   * Common utility: Read file content safely
   */
  protected readFile(path: string, maxSize = 1024 * 1024): string | null {
    try {
      const content = readFileSync(path, "utf-8");
      return content.length > maxSize ? content.slice(0, maxSize) : content;
    } catch {
      return null;
    }
  }
  
  /**
   * Common utility: Get all files in directory recursively
   */
  protected getAllFiles(dir: string, files: string[] = []): string[] {
    try {
      const { readdirSync, statSync } = require("node:fs");
      const entries = readdirSync(dir);
      
      for (const entry of entries) {
        if (entry === "node_modules" || entry === ".git") continue;
        
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            this.getAllFiles(fullPath, files);
          } else {
            files.push(fullPath);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    
    return files;
  }
}

// ============================================================================
// Common Patterns for All Languages
// ============================================================================

export const COMMON_PATTERNS = {
  ERROR_HANDLING: "error-handling",
  LOGGING: "logging",
  CONFIGURATION: "configuration",
  TESTING: "testing",
  VALIDATION: "validation",
  PARSING: "parsing",
  SERIALIZATION: "serialization",
  HTTP_CLIENT: "http-client",
  DATABASE: "database",
  CACHING: "caching",
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate confidence based on file count and config presence
 */
export function calculateConfidence(
  configFound: boolean,
  fileCount: number,
  maxExpected: number
): number {
  let confidence = 0;
  
  if (configFound) confidence += 0.4;
  confidence += Math.min(0.5, (fileCount / maxExpected) * 0.5);
  confidence += 0.1; // Base confidence
  
  return Math.min(1, confidence);
}

/**
 * Extract version from dependency string
 */
export function extractVersion(depString: string): string {
  const match = depString.match(/[vV]?(\d+\.\d+\.\d+)/);
  return match ? match[1] : "unknown";
}