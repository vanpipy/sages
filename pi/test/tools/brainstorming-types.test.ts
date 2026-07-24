import { describe, it, expect } from 'bun:test';
import type {
  BrainstormPhase,
  BrainstormParams,
  BrainstormContext,
  BrainstormResult,
  ProjectContext,
  IntentSpec,
  Approach,
  DesignSection,
  DesignDoc,
  ClarifyingQuestion,
  QuestionType,
} from '../../src/tools/brainstorming/types';

describe('BrainstormPhase', () => {
  it('should allow all valid phase values', () => {
    const phases: BrainstormPhase[] = [
      'exploring',
      'clarifying',
      'proposing',
      'designing',
      'approved',
      'rejected',
      'cancelled',
    ];
    
    expect(phases.length).toBe(7);
    phases.forEach(p => expect(typeof p).toBe('string'));
  });
});

describe('BrainstormParams', () => {
  it('should accept optional request', () => {
    const params: BrainstormParams = { request: 'add login feature' };
    expect(params.request).toBe('add login feature');
  });
  
  it('should accept optional context', () => {
    const params: BrainstormParams = { context: '/path/to/project' };
    expect(params.context).toBe('/path/to/project');
  });
  
  it('should allow empty params', () => {
    const params: BrainstormParams = {};
    expect(params.request).toBeUndefined();
    expect(params.context).toBeUndefined();
  });
});

describe('ProjectContext', () => {
  it('should require language and projectName', () => {
    const context: ProjectContext = {
      projectName: 'my-project',
      language: 'typescript',
      framework: 'react',
      projectType: 'web',
      techStack: {
        languages: ['TypeScript'],
        frameworks: ['React'],
        buildTools: ['vite'],
        testing: ['vitest'],
        linting: ['eslint'],
      },
      existingComponents: ['Button', 'Card'],
      keyFiles: [{ path: 'src/index.ts', purpose: 'Entry point' }],
    };
    
    expect(context.projectName).toBe('my-project');
    expect(context.language).toBe('typescript');
  });
  
  it('should allow null framework', () => {
    const context: ProjectContext = {
      projectName: 'simple-project',
      language: 'go',
      framework: null,
      projectType: 'cli',
      techStack: { languages: [], frameworks: [], buildTools: [], testing: [], linting: [] },
      existingComponents: [],
      keyFiles: [],
    };
    
    expect(context.framework).toBeNull();
  });
});

describe('IntentSpec', () => {
  it('should have required purpose field', () => {
    const intent: IntentSpec = {
      purpose: 'Add user authentication',
      constraints: ['Must work offline'],
      successCriteria: ['Users can log in'],
    };
    
    expect(intent.purpose).toBe('Add user authentication');
    expect(intent.constraints).toHaveLength(1);
    expect(intent.successCriteria).toHaveLength(1);
  });
  
  it('should have optional fields', () => {
    const intent: IntentSpec = {
      purpose: 'Add dark mode',
      constraints: [],
      successCriteria: [],
      targetUsers: ['All users'],
      priority: 'medium',
      notes: 'Consider system preference',
    };
    
    expect(intent.targetUsers).toEqual(['All users']);
    expect(intent.priority).toBe('medium');
    expect(intent.notes).toBe('Consider system preference');
  });
});

describe('Approach', () => {
  it('should support all complexity levels', () => {
    const low: Approach = {
      id: '1', name: 'A', description: 'A', pros: [], cons: [], complexity: 'low',
    };
    const medium: Approach = {
      id: '2', name: 'B', description: 'B', pros: [], cons: [], complexity: 'medium',
    };
    const high: Approach = {
      id: '3', name: 'C', description: 'C', pros: [], cons: [], complexity: 'high',
    };
    
    expect(low.complexity).toBe('low');
    expect(medium.complexity).toBe('medium');
    expect(high.complexity).toBe('high');
  });
  
  it('should mark recommended approach', () => {
    const approach: Approach = {
      id: '1',
      name: 'LocalStorage',
      description: 'Use browser storage',
      pros: ['Simple'],
      cons: ['Not synced'],
      complexity: 'low',
      recommended: true,
    };
    
    expect(approach.recommended).toBe(true);
  });
});

