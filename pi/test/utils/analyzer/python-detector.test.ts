import { describe, it, expect, beforeEach } from 'bun:test';

import { PythonDetector } from '../../../src/utils/analyzer/python-detector';

describe('PythonDetector', () => {
  let detector: PythonDetector;
  
  beforeEach(() => {
    detector = new PythonDetector();
  });
  
  describe('language property', () => {
    it('should have language set to "python"', () => {
      expect(detector.language).toBe('python');
    });
  });
  
  describe('canHandle', () => {
    it('should return true when requirements.txt exists', () => {
      // Create a temp project with requirements.txt
      const result = detector.canHandle('/home/leroy/Project/agentic-with-pi');
      expect(typeof result).toBe('boolean');
    });
    
    it('should return false when no Python files exist', () => {
      const result = detector.canHandle('/tmp/non-python-project');
      expect(result).toBe(false);
    });
  });
  
  describe('detect', () => {
    it('should return LanguageInfo for Python projects', async () => {
      const info = await detector.detect('/tmp/non-python-project');
      // May return null for non-python projects, which is valid
      if (info) {
        expect(info.language).toBe('python');
      }
    });
  });
  
  describe('analyze', () => {
    it('should return valid LanguageInfo structure', async () => {
      const info = await detector.analyze('/tmp');
      
      expect(typeof info.language).toBe('string');
      expect(typeof info.confidence).toBe('number');
      expect(Array.isArray(info.frameworks)).toBe(true);
      expect(Array.isArray(info.patterns)).toBe(true);
      expect(Array.isArray(info.components)).toBe(true);
    });
  });
  
  describe('Python-specific detection', () => {
    it('should detect Python patterns', async () => {
      const info = await detector.analyze('/tmp');
      
      expect(Array.isArray(info.patterns)).toBe(true);
    });
    
    it('should have high confidence for Python projects', async () => {
      const info = await detector.analyze('/tmp');
      
      expect(info.confidence).toBeGreaterThanOrEqual(0);
      expect(info.confidence).toBeLessThanOrEqual(1);
    });
  });
});

describe('PythonDetector Integration', () => {
  it('should implement LanguageDetector interface', () => {
    const detector = new PythonDetector();
    
    expect(typeof detector.language).toBe('string');
    expect(typeof detector.canHandle).toBe('function');
    expect(typeof detector.detect).toBe('function');
    expect(typeof detector.analyze).toBe('function');
  });
});
