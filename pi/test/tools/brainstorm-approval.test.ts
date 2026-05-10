import { describe, it, expect } from 'bun:test';
import {
  generateApprovalMessage,
  parseTransitionResponse,
  createFuxiContext,
  type TransitionResult,
} from '../../src/tools/brainstorming/index';
import type { Approach, DesignDoc, BrainstormContextResult } from '../../src/tools/brainstorming/index';

describe('generateApprovalMessage', () => {
  it('should include design approval status', () => {
    const message = generateApprovalMessage(
      'add login feature',
      '.sages/designs/2024-01-01-login.md',
      { id: '1', name: 'JWT', description: 'Use JWT', pros: [], cons: [], complexity: 'medium' }
    );
    
    expect(message).toContain('Design Approved');
    expect(message).toContain('add login feature');
    expect(message).toContain('JWT');
  });
  
  it('should list all three options', () => {
    const message = generateApprovalMessage(
      'test',
      '/path/to/design.md',
      { id: '1', name: 'A', description: 'A', pros: [], cons: [], complexity: 'low' }
    );
    
    expect(message).toContain('Proceed');
    expect(message).toContain('Defer');
    expect(message).toContain('Exit');
  });
  
  it('should mention Fuxi workflow for proceed option', () => {
    const message = generateApprovalMessage(
      'build feature',
      '/path/to/design.md',
      { id: '1', name: 'B', description: 'B', pros: [], cons: [], complexity: 'medium' }
    );
    
    expect(message).toContain('Fuxi');
  });
});

describe('parseTransitionResponse', () => {
  describe('proceed patterns', () => {
    const proceedPatterns = [
      'proceed', 'yes', 'y', 'start', 'implement', 'go',
      'Proceed', 'YES', 'START', 'Go ahead', 'do it'
    ];
    
    proceedPatterns.forEach(response => {
      it(`should parse "${response}" as proceed`, () => {
        const result = parseTransitionResponse(response);
        expect(result.action).toBe('proceed');
      });
    });
  });
  
  describe('defer patterns', () => {
    const deferPatterns = [
      'defer', 'save', 'later', 'pause', 'not now',
      'Defer', 'SAVE', 'later please', 'wait'
    ];
    
    deferPatterns.forEach(response => {
      it(`should parse "${response}" as defer`, () => {
        const result = parseTransitionResponse(response);
        expect(result.action).toBe('defer');
      });
    });
  });
  
  describe('exit patterns', () => {
    const exitPatterns = [
      'exit', 'cancel', 'quit', 'end', 'stop',
      'Exit', 'CANCEL', 'never mind'
    ];
    
    exitPatterns.forEach(response => {
      it(`should parse "${response}" as exit`, () => {
        const result = parseTransitionResponse(response);
        expect(result.action).toBe('exit');
      });
    });
  });
  
  it('should default to proceed for unrecognized responses', () => {
    const result = parseTransitionResponse('whatever');
    expect(result.action).toBe('proceed');
  });
  
  it('should return proceed when response is empty', () => {
    const result = parseTransitionResponse('');
    expect(result.action).toBe('proceed');
  });
});

describe('createFuxiContext', () => {
  it('should create Fuxi context from brainstorm design', () => {
    const projectContext: BrainstormContextResult = {
      projectName: 'my-project',
      language: 'go',
      framework: 'bubbletea',
      projectType: 'cli',
      techStack: { languages: ['Go 1.21'], frameworks: [], buildTools: [], testing: [], linting: [] },
      existingComponents: ['agent', 'tui'],
      keyFiles: [],
    };
    
    const designDoc: DesignDoc = {
      title: 'Login Design',
      overview: 'Add login',
      context: 'Need auth',
      requirements: ['Login form', 'Session'],
      chosenApproach: { id: '1', name: 'JWT', description: 'JWT auth', pros: [], cons: [], complexity: 'medium' },
      alternatives: [],
      sections: [],
      openQuestions: [],
      acceptanceCriteria: ['Users can login'],
      createdAt: '2024-01-01',
    };
    
    const result = createFuxiContext('add login', designDoc, projectContext);
    
    expect(result.planName).toBe('add-login');
    expect(result.request).toBe('add login');
    expect(result.designDoc).toBeDefined();
    expect(result.projectContext.language).toBe('go');
  });
  
  it('should generate safe plan name from request', () => {
    const result = createFuxiContext(
      'Build User Authentication System!',
      { title: 'A', overview: '', context: '', requirements: [], chosenApproach: { id: '1', name: 'A', description: '', pros: [], cons: [], complexity: 'low' }, alternatives: [], sections: [], openQuestions: [], acceptanceCriteria: [], createdAt: '' },
      { projectName: 'p', language: 'ts', framework: null, projectType: 'cli', techStack: { languages: [], frameworks: [], buildTools: [], testing: [], linting: [] }, existingComponents: [], keyFiles: [] }
    );
    
    expect(result.planName).toBe('build-user-authentication-system');
    expect(result.planName).not.toContain('!');
  });
});

describe('TransitionResult interface', () => {
  it('should support proceed action', () => {
    const result: TransitionResult = {
      action: 'proceed',
      fuxiContext: { 
        planName: 'test', 
        request: 'test', 
        designDoc: null as any, 
        projectContext: null as any 
      },
    };
    
    expect(result.action).toBe('proceed');
    expect(result.fuxiContext).toBeDefined();
  });
  
  it('should support defer action', () => {
    const result: TransitionResult = {
      action: 'defer',
      designPath: '/path/to/design.md',
    };
    
    expect(result.action).toBe('defer');
    expect(result.designPath).toBe('/path/to/design.md');
  });
  
  it('should support exit action', () => {
    const result: TransitionResult = {
      action: 'exit',
    };
    
    expect(result.action).toBe('exit');
  });
});
