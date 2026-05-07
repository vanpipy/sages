"""pi-evaluator: Auto-run and evaluate Four Sages Agents workflow sessions.

Example usage:
    from pi_evaluator import Runner, Parser, Evaluator, Config

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
"""

from pi_evaluator.comparator import Comparator
from pi_evaluator.config import Config, ConfigError, load_config
from pi_evaluator.env_checker import ValidationResult, validate_all, validate_or_exit
from pi_evaluator.evaluator import Evaluator, EvaluatorError
from pi_evaluator.parser import Parser, ParserError
from pi_evaluator.reporter import Reporter
from pi_evaluator.runner import Runner, RunnerError
from pi_evaluator.scorer import Scorer
from pi_evaluator.types import (
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
