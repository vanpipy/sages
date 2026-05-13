"""pi-evaluator: Auto-run and evaluate Four Sages Agents workflow sessions.

Example usage:
    from . import Runner, Parser, Evaluator, Config

    config = Config(output_dir="./evaluations")

    # Auto-run workflow
    runner = Runner(config)
    session_path = runner.run_workflow("Create REST API")

    # Evaluate
    parser = Parser()
    entries = parser.parse(session_path)

    evaluator = Evaluator(config)
    result = evaluator.evaluate(entries)
    print(f"Verdict: {result.verdict}")
    print(f"Score: {result.overall.overall_score}")
    print(f"Cost: ${result.overall.total_cost:.6f}")
"""

from .comparator import Comparator
from .config import Config, ConfigError, load_config
from .cost.analyzer import CostAnalyzer, CostMetrics, CostResult
from .env_checker import ValidationResult, validate_all, validate_or_exit
from .evaluator import Evaluator, EvaluatorError
from .parser import Parser, ParserError
from .reporter import Reporter
from .runner import Runner, RunnerError
from .scorer import Scorer
from .types import (
    ComparisonResult,
    ContentBlock,
    EvaluationResult,
    Message,
    OverallResult,
    Phase,
    PhaseMetrics,
    PhaseResult,
    SessionLogEntry,
)

__version__ = "0.1.0"
__author__ = "Four Sages Team"

__all__ = [
    # Core classes
    "Config",
    "Runner",
    "Parser",
    "Evaluator",
    "Scorer",
    "Reporter",
    "Comparator",
    # Cost analysis
    "CostAnalyzer",
    "CostMetrics",
    "CostResult",
    # Types
    "Phase",
    "SessionLogEntry",
    "Message",
    "ContentBlock",
    "PhaseResult",
    "PhaseMetrics",
    "OverallResult",
    "EvaluationResult",
    "ComparisonResult",
    # Exceptions
    "ConfigError",
    "ParserError",
    "RunnerError",
    "EvaluatorError",
    # Utilities
    "ValidationResult",
    "validate_all",
    "validate_or_exit",
    "load_config",
]
