/**
 * Unit Tests for Draft Parser
 * Tests MDD (Multi-Dimensional Design) draft parsing
 */
import { describe, it, expect } from "bun:test";
import {
  parseDraft,
  validateDraft,
  generateTasksFromDraft,
  extractPlanName,
  getPlaneSummary,
  parseScenariosFromDraft,
  parseOutOfScopeFromDraft,
  type ParsedDraft
} from "@/utils/draft-parser";

describe("Draft Parser", () => {
  describe("parseDraft", () => {
    it("should parse overview section", () => {
      const content = `# System Design: Test Project

## Overview
Build a user authentication system with JWT tokens.
`;
      
      const result = parseDraft(content, "test-project");
      expect(result).not.toBeNull();
      expect(result?.intent).toContain("user authentication");
    });

    it("should parse Business Plane", () => {
      const content = `## Overview
Test

### 1. Business Plane

**Process**
- User registration
- User login

**Rules**
- Password must be 8+ characters
- Email must be valid
`;
      
      const result = parseDraft(content, "test");
      expect(result?.business).toBeDefined();
      expect(result?.business?.process).toContain("User registration");
      expect(result?.business?.rules).toContain("Password must be 8+ characters");
    });

    it("should parse Data Plane", () => {
      const content = `## Overview
Test

### 2. Data Plane

**Logic**
- Password hashing using bcrypt
- JWT token generation

**State**
- User session state
- Token expiry state
`;
      
      const result = parseDraft(content, "test");
      expect(result?.data).toBeDefined();
      expect(result?.data?.logic).toContain("Password hashing using bcrypt");
      expect(result?.data?.state).toContain("User session state");
    });

    it("should parse Control Plane", () => {
      const content = `## Overview
Test

### 3. Control Plane

**Strategy**
- Retry failed requests 3 times
- Circuit breaker for downstream services

**Distribution**
- API gateway routing
- Load balancer distribution
`;
      
      const result = parseDraft(content, "test");
      expect(result?.control).toBeDefined();
      expect(result?.control?.strategy).toContain("Retry failed requests 3 times");
      expect(result?.control?.distribution).toContain("API gateway routing");
    });

    it("should parse Foundation Plane", () => {
      const content = `## Overview
Test

### 4. Foundation Plane

**Resource**
- PostgreSQL database
- Redis cache
- Docker containers

**Abstraction**
- REST API endpoints
- GraphQL interface
`;
      
      const result = parseDraft(content, "test");
      expect(result?.foundation).toBeDefined();
      expect(result?.foundation?.resource).toContain("PostgreSQL database");
      expect(result?.foundation?.abstraction).toContain("REST API endpoints");
    });

    it("should parse Observation Plane", () => {
      const content = `## Overview
Test

### 5. Observation Plane

**Data**
- Request latency metrics
- Error rate tracking

**Analysis**
- Performance dashboards
- Alerting rules
`;
      
      const result = parseDraft(content, "test");
      expect(result?.observation).toBeDefined();
      expect(result?.observation?.data).toContain("Request latency metrics");
      expect(result?.observation?.analysis).toContain("Performance dashboards");
    });

    it("should parse Security Plane", () => {
      const content = `## Overview
Test

### 6. Security Plane

**Identity**
- User authentication
- OAuth2 provider integration

**Permissions**
- Role-based access control
- Resource-level permissions
`;
      
      const result = parseDraft(content, "test");
      expect(result?.security).toBeDefined();
      expect(result?.security?.identity).toContain("User authentication");
      expect(result?.security?.permissions).toContain("Role-based access control");
    });

    it("should parse Evolution Plane", () => {
      const content = `## Overview
Test

### 7. Evolution Plane

**Time**
- Version 1.0 - MVP
- Version 2.0 - Enhanced features

**Change**
- Database migrations
- API versioning strategy
`;
      
      const result = parseDraft(content, "test");
      expect(result?.evolution).toBeDefined();
      expect(result?.evolution?.time).toContain("Version 1.0 - MVP");
      expect(result?.evolution?.change).toContain("Database migrations");
    });

    it("should parse cross-plane dependencies", () => {
      const content = `## Overview
Test

## Cross-Plane Dependencies
- Business → needs → Data Plane
- Data → feeds → Observation Plane
`;
      
      const result = parseDraft(content, "test");
      expect(result?.crossPlaneDependencies).toBeDefined();
      expect(result?.crossPlaneDependencies?.length).toBeGreaterThan(0);
    });

    it("should parse key decisions", () => {
      const content = `## Overview
Test

## Key Design Decisions
- Use JWT for authentication
- PostgreSQL for data storage
- Redis for caching
`;
      
      const result = parseDraft(content, "test");
      expect(result?.keyDecisions).toBeDefined();
      expect(result?.keyDecisions?.length).toBeGreaterThan(0);
    });

    it("should return null for empty content", () => {
      const result = parseDraft("", "empty");
      expect(result).toBeNull();
    });

    it("should return null for placeholder-only content", () => {
      const content = `## Overview
{Define intent}

### 1. Business Plane
- None specified
`;
      
      const result = parseDraft(content, "placeholder");
      // Should be null due to placeholder detection
      expect(result).toBeNull();
    });
  });

  describe("validateDraft", () => {
    it("should validate complete draft", () => {
      const content = `# System Design: Test

## Overview
Build auth system

### 1. Business Plane
**Process**
- Login

### 2. Data Plane
**Logic**
- JWT generation

### 3. Control Plane
**Strategy**
- Retry logic

### 4. Foundation Plane
**Resource**
- Database

### 5. Observation Plane
**Data**
- Metrics

### 6. Security Plane
**Identity**
- Auth

### 7. Evolution Plane
**Time**
- v1.0
`;
      
      const validation = validateDraft(content);
      expect(validation.valid).toBe(true);
      expect(validation.issues.length).toBe(0);
    });

    it("should detect missing overview", () => {
      const content = `### 1. Business Plane
Process
`;
      
      const validation = validateDraft(content);
      expect(validation.issues).toContain("Missing Overview section");
    });

    it("should detect insufficient planes", () => {
      const content = `## Overview
Test

### 1. Business Plane
Process
`;
      
      const validation = validateDraft(content);
      expect(validation.issues.some(i => i.includes("planes"))).toBe(true);
    });

    it("should detect excessive placeholders", () => {
      const content = `# System Design: Test

## Overview
Test

### 1. Business Plane
- None specified
- None specified
- None specified
- None specified
- None specified
- None specified
`;
      
      const validation = validateDraft(content);
      expect(validation.issues.some(i => i.includes("placeholder"))).toBe(true);
    });

    it("should allow 3+ planes", () => {
      const content = `# System Design: Test

## Overview
Test

### 1. Business Plane
**Process**
- Process A

### 2. Data Plane
**Logic**
- Logic A

### 3. Control Plane
**Strategy**
- Strategy A
`;
      
      const validation = validateDraft(content);
      expect(validation.issues.filter(i => i.includes("planes"))).toHaveLength(0);
    });
  });

  describe("generateTasksFromDraft", () => {
    it("should generate Foundation tasks first", () => {
      const draft: ParsedDraft = {
        name: "test",
        intent: "Test",
        foundation: {
          resource: ["PostgreSQL database"],
          abstraction: ["REST API"],
        },
      };
      
      const tasks = generateTasksFromDraft(draft);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0].plane).toBe("Foundation");
    });

    it("should set correct priorities", () => {
      const draft: ParsedDraft = {
        name: "test",
        intent: "Test",
        foundation: { resource: ["DB"], abstraction: ["API"] },
        business: { process: ["Login"], rules: ["Auth"] },
        observation: { data: ["Metrics"], analysis: ["Dashboards"] },
      };
      
      const tasks = generateTasksFromDraft(draft);
      const foundationTasks = tasks.filter(t => t.plane === "Foundation");
      const observationTasks = tasks.filter(t => t.plane === "Observation");
      
      // Foundation tasks should have higher priority
      const foundationPriority = { high: 0, medium: 1, low: 2 };
      const observationPriority = { high: 0, medium: 1, low: 2 };
      
      expect(foundationTasks[0].priority).toBe("high");
      expect(observationTasks[0].priority).toBe("low");
    });

    it("should respect dependencies", () => {
      const draft: ParsedDraft = {
        name: "test",
        intent: "Test",
        foundation: { resource: ["DB"], abstraction: ["API"] },
        data: { logic: ["Query builder"], state: ["State machine"] },
      };
      
      const tasks = generateTasksFromDraft(draft);
      const dataTask = tasks.find(t => t.plane === "Data");
      
      expect(dataTask?.dependsOn.length).toBeGreaterThan(0);
    });

    it("should generate minimum tasks", () => {
      const draft: ParsedDraft = {
        name: "test",
        intent: "",
      };
      
      const tasks = generateTasksFromDraft(draft);
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("extractPlanName", () => {
    it("should extract name from header", () => {
      const content = `# System Design: User Authentication API`;
      
      const name = extractPlanName(content);
      expect(name).toBe("User Authentication API");
    });

    it("should return null for missing header", () => {
      const content = `## Overview
Some content
`;
      
      const name = extractPlanName(content);
      expect(name).toBeNull();
    });

    it("should trim whitespace", () => {
      const content = `# System Design:   Auth API  `;
      
      const name = extractPlanName(content);
      expect(name).toBe("Auth API");
    });
  });

  describe("getPlaneSummary", () => {
    it("should count Business plane items", () => {
      const draft: ParsedDraft = {
        name: "test",
        intent: "",
        business: {
          process: ["Login", "Logout", "Register"],
          rules: ["Password policy"],
        },
      };
      
      const summary = getPlaneSummary(draft);
      expect(summary.Business).toBe(4); // 3 process + 1 rule
    });

    it("should count all plane items", () => {
      const draft: ParsedDraft = {
        name: "test",
        intent: "",
        business: { process: ["A"], rules: ["B"] },
        data: { logic: ["C"], state: ["D"] },
        control: { strategy: ["E"], distribution: ["F"] },
        foundation: { resource: ["G"], abstraction: ["H"] },
        observation: { data: ["I"], analysis: ["J"] },
        security: { identity: ["K"], permissions: ["L"] },
        evolution: { time: ["M"], change: ["N"] },
      };
      
      const summary = getPlaneSummary(draft);
      
      expect(summary.Business).toBe(2);
      expect(summary.Data).toBe(2);
      expect(summary.Control).toBe(2);
      expect(summary.Foundation).toBe(2);
      expect(summary.Observation).toBe(2);
      expect(summary.Security).toBe(2);
      expect(summary.Evolution).toBe(2);
    });

    it("should handle missing planes", () => {
      const draft: ParsedDraft = {
        name: "test",
        intent: "",
      };
      
      const summary = getPlaneSummary(draft);
      
      expect(summary.Business).toBe(0);
      expect(summary.Data).toBe(0);
      expect(summary.Foundation).toBe(0);
    });
  });

  describe("MDD Planes", () => {
    it("should have all 7 MDD planes", () => {
      const planes = [
        "Business",
        "Data",
        "Control",
        "Foundation",
        "Observation",
        "Security",
        "Evolution",
      ];
      
      expect(planes.length).toBe(7);
    });

    it("should have two elements per plane", () => {
      const planeElements: Record<string, string[]> = {
        Business: ["Process", "Rules"],
        Data: ["Logic", "State"],
        Control: ["Strategy", "Distribution"],
        Foundation: ["Resource", "Abstraction"],
        Observation: ["Data", "Analysis"],
        Security: ["Identity", "Permissions"],
        Evolution: ["Time", "Change"],
      };
      
      Object.values(planeElements).forEach(elements => {
        expect(elements.length).toBe(2);
      });
    });
  });

  describe("placeholder detection", () => {
    it("should detect {Define} placeholders", () => {
      const isPlaceholder = (text: string) =>
        text.includes("{") && text.includes("}");
      
      expect(isPlaceholder("{Define intent}")).toBe(true);
      expect(isPlaceholder("Real content")).toBe(false);
    });

    it("should detect 'define' keyword", () => {
      const isPlaceholder = (text: string) =>
        text.toLowerCase().includes("define");
      
      expect(isPlaceholder("Define the logic")).toBe(true);
      expect(isPlaceholder("Implement the logic")).toBe(false);
    });

    it("should detect 'todo' keyword", () => {
      const isPlaceholder = (text: string) =>
        text.toLowerCase().includes("todo");
      
      expect(isPlaceholder("TODO: Implement")).toBe(true);
      expect(isPlaceholder("Implementation done")).toBe(false);
    });

    it("should detect 'tbd' keyword", () => {
      const isPlaceholder = (text: string) =>
        text.toLowerCase().includes("tbd");
      
      expect(isPlaceholder("TBD: Content")).toBe(true);
      expect(isPlaceholder("Final content")).toBe(false);
    });

    it("should detect 'none specified'", () => {
      const isPlaceholder = (text: string) =>
        text.toLowerCase().includes("none specified");

      expect(isPlaceholder("None specified")).toBe(true);
      expect(isPlaceholder("Some requirement")).toBe(false);
    });
  });
});

describe("parseScenariosFromDraft", () => {
  it("should parse all Given/When/Then scenarios from draft", () => {
    const content = `# System Design: auth

## Scenarios

> Given/When/Then specifications

### Scenario: happy path
**Given** user has valid credentials
**When** user submits login form
**Then** user is logged in

### Scenario: invalid input
**Given** user has empty fields
**When** user submits login form
**Then** error is shown
**But** form is not submitted
`;

    const scenarios = parseScenariosFromDraft(content);
    expect(scenarios.length).toBe(2);
    expect(scenarios[0].name).toBe("happy path");
    expect(scenarios[0].given).toBe("user has valid credentials");
    expect(scenarios[0].when).toBe("user submits login form");
    expect(scenarios[0].then).toBe("user is logged in");
    expect(scenarios[1].but).toBe("form is not submitted");
  });

  it("should return empty array when no Scenarios section", () => {
    const content = `# System Design: empty

## Overview
No scenarios here.
`;
    const scenarios = parseScenariosFromDraft(content);
    expect(scenarios).toEqual([]);
  });

  it("should preserve order of scenarios as they appear in draft", () => {
    const content = `## Scenarios

### Scenario: first
**Given** A
**When** B
**Then** C

### Scenario: second
**Given** D
**When** E
**Then** F
`;
    const scenarios = parseScenariosFromDraft(content);
    expect(scenarios.map(s => s.name)).toEqual(["first", "second"]);
  });
});

describe("parseOutOfScopeFromDraft", () => {
  it("should extract Out of Scope list items", () => {
    const content = `# System Design: test

## Out of Scope

- src/services/auth.ts
- src/stores/authStore.ts
- src/routes/RootNavigator.tsx
`;
    const items = parseOutOfScopeFromDraft(content);
    expect(items).toEqual([
      "src/services/auth.ts",
      "src/stores/authStore.ts",
      "src/routes/RootNavigator.tsx",
    ]);
  });

  it("should return empty array when no Out of Scope section", () => {
    const content = `# System Design: test

## Overview
Nothing here.
`;
    expect(parseOutOfScopeFromDraft(content)).toEqual([]);
  });

  it("should skip FILL IN placeholder items", () => {
    const content = `## Out of Scope

- _FILL IN: should this change touch utils/?_
- src/important.ts
`;
    const items = parseOutOfScopeFromDraft(content);
    // FILL IN lines are not actual scope decisions; agent must fill them in
    expect(items).toEqual(["src/important.ts"]);
  });
});
