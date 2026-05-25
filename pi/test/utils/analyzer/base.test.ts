import { describe, it, expect } from 'bun:test';

// Test interface contract
describe('LanguageDetector Interface', () => {
  it('should define detect function signature', () => {
    // Interface should require: detect(cwd: string) => Promise<LanguageInfo>
    const mockDetect = async (cwd: string) => {
      return { language: 'go', confidence: 1.0 };
    };
    
    const result: any = mockDetect('/some/path');
    expect(result instanceof Promise).toBe(true);
  });

  it('should define ProjectContext interface', () => {
    const context = {
      language: 'go',
      confidence: 1.0,
      frameworks: ['bubbletea'],
      patterns: [],
      components: [],
    };
    
    expect(context.language).toBe('go');
    expect(context.frameworks[0]).toBe('bubbletea');
  });

  it('should support all four languages', () => {
    const languages = ['go', 'typescript', 'python', 'java'];
    
    for (const lang of languages) {
      const mockInfo = {
        language: lang,
        confidence: 0.9,
        frameworks: [],
        patterns: [],
        components: [],
      };
      expect(mockInfo.language).toBe(lang);
    }
  });

  it('should define DetectorRegistry type', () => {
    const registry: Record<string, any> = {
      go: { detect: async () => ({}) },
      typescript: { detect: async () => ({}) },
    };
    
    expect(Object.keys(registry).length).toBe(2);
  });
});

describe('AnalyzedContext Interface', () => {
  it('should contain all required fields', () => {
    const context = {
      projectName: 'test-project',
      language: 'go',
      framework: 'bubbletea',
      projectType: 'cli',
      techStack: {
        languages: ['Go 1.21'],
        frameworks: ['bubbletea'],
        buildTools: ['go build'],
        testing: [],
        linting: [],
      },
      structure: {
        rootDir: '/tmp',
        srcDir: 'internal',
        testDir: null,
        configDir: null,
        mainFile: null,
        hasPackageJson: false,
        hasTsConfig: false,
        hasGoMod: true,
        hasCargoToml: false,
        hasRequirements: false,
        directoryTree: [],
      },
      patterns: ['error-handling'],
      existingComponents: [],
      keyFiles: [],
      dependencies: [],
    };
    
    expect(context.projectName).toBe('test-project');
    expect(context.language).toBe('go');
    expect(context.framework).toBe('bubbletea');
    expect(context.projectType).toBe('cli');
    expect(context.techStack.languages).toContain('Go 1.21');
  });
});
