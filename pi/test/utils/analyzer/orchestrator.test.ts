import { describe, it, expect, beforeEach } from 'bun:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProjectAnalyzer } from '../../../src/utils/analyzer/orchestrator';
import { GoDetector } from '../../../src/utils/analyzer/go-detector';
import { TypeScriptDetector } from '../../../src/utils/analyzer/typescript-detector';

// Resolve fixture paths relative to test file location
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(__dirname, '../../fixtures');
const GO_FIXTURE = path.join(FIXTURES, 'go-with-cobra');

describe('ProjectAnalyzer', () => {
  let analyzer: ProjectAnalyzer;
  
  beforeEach(() => {
    analyzer = new ProjectAnalyzer();
  });
  
  describe('construction', () => {
    it('should be able to analyze projects', async () => {
      // Just verify the analyzer exists and can be called
      const context = await analyzer.analyze('/tmp');
      expect(context).toBeDefined();
      expect(context.language).toBeDefined();
    });
  });
  
  describe('analyze', () => {
    it('should analyze Go project correctly', async () => {
      const context = await analyzer.analyze(GO_FIXTURE);

      expect(context.language).toBe('go');
      expect(context.framework).toBe('bubbletea');
      expect(context.projectType).toBe('cli');
      expect(context.techStack.languages).toContain('go');
    });
    
    it('should analyze TypeScript project correctly', async () => {
      const context = await analyzer.analyze('/home/leroy/Project/sages/pi');

      expect(context.language).toBe('typescript');
      expect(typeof context.projectName).toBe('string');
    });

    it('should detect TypeScript from monorepo root by scanning workspaces', async () => {
      // The sages repo is a monorepo: root has workspaces: ["pi"] but no TS code itself.
      // The analyzer should fall back to scanning workspace packages.
      const context = await analyzer.analyze('/home/leroy/Project/sages');

      expect(context.language).toBe('typescript');
      // Framework should be detected (the detector pushes "typescript" then "node")
      expect(context.framework).toBeTruthy();
    });

    it('should return ProjectContext with all required fields', async () => {
      const context = await analyzer.analyze(GO_FIXTURE);

      expect(typeof context.projectName).toBe('string');
      expect(typeof context.language).toBe('string');
      expect(typeof context.framework).toBe('string');
      expect(typeof context.projectType).toBe('string');
      expect(typeof context.techStack).toBe('object');
      expect(typeof context.structure).toBe('object');
      expect(Array.isArray(context.patterns)).toBe(true);
      expect(Array.isArray(context.existingComponents)).toBe(true);
      expect(Array.isArray(context.keyFiles)).toBe(true);
    });
  });
  
  describe('detectLanguage', () => {
    it('should detect Go from go.mod', async () => {
      const info = await analyzer.detectLanguage(GO_FIXTURE);

      expect(info).not.toBeNull();
      expect(info!.language).toBe('go');
      expect(info!.confidence).toBeGreaterThan(0.5);
    });
    
    it('should detect TypeScript from package.json', async () => {
      const info = await analyzer.detectLanguage('/home/leroy/Project/sages/pi');
      
      expect(info).not.toBeNull();
      expect(info!.language).toBe('typescript');
    });
  });
  
  describe('detectProjectType', () => {
    it('should detect CLI project type', async () => {
      const type = analyzer.detectProjectType('go', 'bubbletea', 'create a command');
      
      expect(type).toBe('cli');
    });
    
    it('should detect API project type', async () => {
      const type = analyzer.detectProjectType('go', 'gin', 'create a REST endpoint');
      
      expect(type).toBe('api');
    });
    
    it('should detect Web project type', async () => {
      const type = analyzer.detectProjectType('typescript', 'react', 'build a web app');
      
      expect(type).toBe('web');
    });
  });
});

describe('ProjectAnalyzer Integration', () => {
  it('should work with the existing project-analyzer interface', async () => {
    const analyzer = new ProjectAnalyzer();

    // Should produce similar output to the original analyzeProject
    const context = await analyzer.analyze(GO_FIXTURE);

    expect(context).toBeDefined();
    expect(context.projectName).toBe('go-with-cobra');
  });

  it('should provide structured output for draft generation', async () => {
    const analyzer = new ProjectAnalyzer();
    const context = await analyzer.analyze(GO_FIXTURE);

    // The context should be usable by draft-generator
    expect(context.techStack.frameworks.length).toBeGreaterThan(0);
    expect(context.patterns.length).toBeGreaterThan(0);
  });
});
