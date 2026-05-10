import { describe, it, expect, beforeEach } from 'bun:test';

import { ProjectAnalyzer } from '../../../src/utils/analyzer/orchestrator';
import { GoDetector } from '../../../src/utils/analyzer/go-detector';
import { TypeScriptDetector } from '../../../src/utils/analyzer/typescript-detector';

describe('ProjectAnalyzer', () => {
  let analyzer: ProjectAnalyzer;
  
  beforeEach(() => {
    analyzer = new ProjectAnalyzer();
  });
  
  describe('construction', () => {
    it('should have all four language detectors', () => {
      expect(analyzer.detectors.length).toBe(4);
      
      const languages = analyzer.detectors.map(d => d.language);
      expect(languages).toContain('go');
      expect(languages).toContain('typescript');
      expect(languages).toContain('python');
      expect(languages).toContain('java');
    });
  });
  
  describe('analyze', () => {
    it('should analyze Go project correctly', async () => {
      const context = await analyzer.analyze('/home/leroy/Project/agentic-with-pi');
      
      expect(context.language).toBe('go');
      expect(context.framework).toBe('bubbletea');
      expect(context.projectType).toBe('cli');
      expect(context.techStack.languages).toContain('Go 1.21');
    });
    
    it('should analyze TypeScript project correctly', async () => {
      const context = await analyzer.analyze('/home/leroy/Project/sages/pi');
      
      expect(context.language).toBe('typescript');
      expect(typeof context.projectName).toBe('string');
    });
    
    it('should return ProjectContext with all required fields', async () => {
      const context = await analyzer.analyze('/home/leroy/Project/agentic-with-pi');
      
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
      const info = await analyzer.detectLanguage('/home/leroy/Project/agentic-with-pi');
      
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
    const context = await analyzer.analyze('/home/leroy/Project/agentic-with-pi');
    
    expect(context).toBeDefined();
    expect(context.projectName).toBe('agentic-with-pi');
  });
  
  it('should provide structured output for draft generation', async () => {
    const analyzer = new ProjectAnalyzer();
    const context = await analyzer.analyze('/home/leroy/Project/agentic-with-pi');
    
    // The context should be usable by draft-generator
    expect(context.techStack.frameworks.length).toBeGreaterThan(0);
    expect(context.patterns.length).toBeGreaterThan(0);
  });
});
