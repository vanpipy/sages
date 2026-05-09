"""pi_evaluator.comparator - Session comparison for trend analysis.

Compares two evaluation results to identify improvements or regressions.
"""

from __future__ import annotations

from pathlib import Path

from .config import Config
from .parser import Parser
from .types import ComparisonResult, EvaluationResult


class Comparator:
    """Comparator for analyzing differences between session evaluations."""

    def __init__(self, config: Config):
        """Initialize comparator.

        Args:
            config: Configuration object

        """
        self.config = config
        self.parser = Parser()

    def compare(
        self,
        entries1: list,
        entries2: list,
        session1_id: str = "session1",
        session2_id: str = "session2",
    ) -> ComparisonResult:
        """Compare two session evaluations.

        Args:
            entries1: First session entries
            entries2: Second session entries
            session1_id: Identifier for first session
            session2_id: Identifier for second session

        Returns:
            ComparisonResult with differences

        """
        # Evaluate both sessions
        evaluator = self._create_evaluator()
        result1 = evaluator.evaluate(entries1, session_id=session1_id)
        result2 = evaluator.evaluate(entries2, session_id=session2_id)

        return self.compare_results(result1, result2)

    def compare_results(
        self, result1: EvaluationResult, result2: EvaluationResult
    ) -> ComparisonResult:
        """Compare two evaluation results.

        Args:
            result1: First evaluation result
            result2: Second evaluation result

        Returns:
            ComparisonResult

        """
        # Calculate score difference
        score_diff = result2.overall.overall_score - result1.overall.overall_score

        # Calculate phase differences
        phase_diffs = {}
        for phase_name in result1.phases:
            score1 = result1.phases[phase_name].score
            score2 = result2.phases.get(phase_name, type("", (), {"score": 0})()).score
            phase_diffs[phase_name] = score2 - score1

        # Determine trend
        if score_diff > 5:
            trend = "IMPROVED"
        elif score_diff < -5:
            trend = "REGRESSION"
        else:
            trend = "STABLE"

        # Generate recommendations
        recommendations = []
        if trend == "IMPROVED":
            recommendations.append("Overall quality improved between sessions.")
        elif trend == "REGRESSION":
            recommendations.append("Quality regressed between sessions. Review changes.")
        else:
            recommendations.append("Quality remained stable between sessions.")

        # Phase-specific recommendations
        for phase, diff in phase_diffs.items():
            if diff > 10:
                recommendations.append(f"{phase.capitalize()} improved by {diff:.1f} points.")
            elif diff < -10:
                recommendations.append(f"{phase.capitalize()} regressed by {abs(diff):.1f} points.")

        return ComparisonResult(
            session1_id=result1.session_id,
            session2_id=result2.session_id,
            score_diff=score_diff,
            phase_diffs=phase_diffs,
            trend=trend,  # type: ignore
            recommendations=recommendations,
        )

    def compare_files(self, path1: Path, path2: Path) -> ComparisonResult:
        """Compare two session files.

        Args:
            path1: Path to first session.jsonl
            path2: Path to second session.jsonl

        Returns:
            ComparisonResult

        """
        entries1 = self.parser.parse(path1)
        entries2 = self.parser.parse(path2)

        return self.compare(
            entries1,
            entries2,
            session1_id=path1.parent.name,
            session2_id=path2.parent.name,
        )

    def _create_evaluator(self):
        """Create evaluator instance."""
        from .evaluator import Evaluator

        return Evaluator(self.config)
