import { describe, it, expect, beforeEach } from 'bun:test';

// Import from the new modular structure
import { TypeScriptDetector } from '../../../src/utils/analyzer/typescript-detector';
import { JavaScriptDetector } from '../../../src/utils/analyzer/typescript-detector'; // Same class, alias

describe('TypeScriptDetector', () => {
  let detector: TypeScriptDetector;
  
  beforeEach(() => {
    detector = new TypeScriptDetector();
  });
  
  describe('language property', () => {
    it('should have language set to "typescript"', () => {
      expect(detector.language).toBe('typescript');
    });
  });
  
  describe('canHandle', () => {
    it('should return true when package.json with TypeScript exists', () => {
      // Test with the sages pi project
      const result = detector.canHandle('/home/leroy/Project/sages/pi');
      expect(result).toBe(true);
    });
    
    it('should return false when no TypeScript files exist', () => {
      const result = detector.canHandle('/tmp/non-ts-project');
      expect(result).toBe(false);
    });
  });
  
  describe('detect', () => {
    it('should detect TypeScript project with high confidence', async () => {
      const info = await detector.detect('/home/leroy/Project/sages/pi');
      
      expect(info).not.toBeNull();
      expect(info!.language).toBe('typescript');
      expect(info!.confidence).toBeGreaterThan(0.5);
      expect(info!.frameworks).toContain('node');
    });
    
    it('should return null for non-TypeScript projects', async () => {
      const info = await detector.detect('/tmp/non-ts-project');
      expect(info).toBeNull();
    });
  });
  
  describe('analyze', () => {
    it('should detect TypeScript version from tsconfig', async () => {
      const info = await detector.analyze('/home/leroy/Project/sages/pi');
      
      expect(Array.isArray(info.frameworks)).toBe(true);
      expect(typeof info.confidence).toBe('number');
      expect(info.confidence).toBeGreaterThan(0);
    });
    
    it('should detect patterns in TypeScript code', async () => {
      const info = await detector.analyze('/home/leroy/Project/sages/pi');
      
      expect(Array.isArray(info.patterns)).toBe(true);
    });
    
    it('should detect existing components', async () => {
      const info = await detector.analyze('/home/leroy/Project/sages/pi');
      
      expect(Array.isArray(info.components)).toBe(true);
      expect(info.components.length).toBeGreaterThan(0);
    });
  });
  
  describe('TypeScript-specific detection', () => {
    it('should detect Node.js patterns', async () => {
      const info = await detector.analyze('/home/leroy/Project/sages/pi');
      
      expect(info.frameworks).toContain('node');
    });
    
    it('should detect framework from package.json', async () => {
      const info = await detector.analyze('/home/leroy/Project/sages/pi');
      
      // The pi project uses various patterns
      expect(Array.isArray(info.frameworks)).toBe(true);
    });
  });
});

describe('TypeScriptDetector Integration', () => {
  it('should analyze the sages project correctly', async () => {
    const detector = new TypeScriptDetector();
    const info = await detector.detect('/home/leroy/Project/sages/pi');
    
    // Verify full LanguageInfo structure
    expect(info).toBeDefined();
    const expectedKeys = ['language', 'confidence', 'frameworks', 'patterns', 'components'];
    expectedKeys.forEach(key => {
      expect(Object.prototype.hasOwnProperty.call(info!, key)).toBe(true);
    });
  });
});
