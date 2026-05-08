# pi-evaluator Usage Guide

Auto-run and evaluate Four Sages Agents workflow sessions using HuggingFace `evaluate`.

## Quick Start

```bash
# Install
pip install -e .

# Check environment
pi-evaluator check-env

# Run and evaluate a workflow
pi-evaluator run "Create a REST API for user management"
```

## Commands

### check-env

Validate your environment before running evaluations.

```bash
pi-evaluator check-env
```

**Checks:**
- Python >= 3.10
- HuggingFace `evaluate` and `datasets` libraries
- `pi` binary availability
- Four Sages extension installation

**Output:**
```
✅ Python >= 3.10
✅ HuggingFace evaluate
✅ HuggingFace datasets
✅ pi binary
✅ Four Sages extension

  python_version: 3.12.4
  evaluate_version: 0.4.0
  datasets_version: 2.16.0
  pi_path: /home/user/.volta/bin/pi
```

---

### run

Run a workflow and evaluate the results.

```bash
pi-evaluator run "YOUR REQUEST"
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--no-auto-approve` | Disable auto-proceed (manual phase control) | Auto-proceed enabled |
| `--timeout SECONDS` | Workflow timeout | 3600 |
| `-o, --output-dir` | Output directory | `./evaluations` |
| `-c, --config FILE` | Config file path | None |
| `-v, --verbose` | Verbose output | False |

**Examples:**

```bash
# Basic run with auto-proceed
pi-evaluator run "Create a calculator module by python"

# Manual phase control
pi-evaluator run "Create calculator by typescript" --no-auto-approve

# Custom timeout
pi-evaluator run "Create calculator by go" --timeout 600

# Verbose output
pi-evaluator run "Create calculator" -vvv
```

**Output:**

```
Running workflow: Create a calculator module...
Codes directory: evaluations/codes/abc12345
Generated files in: evaluations/codes/abc12345
  - index.ts
  - index.test.ts
  - package.json
  - session.jsonl

Verdict: GOOD
Overall Score: 82.3
```

---

### evaluate

Evaluate an existing session log file.

```bash
pi-evaluator evaluate session.jsonl
```

**Options:**

| Flag | Description |
|------|-------------|
| `session` | Path to session.jsonl file |
| `--request TEXT` | Original request for reference |
| `-o, --output-dir` | Output directory |
| `-c, --config FILE` | Config file path |

**Examples:**

```bash
# Basic evaluation
pi-evaluator evaluate ./evaluations/sessions/abc12345/session.jsonl

# With original request
pi-evaluator evaluate session.jsonl --request "Create a REST API"

# Verbose
pi-evaluator evaluate session.jsonl -v
```

**Output (JSON):**

```json
{
  "session_id": "abc12345",
  "request": "Create a REST API",
  "timestamp": "2026-05-08T12:00:00Z",
  "verdict": "GOOD",
  "overall": {
    "overall_score": 82.3,
    "total_duration_seconds": 180.5,
    "total_tool_calls": 24,
    "total_errors": 2,
    "error_rate": 0.083
  },
  "phases": {
    "design": {"score": 85.0, "duration_seconds": 45.2},
    "review": {"score": 80.0, "duration_seconds": 30.1},
    "execute": {"score": 78.5, "duration_seconds": 80.0},
    "audit": {"score": 88.0, "duration_seconds": 25.2}
  },
  "recommendations": [
    "Execution: Score 78.5 is below target. Consider improving TDD compliance."
  ]
}
```

---

### compare

Compare two session evaluations to track quality trends.

```bash
pi-evaluator compare session1.jsonl session2.jsonl
```

**Options:**

| Flag | Description |
|------|-------------|
| `session1` | First (older) session file |
| `session2` | Second (newer) session file |
| `-o, --output-dir` | Output directory |
| `-c, --config FILE` | Config file path |

**Examples:**

```bash
# Compare two sessions
pi-evaluator compare baseline.jsonl current.jsonl

# Verbose
pi-evaluator compare s1.jsonl s2.jsonl -v
```

**Output (JSON):**

```json
{
  "session1_id": "baseline",
  "session2_id": "current",
  "score_diff": 5.2,
  "phase_diffs": {
    "design": 2.0,
    "review": 8.5,
    "execute": 3.2,
    "audit": 7.5
  },
  "trend": "IMPROVED",
  "recommendations": [
    "Review phase improved by 8.5 points",
    "Audit phase improved by 7.5 points"
  ]
}
```

---

## Configuration

The Four Sages workflow auto-proceeds based on tool completion.
Phases transition automatically without manual approval.

### Environment Variables

```bash
export PI_EVALUATOR_OUTPUT_DIR="./evaluations"
export PI_EVALUATOR_SESSION_SUBDIR="sessions"
export PI_EVALUATOR_EVALUATION_SUBDIR="evaluations"
export PI_EVALUATOR_PI_PATH="pi"
export PI_EVALUATOR_AUTO_APPROVE="true"
export PI_EVALUATOR_TIMEOUT="3600"
```

### Config File (YAML)

