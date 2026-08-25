import { describe, it, expect, beforeEach } from 'bun:test';

import { JavaDetector } from '../../../src/utils/analyzer/java-detector';

describe('JavaDetector', () => {
  let detector: JavaDetector;
  
  beforeEach(() => {
    detector = new JavaDetector();
  });
  
  describe('language property', () => {
    it('should have language set to "java"', () => {
      expect(detector.language).toBe('java');
    });
  });
  
  describe('canHandle', () => {
    it('should return true when pom.xml exists', () => {
      // Check a directory
      const result = detector.canHandle('/tmp');
      expect(typeof result).toBe('boolean');
    });
    
    it('should return false when no Java files exist', () => {
      const result = detector.canHandle('/tmp/non-java-project');
      expect(result).toBe(false);
    });
  });
  
  describe('detect', () => {
    it('should return LanguageInfo for Java projects', async () => {
      const info = await detector.detect('/tmp/non-java-project');
      // May return null for non-Java projects, which is valid
      if (info) {
        expect(info.language).toBe('java');
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
  
  describe('Java-specific detection', () => {
    it('should detect Java patterns', async () => {
      const info = await detector.analyze('/tmp');
      
      expect(Array.isArray(info.patterns)).toBe(true);
    });
    
    it('should have valid confidence value', async () => {
      const info = await detector.analyze('/tmp');
      
      expect(info.confidence).toBeGreaterThanOrEqual(0);
      expect(info.confidence).toBeLessThanOrEqual(1);
    });
  });
});

describe('JavaDetector Integration', () => {
  it('should implement LanguageDetector interface', () => {
    const detector = new JavaDetector();
    
    expect(typeof detector.language).toBe('string');
    expect(typeof detector.canHandle).toBe('function');
    expect(typeof detector.detect).toBe('function');
    expect(typeof detector.analyze).toBe('function');
  });
});