describe('DesignSection', () => {
  it('should track approval state', () => {
    const section: DesignSection = {
      id: '1',
      title: 'Architecture',
      content: 'Use layered architecture',
      order: 1,
      approved: false,
    };
    
    expect(section.approved).toBe(false);
    
    section.approved = true;
    section.approvedAt = new Date().toISOString();
    
    expect(section.approved).toBe(true);
    expect(section.approvedAt).toBeDefined();
  });
});

describe('DesignDoc', () => {
  it('should contain all required fields', () => {
    const doc: DesignDoc = {
      title: 'Login Feature Design',
      overview: 'Implement user authentication',
      context: 'Users need to log in to access features',
      requirements: ['Login form', 'Session management'],
      chosenApproach: {
        id: '1', name: 'JWT', description: 'Use JWT tokens', pros: [], cons: [], complexity: 'medium',
      },
      alternatives: [],
      sections: [],
      openQuestions: [],
      acceptanceCriteria: ['Users can log in'],
      createdAt: new Date().toISOString(),
    };
    
    expect(doc.title).toBe('Login Feature Design');
    expect(doc.chosenApproach.name).toBe('JWT');
    expect(doc.acceptanceCriteria).toHaveLength(1);
  });
});

describe('BrainstormResult', () => {
  it('should track success and phase', () => {
    const result: BrainstormResult = {
      success: true,
      phase: 'approved',
      metrics: {
        questionsAsked: 3,
        approachesProposed: 3,
        designSectionsCount: 4,
        approvalIterations: 1,
        durationMs: 5000,
        startedAt: '2024-01-01T00:00:00Z',
        endedAt: '2024-01-01T00:00:05Z',
      },
    };
    
    expect(result.success).toBe(true);
    expect(result.phase).toBe('approved');
    expect(result.metrics.questionsAsked).toBe(3);
  });
  
  it('should track transition decision', () => {
    const result: BrainstormResult = {
      success: true,
      phase: 'approved',
      transitionedTo: 'orchestrator',
      metrics: {
        questionsAsked: 0,
        approachesProposed: 0,
        designSectionsCount: 0,
        approvalIterations: 0,
        durationMs: 0,
        startedAt: '',
        endedAt: '',
      },
    };
    
    expect(result.transitionedTo).toBe('orchestrator');
  });
});

describe('ClarifyingQuestion', () => {
  it('should support multiple choice questions', () => {
    const question: ClarifyingQuestion = {
      id: 'q1',
      question: 'Which approach do you prefer?',
      type: 'multiple_choice',
      rationale: 'Need to understand preference',
      answered: false,
      options: [
        { value: 'a', label: 'Option A', recommended: true },
        { value: 'b', label: 'Option B' },
        { value: 'c', label: 'Option C' },
      ],
    };
    
    expect(question.type).toBe('multiple_choice');
    expect(question.options).toHaveLength(3);
    expect(question.options![0].recommended).toBe(true);
  });
  
  it('should support yes/no questions', () => {
    const question: ClarifyingQuestion = {
      id: 'q2',
      question: 'Should this be per-user or global?',
      type: 'yes_no',
      rationale: 'Affects storage strategy',
      answered: true,
      answer: 'yes',
    };
    
    expect(question.type).toBe('yes_no');
    expect(question.answered).toBe(true);
    expect(question.answer).toBe('yes');
  });
});

describe('QuestionType', () => {
  it('should support all question types', () => {
    const types: QuestionType[] = [
      'multiple_choice',
      'yes_no',
      'text',
      'scale',
    ];
    
    expect(types.length).toBe(4);
  });
});
