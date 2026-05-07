# pi-evaluator

Auto-run and evaluate Four Sages Agents workflow sessions using HuggingFace `evaluate`.

## Features

- **Auto-run Mode**: Execute Four Sages workflows with automatic phase approvals
- **Evaluate Mode**: Analyze existing session logs for quality metrics
- **Compare Mode**: Compare two sessions to track quality trends
- **Phase Metrics**: Per-phase quality assessment (Design, Review, Execute, Audit)
- **Configurable**: Environment variables, CLI args, and config file support

## Installation

```bash
pip install -e .
```

## Usage

### Check Environment

```bash
pi-evaluator check-env
```

### Run and Evaluate Workflow

```bash
pi-evaluator run "Create a REST API with FastAPI"
```

### Evaluate Existing Session

```bash
pi-evaluator evaluate session.jsonl
```

### Compare Two Sessions

```bash
pi-evaluator compare session1.jsonl session2.jsonl
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_EVALUATOR_OUTPUT_DIR` | `./evaluations/` | Base output directory |
| `PI_EVALUATOR_SESSION_SUBDIR` | `sessions/` | Session logs subdirectory |
| `PI_EVALUATOR_EVALUATION_SUBDIR` | `evaluations/` | Evaluation reports subdirectory |
| `PI_EVALUATOR_PI_PATH` | `pi` | Path to pi binary |
| `PI_EVALUATOR_AUTO_APPROVE` | `true` | Enable auto-approve |
| `PI_EVALUATOR_TIMEOUT` | `3600` | Workflow timeout in seconds |

### Phase Weights

Default weights for overall score:
- Design: 30%
- Review: 20%
- Execute: 30%
- Audit: 20%

## Output

### Directory Structure

```
{output_dir}/
├── sessions/
│   └── {session_id}/
│       └── session.jsonl
└── evaluations/
    └── {session_id}/
        ├── evaluation.json
        └── report.md
```

### Evaluation Result

```json
{
  "session_id": "019e008a",
  "verdict": "GOOD",
  "overall_score": 85.4,
  "phases": {
    "design": {"score": 85.2},
    "review": {"score": 88.0},
    "execution": {"score": 79.5},
    "audit": {"score": 92.0}
  }
}
```

## Python API

```python
from pi_evaluator import Runner, Parser, Evaluator, Config

config = Config(output_dir="./evaluations")

# Run workflow
runner = Runner(config)
session_path = runner.run_workflow("Create REST API")

# Evaluate
parser = Parser()
entries = parser.parse(session_path)

evaluator = Evaluator(config)
result = evaluator.evaluate(entries)

print(f"Verdict: {result.verdict}")
print(f"Score: {result.overall.overall_score}")
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Format code
ruff format .
```

## License

MIT
