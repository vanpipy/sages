# pi-evaluator

Auto-run and evaluate Four Sages Agents workflow sessions using HuggingFace `evaluate`.

## Features

- **Auto-run Mode**: Execute Four Sages workflows with automatic phase transitions
- **Auto-Proceed**: Detects tool completion and sends next command
- **Code Preservation**: All generated code saved to `evaluations/{id}/codes/` for inspection
- **Evaluate Mode**: Analyze existing session logs for quality metrics
- **Compare Mode**: Compare two sessions to track quality trends
- **Phase Metrics**: Per-phase quality assessment (Design, Review, Execute, Audit)
- **Configurable**: Environment variables, CLI args, and config file support

## Installation

```bash
pip install -e .
```

## Usage

See [USAGE.md](USAGE.md) for detailed command reference.

### Quick Start

```bash
# Check environment
pi-evaluator check-env

# Run and evaluate workflow
pi-evaluator run "Create a REST API"

# Generated code saved to evaluations/{id}/codes/
# Session log saved to evaluations/{id}/sessions/
# Evaluation report saved to evaluations/{id}/report/
```

## Output Directory Structure

```
evaluations/
└── {session_id}/
    ├── codes/              # Generated source code (tracked in git)
    │   ├── src/
    │   ├── tests/
    │   ├── package.json
    │   └── .sages/         # Four Sages workflow artifacts
    ├── sessions/           # Session logs (gitignored)
    │   └── session.jsonl
    └── report/             # Evaluation results (gitignored)
        ├── evaluation.json
        └── report.md
```

## Configuration

The Four Sages workflow auto-proceeds based on tool completion.
Phases transition automatically without manual approval.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_EVALUATOR_OUTPUT_DIR` | `./evaluations/` | Base output directory |
| `PI_EVALUATOR_PI_PATH` | `pi` | Path to pi binary |
| `PI_EVALUATOR_AUTO_APPROVE` | `true` | Auto-send next command (no manual approval) |
| `PI_EVALUATOR_TIMEOUT` | `3600` | Workflow timeout in seconds |

### Phase Weights

Default weights for overall score:
- Design: 30%
- Review: 20%
- Execute: 30%
- Audit: 20%

## Evaluation Result

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
codes_dir = runner.run_workflow("Create REST API")

print(f"Generated code in: {codes_dir}")

# Evaluate session log
session_log = config.get_session_path(runner.session_id)
parser = Parser()
entries = parser.parse(session_log)

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