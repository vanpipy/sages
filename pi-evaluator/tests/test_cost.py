"""Tests for pi_evaluator.cost module."""

import pytest

from src.cost.analyzer import (
    CostAnalyzer,
    CostMetrics,
    CostResult,
    EFFICIENCY_THRESHOLDS,
    get_efficiency_rating,
)
from src.types import SessionLogEntry, Message, Phase


class TestCostAnalyzer:
    """Tests for CostAnalyzer class."""

    @pytest.fixture
    def analyzer(self):
        """Create cost analyzer instance."""
        return CostAnalyzer()

    @pytest.fixture
    def sample_entries(self):
        """Create sample entries with cost data."""
        return [
            SessionLogEntry(
                type="model_change",
                timestamp="2026-05-09T10:00:00Z",
                model_id="deepseek-v4-flash",
            ),
            SessionLogEntry(
                type="message",
                timestamp="2026-05-09T10:00:01Z",
                message=Message(
                    role="assistant",
                    usage={
                        "input": 1000,
                        "output": 500,
                        "totalTokens": 1500,
                        "cost": {
                            "input": 0.00027,
                            "output": 0.00055,
                            "total": 0.00082,
                        },
                    },
                ),
            ),
            SessionLogEntry(
                type="message",
                timestamp="2026-05-09T10:00:02Z",
                message=Message(
                    role="assistant",
                    usage={
                        "input": 2000,
                        "output": 1000,
                        "totalTokens": 3000,
                        "cost": {
                            "input": 0.00054,
                            "output": 0.00110,
                            "total": 0.00164,
                        },
                    },
                ),
            ),
        ]

    def test_analyze_extracts_total_cost(self, analyzer, sample_entries):
        """Test that total cost is extracted correctly."""
        phases = {Phase.DESIGN: [sample_entries[1]], Phase.REVIEW: [sample_entries[2]]}
        result = analyzer.analyze(sample_entries, phases, quality_score=85.0)

        assert result.metrics.total_cost == pytest.approx(0.00246, rel=1e-5)

    def test_analyze_extracts_tokens(self, analyzer, sample_entries):
        """Test that token counts are extracted correctly."""
        phases = {}
        result = analyzer.analyze(sample_entries, phases, quality_score=85.0)

        assert result.metrics.input_tokens == 3000
        assert result.metrics.output_tokens == 1500
        assert result.metrics.total_tokens == 4500

    def test_analyze_detects_model(self, analyzer, sample_entries):
        """Test that model is detected from model_change entry."""
        phases = {}
        result = analyzer.analyze(sample_entries, phases, quality_score=85.0)

        assert result.model == "deepseek-v4-flash"

    def test_analyze_cost_per_quality(self, analyzer, sample_entries):
        """Test cost per quality point calculation."""
        phases = {}
        result = analyzer.analyze(sample_entries, phases, quality_score=85.0)

        expected = 0.00246 / 85
        assert result.cost_per_quality == pytest.approx(expected, rel=1e-5)

    def test_analyze_efficiency_rating_excellent(self, analyzer, sample_entries):
        """Test excellent efficiency rating for low cost per point."""
        phases = {}
        result = analyzer.analyze(sample_entries, phases, quality_score=85.0)

        assert result.efficiency_rating == "excellent"

    def test_analyze_cost_by_phase(self, analyzer, sample_entries):
        """Test cost per phase calculation."""
        phases = {
            Phase.DESIGN: [sample_entries[1]],
            Phase.REVIEW: [sample_entries[2]],
        }
        result = analyzer.analyze(sample_entries, phases, quality_score=85.0)

        assert "design" in result.metrics.cost_by_phase
        assert "review" in result.metrics.cost_by_phase
        assert result.metrics.cost_by_phase["design"] == pytest.approx(0.00082, rel=1e-5)

    def test_analyze_empty_entries(self, analyzer):
        """Test analysis with no entries."""
        phases = {}
        result = analyzer.analyze([], phases, quality_score=0)

        assert result.metrics.total_cost == 0.0
        assert result.model == "unknown"
        # Zero cost = excellent (free is best!)
        assert result.efficiency_rating == "excellent"

    def test_analyze_cache_hit_rate(self, analyzer):
        """Test cache hit rate calculation."""
        entries = [
            SessionLogEntry(
                type="message",
                timestamp="2026-05-09T10:00:01Z",
                message=Message(
                    role="assistant",
                    usage={
                        "input": 10000,
                        "output": 1000,
                        "cacheRead": 5000,
                        "cost": {"total": 0.01},
                    },
                ),
            ),
        ]
        phases = {}
        result = analyzer.analyze(entries, phases, quality_score=85.0)

        assert result.metrics.cache_hit_rate == pytest.approx(0.5, rel=1e-3)


class TestCostMetrics:
    """Tests for CostMetrics dataclass."""

    def test_to_dict(self):
        """Test serialization to dictionary."""
        metrics = CostMetrics(
            total_cost=0.123456,
            input_tokens=1000,
            output_tokens=500,
        )

        result = metrics.to_dict()

        assert result["total_cost"] == pytest.approx(0.123456, rel=1e-5)
        assert result["input_tokens"] == 1000
        assert result["output_tokens"] == 500


class TestCostResult:
    """Tests for CostResult dataclass."""

    def test_to_dict(self):
        """Test serialization to dictionary."""
        metrics = CostMetrics(total_cost=0.05)
        result = CostResult(
            metrics=metrics,
            model="deepseek-v4-flash",
            cost_per_quality=0.0005,
            efficiency_rating="excellent",
        )

        data = result.to_dict()

        assert data["model"] == "deepseek-v4-flash"
        assert data["cost_per_quality_point"] == pytest.approx(0.0005, rel=1e-5)
        assert data["efficiency_rating"] == "excellent"


class TestEfficiencyThresholds:
    """Tests for efficiency thresholds."""

    def test_excellent_threshold(self):
        """Test excellent rating threshold."""
        assert get_efficiency_rating(0.0001) == "excellent"
        assert get_efficiency_rating(0.0004) == "excellent"

    def test_good_threshold(self):
        """Test good rating threshold."""
        assert get_efficiency_rating(0.0006) == "good"
        assert get_efficiency_rating(0.0019) == "good"

    def test_fair_threshold(self):
        """Test fair rating threshold."""
        assert get_efficiency_rating(0.0021) == "fair"
        assert get_efficiency_rating(0.0049) == "fair"

    def test_poor_threshold(self):
        """Test poor rating threshold."""
        assert get_efficiency_rating(0.0051) == "poor"
        assert get_efficiency_rating(0.0100) == "poor"
