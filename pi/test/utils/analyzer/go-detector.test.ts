import { describe, it, expect, beforeEach } from 'bun:test';

// Fixed: 3 levels up from test/utils/analyzer/ to reach project root
import { GoDetector } from '../../../src/utils/analyzer/go-detector';
import type { LanguageInfo } from '../../../src/utils/analyzer/base';

// Local fixtures replace previous hardcoded paths to /home/leroy/Project/agentic-with-pi.
const GO_FIXTURE = 'test/fixtures/go-with-cobra';        // cobra + bubbletea + lipgloss + bubbles
const VIPER_FIXTURE = 'test/fixtures/go-with-viper';     // viper only

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
      const result = detector.canHandle(GO_FIXTURE);
      expect(result).toBe(true);
    });

    it('should return false when no Go files exist', () => {
      const result = detector.canHandle('/tmp/non-go-project');
      expect(result).toBe(false);
    });
  });

  describe('detect', () => {
    it('should detect Go project with high confidence', async () => {
      const info = await detector.detect(GO_FIXTURE);

      expect(info).not.toBeNull();
      expect(info!.language).toBe('go');
      expect(info!.confidence).toBeGreaterThan(0.5);
      expect(info!.frameworks).toContain('bubbletea');
      expect(info!.frameworks).toContain('cobra');
    });

    it('should return null for non-Go projects', async () => {
      const info = await detector.detect('/tmp/non-go-project');
      expect(info).toBeNull();
    });
  });

  describe('analyze', () => {
    it('should detect patterns in Go code', async () => {
      const info = await detector.analyze(GO_FIXTURE);

      expect(Array.isArray(info.patterns)).toBe(true);
    });

    it('should detect existing components', async () => {
      const info = await detector.analyze(GO_FIXTURE);

      expect(Array.isArray(info.components)).toBe(true);
      expect(info.components.length).toBeGreaterThan(0);
    });
  });

  describe('Go-specific detection', () => {
    it('should detect Bubble Tea TUI framework', async () => {
      const info = await detector.analyze(GO_FIXTURE);

      expect(info.frameworks).toContain('bubbletea');
      expect(info.frameworks).toContain('lipgloss');
    });

    it('should detect Cobra CLI patterns', async () => {
      const info = await detector.analyze(GO_FIXTURE);

      expect(info.frameworks).toContain('cobra');
    });

    it('should detect Viper config patterns when present', async () => {
      // Uses the local go-with-viper fixture (test/fixtures/go-with-viper/) which
      // declares github.com/spf13/viper in go.mod. The detector rule lives in
      // go-detector.ts (parseDependencies frameworkMap).
      const info = await detector.analyze(VIPER_FIXTURE);
      expect(info.frameworks).toContain('viper');
    });
  });
});

describe('GoDetector Integration', () => {
  it('should analyze the go-with-cobra fixture correctly', async () => {
    const detector = new GoDetector();
    const info = await detector.detect(GO_FIXTURE);

    // Verify full LanguageInfo structure
    expect(info).toBeDefined();
    const expectedKeys = ['language', 'confidence', 'frameworks', 'patterns', 'components'];
    expectedKeys.forEach(key => {
      expect(Object.prototype.hasOwnProperty.call(info!, key)).toBe(true);
    });
  });
});