```yaml
# ~/.pi-evaluator.yaml or ./.pi-evaluator.yaml
output_dir: "./evaluations"
session_subdir: "sessions"
evaluation_subdir: "evaluations"
pi_path: "pi"
auto_proceed: true  # Auto-send next command when phase completes (no manual approval needed)
timeout: 3600
phase_weights:
  design: 0.3
  review: 0.2
  execute: 0.3
  audit: 0.2
```

### CLI Override

```bash
# Override output directory
pi-evaluator run "Test" -o /custom/output

# Use config file
pi-evaluator run "Test" -c ./config.yaml

# Combine options
pi-evaluator run "Test" -o ./eval -c config.yaml -vv
```

---

## Output Structure

```
evaluations/
└── codes/
    └── {session_id}/             # All generated artifacts (tracked in git)
        ├── index.ts             # Source code
        ├── index.test.ts        # Tests
        ├── package.json         # Project config
        ├── tsconfig.json
        ├── session.jsonl        # Session log for evaluation
        ├── .sages/             # Four Sages workflow
        │   ├── workspace/        # draft.md, plan.md, execution.yaml
        │   └── archive/         # Archived workflow snapshot
        └── node_modules/       # Dependencies (gitignored)
```

**Note**: The `codes/` directory is tracked in git to preserve generated code for inspection.

### evaluation.json

```json
{
  "session_id": "abc12345",
  "verdict": "GOOD",
  "overall_score": 82.3,
  "phases": {
    "design": {"score": 85.2, "metrics": {...}},
    "review": {"score": 80.0, "metrics": {...}},
    "execution": {"score": 79.5, "metrics": {...}},
    "audit": {"score": 92.0, "metrics": {...}}
  }
}
```

---

## Phase Scores & Metrics

### Design (Fuxi) - Weight: 30%

| Metric | Description |
|--------|-------------|
| `plane_coverage` | % of MDD planes with content (7 planes) |
| `content_depth` | Average lines per section |
| `cross_references` | Cross-plane link count |
| `decisions` | Key decisions documented |

### Review (QiaoChui) - Weight: 20%

| Metric | Description |
|--------|-------------|
| `plan_completeness` | % of sections complete |
| `feasibility_score` | 100 - (blockers × 20) |
| `task_count` | Number of tasks created |

### Execute (LuBan) - Weight: 30%

| Metric | Description |
|--------|-------------|
| `task_completion_rate` | % of tasks completed |
| `tdd_compliance` | % of tasks with RED→GREEN pattern |
| `error_recovery_rate` | % of errors recovered |
| `parallel_efficiency` | Actual vs expected parallelism |

### Audit (GaoYao) - Weight: 20%

| Metric | Description |
|--------|-------------|
| `quality_score` | % of checks passed |
| `security_pass_rate` | % of security checks passed |
| `test_coverage` | % of code covered by tests |

---

## Verdict Thresholds

| Verdict | Score Range |
|---------|-------------|
| EXCELLENT | >= 90 |
| GOOD | 75 - 89 |
| FAIR | 60 - 74 |
| POOR | < 60 |

---

## Python API

```python
from pi_evaluator import Config, Runner, Parser, Evaluator, Reporter

# Create config
config = Config(output_dir=Path("./evaluations"), verbose=True)

# Run workflow
runner = Runner(config)
session_path = runner.run_workflow("Create REST API")

# Evaluate
parser = Parser()
entries = parser.parse(session_path)

evaluator = Evaluator(config)
result = evaluator.evaluate(entries, request="Create REST API")

# Save report
reporter = Reporter(config.output_dir)
json_path, md_path = reporter.save_evaluation(result, config.get_evaluation_dir(runner.session_id))

print(f"Verdict: {result.verdict}")
print(f"Score: {result.overall.overall_score:.1f}")
```

---

## Common Use Cases

### CI/CD Integration

```bash
#!/bin/bash
# evaluate.sh

set -e

# Run workflow
pi-evaluator run "$1" -o ./evaluations

# Check verdict (fail if POOR)
verdict=$(cat evaluations/evaluations/*/evaluation.json | jq -r '.verdict')
if [ "$verdict" = "POOR" ]; then
    echo "Workflow quality below threshold"
    exit 1
fi
```

### Regression Testing

```bash
# Compare baseline vs current
pi-evaluator compare baseline.jsonl current.jsonl > comparison.json

# Extract trend
trend=$(cat comparison.json | jq -r '.trend')
if [ "$trend" = "REGRESSION" ]; then
    echo "Quality regression detected!"
    exit 1
fi
```

### Batch Evaluation

```bash
#!/bin/bash
# batch-evaluate.sh

for session in ./sessions/*/session.jsonl; do
    name=$(basename $(dirname $session))
    echo "Evaluating $name..."
    pi-evaluator evaluate "$session" -o ./reports --request "Batch test"
done
```

---

## Troubleshooting

### "pi binary not found"

```bash
# Find pi path
which pi

# Set path explicitly
export PI_EVALUATOR_PI_PATH="/path/to/pi"
```

### "evaluate library not installed"

```bash
pip install evaluate datasets
```

### Timeout errors

```bash
# Increase timeout
pi-evaluator run "Complex task" --timeout 7200
```

### Empty evaluation results

Check that session.jsonl exists and has valid JSONL format:
```bash
head -3 session.jsonl
```
