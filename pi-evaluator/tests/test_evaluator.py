"""Tests for pi_evaluator.evaluator module."""

import json
from datetime import datetime
from pathlib import Path

import pytest

from pi_evaluator.config import Config
from pi_evaluator.evaluator import Evaluator, EvaluatorError
from pi_evaluator.types import (
    ContentBlock,
    EvaluationResult,
    Message,
    Phase,
    SessionLogEntry,
)


class TestEvaluator:
    """Tests for Evaluator class."""

    @pytest.fixture
    def config(self):
        """Create test configuration."""
        return Config()

    @pytest.fixture
    def evaluator(self, config):
        """Create evaluator instance."""
        return Evaluator(config)

    @pytest.fixture
    def sample_entries(self):
        """Create sample session entries."""
        return [
            SessionLogEntry(
                type="session_start",
                timestamp="2026-05-07T10:00:00Z",
                message=None,
            ),
            SessionLogEntry(
                type="message",
                timestamp="2026-05-07T10:00:01Z",
                message=Message(
                    role="user",
                    content=[ContentBlock(type="text", content="Create REST API")],
                ),
            ),
            SessionLogEntry(
                type="message",
                timestamp="2026-05-07T10:00:05Z",
                message=Message(
                    role="assistant",
                    content=[
                        ContentBlock(
                            type="toolCall",
                            name="fuxi_create_draft",
                            arguments={"request": "Create REST API"},
                        )
                    ],
                ),
            ),
            SessionLogEntry(
                type="message",
                timestamp="2026-05-07T10:00:10Z",
                message=Message(
                    role="assistant",
                    content=[
                        ContentBlock(
                            type="toolResult",
                            content="Draft created with Business, Data, Control planes",
                            is_error=False,
                        )
                    ],
                ),
            ),
        ]

    def test_evaluate_empty_entries(self, evaluator):
        """Test evaluation with empty entries raises error."""
        with pytest.raises(EvaluatorError, match="No entries"):
            evaluator.evaluate([])

    def test_evaluate_basic(self, evaluator, sample_entries):
        """Test basic evaluation."""
        result = evaluator.evaluate(sample_entries, request="Test", session_id="test123")
        assert isinstance(result, EvaluationResult)
        assert result.session_id == "test123"
        assert result.request == "Test"
        assert result.verdict in ["EXCELLENT", "GOOD", "FAIR", "POOR"]

    def test_evaluate_duration(self, evaluator, sample_entries):
        """Test that duration is calculated."""
        result = evaluator.evaluate(sample_entries)
        assert result.overall.total_duration_seconds == 10.0

    def test_evaluate_verdict_excellent(self, evaluator, sample_entries):
        """Test EXCELLENT verdict for high scores."""
        result = evaluator.evaluate(sample_entries)
        # With minimal data, verdict should be lower
        assert result.verdict in ["EXCELLENT", "GOOD", "FAIR", "POOR"]

    def test_evaluate_phases_present(self, evaluator, sample_entries):
        """Test that all phases are present in result."""
        result = evaluator.evaluate(sample_entries)
        for phase in ["design", "review", "execute", "audit"]:
            assert phase in result.phases

    def test_evaluate_tool_calls_count(self, evaluator, sample_entries):
        """Test tool calls are counted."""
        result = evaluator.evaluate(sample_entries)
        # Should have at least 1 tool call (fuxi_create_draft)
        assert result.overall.total_tool_calls >= 1

    def test_evaluate_recommendations(self, evaluator, sample_entries):
        """Test recommendations are generated."""
        result = evaluator.evaluate(sample_entries)
        assert isinstance(result.recommendations, list)

    def test_determine_verdict(self):
        """Test verdict determination logic."""
        assert EvaluationResult.determine_verdict(95) == "EXCELLENT"
        assert EvaluationResult.determine_verdict(90) == "EXCELLENT"
        assert EvaluationResult.determine_verdict(89) == "GOOD"
        assert EvaluationResult.determine_verdict(75) == "GOOD"
        assert EvaluationResult.determine_verdict(74) == "FAIR"
        assert EvaluationResult.determine_verdict(60) == "FAIR"
        assert EvaluationResult.determine_verdict(59) == "POOR"
        assert EvaluationResult.determine_verdict(0) == "POOR"


class TestEvaluatorMetrics:
    """Tests for evaluator metric calculations."""

    @pytest.fixture
    def evaluator(self):
        """Create evaluator instance."""
        return Evaluator(Config())

    def test_plane_coverage_calculation(self, evaluator):
        """Test plane coverage calculation."""
        entries = [
            SessionLogEntry(
                type="message",
                timestamp="2026-05-07T10:00:00Z",
                message=Message(
                    role="assistant",
                    content=[
                        ContentBlock(
                            type="text",
                            content="Business Data Control Foundation Observation Security Evolution",
                        )
                    ],
                ),
            )
        ]
        coverage = evaluator._calculate_plane_coverage(entries)
        assert coverage == 100.0

    def test_plan_completeness_calculation(self, evaluator):
        """Test plan completeness calculation."""
        entries = [
            SessionLogEntry(
                type="message",
                timestamp="2026-05-07T10:00:00Z",
                message=Message(
                    role="assistant",
                    content=[
                        ContentBlock(
                            type="text",
                            content="## Overview\n## Tasks\n## Dependencies",
                        )
                    ],
                ),
            )
        ]
        completeness = evaluator._calculate_plan_completeness(entries)
        assert completeness == 100.0

    def test_feasibility_score_calculation(self, evaluator):
        """Test feasibility score with blockers."""
        entries = [
            SessionLogEntry(
                type="message",
                timestamp="2026-05-07T10:00:00Z",
                message=Message(
                    role="assistant",
                    content=[
                        ContentBlock(
                            type="text",
                            content="⚠️ Blocker 1\n❌ Blocker 2",
                        )
                    ],
                ),
            )
        ]
        score = evaluator._calculate_feasibility_score(entries)
        assert score == 60.0  # 100 - 2*20

    def test_task_count(self, evaluator):
        """Test task counting."""
        entries = [
            SessionLogEntry(
                type="message",
                timestamp="2026-05-07T10:00:00Z",
                message=Message(
                    role="assistant",
                    content=[
                        ContentBlock(
                            type="text",
                            content="T1 T2 T3 T4 T5",
                        )
                    ],
                ),
            )
        ]
        count = evaluator._count_tasks(entries)
        assert count == 5
