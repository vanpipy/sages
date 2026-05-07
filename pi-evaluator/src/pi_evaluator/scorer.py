"""
pi_evaluator.scorer - Score aggregation for evaluation results

Computes weighted scores for each phase and overall.
"""

from __future__ import annotations

from typing import Any, Dict

from pi_evaluator.config import Config
from pi_evaluator.types import Phase, PhaseMetrics


class Scorer:
    """
    Score aggregator for workflow evaluation.

    Computes weighted scores based on phase weights and metric values.
    """

    # Default weights for each phase
    DEFAULT_WEIGHTS = {
        Phase.DESIGN: {
            "plane_coverage": 0.30,
            "content_depth": 0.20,
            "cross_references": 0.20,
            "decisions": 0.30,
        },
        Phase.REVIEW: {
            "plan_completeness": 0.40,
            "feasibility_score": 0.30,
            "task_count": 0.30,
        },
        Phase.EXECUTE: {
            "task_completion_rate": 0.35,
            "tdd_compliance": 0.25,
            "error_recovery_rate": 0.20,
            "parallel_efficiency": 0.20,
        },
        Phase.AUDIT: {
            "quality_score": 0.40,
            "security_pass_rate": 0.30,
            "test_coverage": 0.30,
        },
    }

    def __init__(self, config: Config):
        """
        Initialize scorer.

        Args:
            config: Configuration object with phase weights
        """
        self.config = config
        self.phase_weights = config.phase_weights

    def compute_phase_score(self, phase: Phase, metrics: PhaseMetrics) -> float:
        """
        Compute weighted score for a phase.

        Args:
            phase: The phase being scored
            metrics: Phase metrics

        Returns:
            Score between 0-100
        """
        weights = self.DEFAULT_WEIGHTS.get(phase, {})
        if not weights:
            return 50.0  # Default score

        metrics_dict = metrics.to_dict()
        total_weight = sum(weights.values())

        if total_weight == 0:
            return 50.0

        weighted_sum = 0.0
        for key, weight in weights.items():
            value = metrics_dict.get(key, 0)
            # Normalize weight to account for custom weights
            normalized_weight = weight / total_weight
            weighted_sum += value * normalized_weight

        return min(100, max(0, weighted_sum))

    def compute_overall_score(self, phase_scores: Dict[str, float]) -> float:
        """
        Compute weighted overall score from phase scores.

        Args:
            phase_scores: Dictionary mapping phase name to score

        Returns:
            Overall score between 0-100
        """
        total_weight = sum(self.phase_weights.values())

        if total_weight == 0:
            return 0.0

        weighted_sum = 0.0
        for phase_name, score in phase_scores.items():
            weight = self.phase_weights.get(phase_name, 0)
            normalized_weight = weight / total_weight
            weighted_sum += score * normalized_weight

        return min(100, max(0, weighted_sum))

    def get_phase_contribution(
        self, phase: str, score: float, overall: float
    ) -> float:
        """
        Calculate how much a phase contributes to overall score.

        Args:
            phase: Phase name
            score: Phase score
            overall: Overall score

        Returns:
            Contribution percentage
        """
        weight = self.phase_weights.get(phase, 0)
        if overall == 0:
            return 0.0
        return (score * weight / overall) * 100 if overall > 0 else 0.0
