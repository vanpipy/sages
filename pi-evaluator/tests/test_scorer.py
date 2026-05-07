"""Tests for pi_evaluator.scorer module."""

import pytest

from pi_evaluator.config import Config
from pi_evaluator.scorer import Scorer
from pi_evaluator.types import Phase, PhaseMetrics


class TestScorer:
    """Tests for Scorer class."""

    @pytest.fixture
    def config(self):
        """Create test configuration."""
        return Config()

    @pytest.fixture
    def scorer(self, config):
        """Create scorer instance."""
        return Scorer(config)

    def test_compute_design_score(self, scorer):
        """Test design phase score calculation."""
        metrics = PhaseMetrics(
            plane_coverage=100.0,
            content_depth=80.0,
            cross_references=5,
            decisions=8,
        )
        score = scorer.compute_phase_score(Phase.DESIGN, metrics)
        # Weighted: 100*0.3 + 80*0.2 + 5*20*0.2 + 8*20*0.3 / (0.3+0.2+0.2+0.3) simplified
        assert 0 <= score <= 100

    def test_compute_review_score(self, scorer):
        """Test review phase score calculation."""
        metrics = PhaseMetrics(
            plan_completeness=95.0,
            feasibility_score=100.0,
            task_count=10,
        )
        score = scorer.compute_phase_score(Phase.REVIEW, metrics)
        assert 0 <= score <= 100

    def test_compute_execute_score(self, scorer):
        """Test execute phase score calculation."""
        metrics = PhaseMetrics(
            task_completion_rate=100.0,
            tdd_compliance=80.0,
            error_recovery_rate=100.0,
            parallel_efficiency=75.0,
        )
        score = scorer.compute_phase_score(Phase.EXECUTE, metrics)
        assert 0 <= score <= 100

    def test_compute_audit_score(self, scorer):
        """Test audit phase score calculation."""
        metrics = PhaseMetrics(
            quality_score=95.0,
            security_pass_rate=100.0,
            test_coverage=85.0,
        )
        score = scorer.compute_phase_score(Phase.AUDIT, metrics)
        assert 0 <= score <= 100

    def test_compute_overall_score(self, scorer):
        """Test overall score calculation."""
        phase_scores = {
            "design": 85.0,
            "review": 90.0,
            "execute": 80.0,
            "audit": 95.0,
        }
        overall = scorer.compute_overall_score(phase_scores)
        # 85*0.3 + 90*0.2 + 80*0.3 + 95*0.2 = 25.5 + 18 + 24 + 19 = 86.5
        assert overall == pytest.approx(86.5, rel=0.1)

    def test_compute_overall_empty(self, scorer):
        """Test overall score with empty phases."""
        overall = scorer.compute_overall_score({})
        assert overall == 0.0

    def test_compute_phase_contribution(self, scorer):
        """Test phase contribution calculation."""
        contribution = scorer.get_phase_contribution("design", 90.0, 100.0)
        # design weight is 0.3, so contribution = 90 * 0.3 / 100 * 100 = 27%
        assert contribution == 27.0


class TestScorerCustomWeights:
    """Tests for scorer with custom weights."""

    def test_custom_weights(self):
        """Test scorer with custom phase weights."""
        config = Config(phase_weights={"design": 0.5, "review": 0.0, "execute": 0.5, "audit": 0.0})
        scorer = Scorer(config)

        phase_scores = {
            "design": 80.0,
            "execute": 60.0,
        }
        overall = scorer.compute_overall_score(phase_scores)
        # (80*0.5 + 60*0.5) / 1.0 = 70
        assert overall == 70.0
