/**
 * Analyzer Module - Main Entry Point
 * 
 * Composes all language detectors and provides unified analysis API.
 * Modular design for extensibility as new languages are added.
 */

// Re-export types
export type {
  LanguageInfo,
  LanguageDetector,
  DetectorRegistry,
  TechStackInfo,
  DirectoryNode,
  ProjectStructure,
  KeyFileInfo,
  DependencyInfo,
  ProjectContext,
} from './base';

// Export base utilities
export { BaseDetector, COMMON_PATTERNS, calculateConfidence, extractVersion } from './base';

// Export language detectors
export { GoDetector } from './go-detector';
export { TypeScriptDetector, JavaScriptDetector } from './typescript-detector';
export { PythonDetector } from './python-detector';
export { JavaDetector } from './java-detector';

// Export orchestrator
export { ProjectAnalyzer, analyzeProject } from './orchestrator';

// Import types for convenience
import type { LanguageDetector, LanguageInfo, ProjectContext } from './base';
export type { LanguageDetector, LanguageInfo, ProjectContext };
