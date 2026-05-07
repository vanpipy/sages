"""Tests for pi_evaluator.reporter module."""

import json
from pathlib import Path

import pytest

from pi_evaluator.reporter import Reporter
from pi_evaluator.types import (
    EvaluationResult,
    OverallResult,
    Phase,
    PhaseMetrics,
    PhaseResult,
)


class TestReporter:
    """Tests for Reporter class."""

    @pytest.fixture
    def reporter(self, tmp_path):
        """Create reporter instance."""
        return Reporter(output_dir=tmp_path)

    @pytest.fixture
    def sample_result(self):
        """Create sample evaluation result."""
        return EvaluationResult(
            session_id="test123",
            request="Create REST API",
            timestamp="2026-05-07T10:00:00Z",
            phases={
                "design": PhaseResult(
                    phase=Phase.DESIGN,
                    duration_seconds=45.0,
                    tool_calls=3,
                    errors=0,
                    outputs=["draft.md"],
                    score=85.0,
                    metrics=PhaseMetrics(plane_coverage=100.0),
                ),
                "review": PhaseResult(
                    phase=Phase.REVIEW,
                    duration_seconds=30.0,
                    tool_calls=2,
                    errors=0,
                    outputs=["plan.md"],
                    score=88.0,
                    metrics=PhaseMetrics(plan_completeness=95.0),
                ),
                "execute": PhaseResult(
                    phase=Phase.EXECUTE,
                    duration_seconds=180.0,
                    tool_calls=12,
                    errors=1,
                    outputs=["src/main.py"],
                    score=79.0,
                    metrics=PhaseMetrics(task_completion_rate=100.0),
                ),
                "audit": PhaseResult(
                    phase=Phase.AUDIT,
                    duration_seconds=25.0,
                    tool_calls=2,
                    errors=0,
                    outputs=["audit.md"],
                    score=92.0,
                    metrics=PhaseMetrics(quality_score=95.0),
                ),
            },
            overall=OverallResult(
                total_duration_seconds=280.0,
                total_tool_calls=19,
                total_errors=1,
                error_rate=0.053,
                overall_score=85.0,
            ),
            verdict="GOOD",
            recommendations=["Improve test coverage", "Consider async execution"],
        )

    def test_generate_json(self, reporter, sample_result):
        """Test JSON generation."""
        json_str = reporter.generate_json(sample_result)
        data = json.loads(json_str)
        assert data["session_id"] == "test123"
        assert data["verdict"] == "GOOD"
        assert data["overall"]["overall_score"] == 85.0

    def test_generate_markdown(self, reporter, sample_result):
        """Test Markdown generation."""
        md = reporter.generate_markdown(sample_result)
        assert "# Evaluation Report: test123" in md
        assert "**Verdict**: 🔵 GOOD" in md
        assert "| Phase | Score |" in md
        assert "Design | 85.0 |" in md
        assert "Improve test coverage" in md

    def test_save_evaluation(self, reporter, sample_result, tmp_path):
        """Test saving evaluation to files."""
        json_path, md_path = reporter.save_evaluation(sample_result)
        assert json_path.exists()
        assert md_path.exists()

        # Verify JSON content
        with open(json_path) as f:
            data = json.load(f)
            assert data["session_id"] == "test123"

        # Verify Markdown content
        with open(md_path) as f:
            content = f.read()
            assert "test123" in content

    def test_markdown_verdict_emojis(self, reporter):
        """Test verdict emoji mapping in markdown."""
        result = EvaluationResult(
            session_id="test",
            request="test",
            timestamp="2026-05-07T10:00:00Z",
            phases={},
            overall=OverallResult(
                total_duration_seconds=0,
                total_tool_calls=0,
                total_errors=0,
                error_rate=0,
                overall_score=85,
            ),
            verdict="GOOD",
        )
        md = reporter.generate_markdown(result)
        assert "🔵 GOOD" in md


class TestReporterComparison:
    """Tests for comparison report generation."""

    @pytest.fixture
    def reporter(self):
        """Create reporter instance."""
        return Reporter()

    def test_generate_comparison_markdown(self, reporter):
        """Test comparison markdown generation."""
        from pi_evaluator.types import ComparisonResult

        comparison = ComparisonResult(
            session1_id="session1",
            session2_id="session2",
            score_diff=5.0,
            phase_diffs={"design": 10.0, "review": -5.0, "execute": 5.0, "audit": 0.0},
            trend="IMPROVED",
            recommendations=["Overall quality improved"],
        )

        md = reporter.generate_comparison_markdown(comparison)
        assert "# Comparison Report: session1 vs session2" in md
        assert "📈 IMPROVED" in md
        assert "+5.0" in md
        assert "Overall quality improved" in md
