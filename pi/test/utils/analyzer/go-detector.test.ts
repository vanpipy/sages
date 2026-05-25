import { describe, it, expect, beforeEach } from 'bun:test';

// Fixed: 3 levels up from test/utils/analyzer/ to reach project root
import { GoDetector } from '../../../src/utils/analyzer/go-detector';
import type { LanguageInfo } from '../../../src/utils/analyzer/base';

describe('GoDetector', () => {
  let detector: GoDetector;

  beforeEach(() => {
    detector = new GoDetector();
  });

  describe('language property', () => {
    it('should have language set to "go"', () => {
      expect(detector.language).toBe('go');
    });
  });

  describe('canHandle', () => {
    it('should return true when go.mod exists', () => {
      const result = detector.canHandle('/home/leroy/Project/agentic-with-pi');
      expect(result).toBe(true);
    });

    it('should return false when no Go files exist', () => {
      const result = detector.canHandle('/tmp/non-go-project');
      expect(result).toBe(false);
    });
  });

  describe('detect', () => {
    it('should detect Go project with high confidence', async () => {
      const info = await detector.detect('/home/leroy/Project/agentic-with-pi');

      expect(info).not.toBeNull();
      expect(info!.language).toBe('go');
      expect(info!.confidence).toBeGreaterThan(0.5);
      expect(info!.frameworks).toContain('bubbletea');
      expect(info!.frameworks).toContain('cobra');
      expect(info!.frameworks).toContain('viper');
    });

    it('should return null for non-Go projects', async () => {
      const info = await detector.detect('/tmp/non-go-project');
      expect(info).toBeNull();
    });
  });

  describe('analyze', () => {
    it('should detect patterns in Go code', async () => {
      const info = await detector.analyze('/home/leroy/Project/agentic-with-pi');

      expect(Array.isArray(info.patterns)).toBe(true);
    });

    it('should detect existing components', async () => {
      const info = await detector.analyze('/home/leroy/Project/agentic-with-pi');

      expect(Array.isArray(info.components)).toBe(true);
      expect(info.components.length).toBeGreaterThan(0);
    });
  });

  describe('Go-specific detection', () => {
    it('should detect Bubble Tea TUI framework', async () => {
      const info = await detector.analyze('/home/leroy/Project/agentic-with-pi');

      expect(info.frameworks).toContain('bubbletea');
      expect(info.frameworks).toContain('lipgloss');
    });

    it('should detect Cobra CLI patterns', async () => {
      const info = await detector.analyze('/home/leroy/Project/agentic-with-pi');

      expect(info.frameworks).toContain('cobra');
    });

    it('should detect Viper config patterns', async () => {
      const info = await detector.analyze('/home/leroy/Project/agentic-with-pi');

      expect(info.frameworks).toContain('viper');
    });
  });
});

describe('GoDetector Integration', () => {
  it('should analyze the awp project correctly', async () => {
    const detector = new GoDetector();
    const info = await detector.detect('/home/leroy/Project/agentic-with-pi');

    // Verify full LanguageInfo structure
    expect(info).toBeDefined();
    const expectedKeys = ['language', 'confidence', 'frameworks', 'patterns', 'components'];
    expectedKeys.forEach(key => {
      expect(Object.prototype.hasOwnProperty.call(info!, key)).toBe(true);
    });
  });
});
