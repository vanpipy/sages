"""Tests for pi_evaluator.types module."""

import pytest
from pi_evaluator.types import (
    ContentBlock,
    EvaluationResult,
    Message,
    Phase,
    PhaseMetrics,
    SessionLogEntry,
)


class TestPhase:
    """Tests for Phase enum."""

    def test_phase_values(self):
        """Test Phase enum values."""
        assert Phase.DESIGN.value == "design"
        assert Phase.REVIEW.value == "review"
        assert Phase.EXECUTE.value == "execute"
        assert Phase.AUDIT.value == "audit"
        assert Phase.COMPLETE.value == "complete"


class TestContentBlock:
    """Tests for ContentBlock dataclass."""

    def test_tool_call_creation(self):
        """Test creating a tool call content block."""
        block = ContentBlock(
            type="toolCall",
            name="fuxi_create_draft",
            arguments={"request": "Create API"},
        )
        assert block.type == "toolCall"
        assert block.name == "fuxi_create_draft"
        assert block.arguments == {"request": "Create API"}

    def test_to_dict(self):
        """Test ContentBlock serialization."""
        block = ContentBlock(type="text", content="Hello")
        result = block.to_dict()
        assert result["type"] == "text"
        assert result["content"] == "Hello"

    def test_from_dict(self):
        """Test ContentBlock deserialization."""
        data = {"type": "toolResult", "content": "Done", "is_error": False}
        block = ContentBlock.from_dict(data)
        assert block.type == "toolResult"
        assert block.content == "Done"
        assert block.is_error is False


class TestMessage:
    """Tests for Message dataclass."""

    def test_get_tool_calls(self):
        """Test extracting tool calls from message."""
        block = ContentBlock(type="toolCall", name="test_tool")
        message = Message(role="assistant", content=[block])
        calls = message.get_tool_calls()
        assert len(calls) == 1
        assert calls[0].name == "test_tool"

    def test_get_errors(self):
        """Test extracting errors from message."""
        error_block = ContentBlock(type="toolResult", is_error=True)
        ok_block = ContentBlock(type="toolResult", is_error=False)
        message = Message(role="assistant", content=[error_block, ok_block])
        errors = message.get_errors()
        assert len(errors) == 1


class TestPhaseMetrics:
    """Tests for PhaseMetrics dataclass."""

    def test_defaults(self):
        """Test default metric values."""
        metrics = PhaseMetrics()
        assert metrics.plane_coverage == 0.0
        assert metrics.content_depth == 0.0
        assert metrics.decisions == 0

    def test_to_dict(self):
        """Test PhaseMetrics serialization."""
        metrics = PhaseMetrics(plane_coverage=85.0, decisions=5)
        result = metrics.to_dict()
        assert result["plane_coverage"] == 85.0
        assert result["decisions"] == 5


class TestEvaluationResult:
    """Tests for EvaluationResult dataclass."""

    def test_determine_verdict(self):
        """Test verdict determination."""
        assert EvaluationResult.determine_verdict(95) == "EXCELLENT"
        assert EvaluationResult.determine_verdict(85) == "GOOD"
        assert EvaluationResult.determine_verdict(65) == "FAIR"
        assert EvaluationResult.determine_verdict(50) == "POOR"

    def test_to_dict(self):
        """Test EvaluationResult serialization."""
        from pi_evaluator.types import OverallResult, PhaseResult

        result = EvaluationResult(
            session_id="test123",
            request="Test request",
            timestamp="2026-05-07T00:00:00Z",
            phases={},
            overall=OverallResult(
                total_duration_seconds=100.0,
                total_tool_calls=10,
                total_errors=1,
                error_rate=0.1,
            ),
            verdict="GOOD",
        )

        data = result.to_dict()
        assert data["session_id"] == "test123"
        assert data["verdict"] == "GOOD"
        assert data["overall"]["overall_score"] == 0.0
