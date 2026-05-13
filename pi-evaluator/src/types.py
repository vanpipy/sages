"""pi_evaluator.types - Data type definitions for pi-evaluator.

This module contains all dataclass definitions for:
- Session parsing (SessionLogEntry, Message, ContentBlock)
- Evaluation results (PhaseResult, PhaseMetrics, OverallResult, EvaluationResult)
- Enums (Phase)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal


class Phase(Enum):
    """Workflow phases in Four Sages execution."""

    IDLE = "idle"
    DESIGN = "design"  # Fuxi creates draft
    REVIEW = "review"  # QiaoChui reviews and decomposes
    EXECUTE = "execute"  # LuBan executes tasks with TDD
    AUDIT = "audit"  # GaoYao audits quality
    COMPLETE = "complete"  # Workflow finished


# Phase tool patterns for detection
PHASE_TOOL_PATTERNS: dict[Phase, list[str]] = {
    Phase.DESIGN: ["fuxi_create_draft", "fuxi_get_draft", "fuxi_get_status"],
    Phase.REVIEW: ["qiaochui_review", "qiaochui_decompose"],
    Phase.EXECUTE: ["luban_execute_task", "luban_execute_all", "luban_get_status"],
    Phase.AUDIT: ["gaoyao_review", "gaoyao_check_security"],
}


def detect_phase(tool_name: str) -> Phase | None:
    """Detect phase from tool name."""
    for phase, tools in PHASE_TOOL_PATTERNS.items():
        if tool_name in tools:
            return phase
    return None


@dataclass
class ContentBlock:
    """Content block within a message.

    Types:
    - toolCall: Tool invocation with name and arguments
    - toolResult: Response from tool execution
    - text: Plain text content
    - thinking: Internal reasoning (if present)
    """

    type: Literal["toolCall", "toolResult", "text", "thinking"]
    name: str | None = None  # Tool name for toolCall
    arguments: dict[str, Any] | None = None  # Tool args for toolCall
    content: Any | None = None  # Content varies by type
    is_error: bool | None = None  # Error flag for toolResult

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dictionary for JSON output."""
        return {
            "type": self.type,
            "name": self.name,
            "arguments": self.arguments,
            "content": self.content,
            "is_error": self.is_error,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ContentBlock:
        """Deserialize from dictionary."""
        return cls(
            type=data["type"],
            name=data.get("name"),
            arguments=data.get("arguments"),
            content=data.get("content"),
            is_error=data.get("is_error"),
        )


@dataclass
class Message:
    """A message in the session log.

    Represents either a user message, assistant response, or system event.
    """

    role: Literal["user", "assistant", "system"]
    content: list[ContentBlock] = field(default_factory=list)
    usage: dict[str, int] | None = None  # {"prompt_tokens": N, "completion_tokens": M}

    def get_tool_calls(self) -> list[ContentBlock]:
        """Extract all tool calls from message content."""
        return [b for b in self.content if b.type == "toolCall"]

    def get_errors(self) -> list[ContentBlock]:
        """Extract all error tool results from message content."""
        return [b for b in self.content if b.type == "toolResult" and b.is_error]

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "content": [b.to_dict() for b in self.content],
            "usage": self.usage,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Message:
        """Deserialize from dictionary."""
        content = [ContentBlock.from_dict(b) for b in data.get("content", [])]
        return cls(
            role=data["role"],
            content=content,
            usage=data.get("usage"),
        )


@dataclass
class SessionLogEntry:
    """A single entry in the session JSONL file.

    JSONL format: one JSON object per line
    Example:
        {"type": "message", "timestamp": "2026-05-07T12:00:00Z", "message": {...}}
        {"type": "model_change", "timestamp": "...", "provider": "deepseek", "modelId": "..."}
    """

    type: Literal["message", "session_start", "session_end", "model_change"]
    timestamp: str  # ISO 8601 format
    message: Message | None = None
    # Additional fields for model_change entries
    provider: str | None = None
    model_id: str | None = None

    @classmethod
    def from_jsonl_line(cls, line: str) -> SessionLogEntry:
        """Parse a single line from JSONL file."""
        data = json.loads(line.strip())
        entry_type = data.get("type", "")
        
        # Handle various entry types (pi session format and legacy format)
        if entry_type == "session":
            return cls(
                type="session_start",
                timestamp=data.get("timestamp", ""),
                message=None,
            )
        elif entry_type == "session_start":
            return cls(
                type="session_start",
                timestamp=data.get("timestamp", ""),
                message=None,
            )
        elif entry_type == "session_end":
            return cls(
                type="session_end",
                timestamp=data.get("timestamp", ""),
                message=None,
            )
        elif entry_type == "model_change":
            return cls(
                type="model_change",
                timestamp=data.get("timestamp", ""),
                message=None,
                provider=data.get("provider"),
                model_id=data.get("modelId"),
            )
        elif entry_type == "thinking_level_change":
            return cls(
                type="thinking_level_change",
                timestamp=data.get("timestamp", ""),
                message=None,
            )
        
        # For message type, extract the nested message field (pi format)
        # or use content directly (legacy format)
        message = None
        if entry_type == "message":
            if data.get("message"):
                # pi session format with nested message field
                msg_data = data["message"]
                content = []
                
                for block in msg_data.get("content", []):
                    block_type = block.get("type")
                    if block_type == "toolCall":
                        content.append(ContentBlock(
                            type="toolCall",
                            name=block.get("name"),
                            arguments=block.get("arguments"),
                            content=None,
                        ))
                    elif block_type == "toolResult":
                        content.append(ContentBlock(
                            type="toolResult",
                            name=block.get("name"),
                            content=block.get("content"),
                            is_error=block.get("isError", False),
                        ))
                    elif block_type == "text":
                        content.append(ContentBlock(
                            type="text",
                            content=block.get("text"),
                        ))
                    elif block_type == "thinking":
                        content.append(ContentBlock(
                            type="thinking",
                            content=block.get("thinking"),
                        ))
                
                # Handle usage - pi uses input/output, convert to prompt_tokens/completion_tokens
                usage = msg_data.get("usage", {})
                if usage and "input" in usage:
                    usage = {
                        "prompt_tokens": usage.get("input", 0),
                        "completion_tokens": usage.get("output", 0),
                    }
                
                message = Message(
                    role=msg_data.get("role", ""),
                    content=content,
                    usage=usage if usage else None,
                )
            elif data.get("content"):
                # Legacy simple format with content field
                message = Message(role="user", content=[
                    ContentBlock(type="text", content=data["content"])
                ])
        
        return cls(
            type=entry_type if entry_type == "message" else "message",
            timestamp=data.get("timestamp", ""),
            message=message,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "timestamp": self.timestamp,
            "message": self.message.to_dict() if self.message else None,
        }


@dataclass
class PhaseMetrics:
    """Detailed metrics for a single phase."""

    # Design phase metrics (Fuxi)
    plane_coverage: float = 0.0  # % of MDD planes with content
    content_depth: float = 0.0  # Average lines per section
    cross_references: int = 0  # Cross-plane link count
    decisions: int = 0  # Key decisions documented

    # Review phase metrics (QiaoChui)
    plan_completeness: float = 0.0  # % of sections complete
    feasibility_score: float = 0.0  # 100 - blocker_count * 20
    task_count: int = 0  # Number of tasks

    # Execution phase metrics (LuBan)
    task_completion_rate: float = 0.0  # % of tasks completed
    tdd_compliance: float = 0.0  # % of tasks with RED→GREEN pattern
    error_recovery_rate: float = 0.0  # % of errors recovered
    parallel_efficiency: float = 0.0  # Actual vs expected parallelism

    # Audit phase metrics (GaoYao)
    quality_score: float = 0.0  # % of checks passed
    security_pass_rate: float = 0.0  # % of security checks passed
    test_coverage: float = 0.0  # % of code covered by tests

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@dataclass
class PhaseResult:
    """Evaluation result for a single phase."""

    phase: Phase
    duration_seconds: float
    tool_calls: int
    errors: int
    outputs: list[str] = field(default_factory=list)  # Files created/modified
    score: float = 0.0  # 0-100
    metrics: PhaseMetrics = field(default_factory=PhaseMetrics)
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "phase": self.phase.value,
            "duration_seconds": self.duration_seconds,
            "tool_calls": self.tool_calls,
            "errors": self.errors,
            "outputs": self.outputs,
            "score": self.score,
            "metrics": self.metrics.to_dict(),
            "details": self.details,
        }


@dataclass
class OverallResult:
    """Aggregate metrics across all phases."""

    total_duration_seconds: float
    total_tool_calls: int
    total_errors: int
    error_rate: float  # total_errors / total_tool_calls
    input_tokens: int = 0
    output_tokens: int = 0
    overall_score: float = 0.0  # Weighted average of phase scores
    
    # Cost metrics
    total_cost: float = 0.0  # Total cost in USD
    cost_per_quality: float = 0.0  # Cost per quality point
    efficiency_rating: str = "unknown"  # excellent/good/fair/poor

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_duration_seconds": self.total_duration_seconds,
            "total_tool_calls": self.total_tool_calls,
            "total_errors": self.total_errors,
            "error_rate": round(self.error_rate, 3),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "overall_score": round(self.overall_score, 1),
            "total_cost_usd": round(self.total_cost, 6),
            "cost_per_quality_point": round(self.cost_per_quality, 6),
            "efficiency_rating": self.efficiency_rating,
        }


@dataclass
class EvaluationResult:
    """Complete evaluation result for a workflow session.

    This is the primary output of the evaluation process.
    """

    session_id: str
    request: str
    timestamp: str  # Evaluation timestamp
    phases: dict[str, PhaseResult]  # Per-phase results keyed by phase name
    overall: OverallResult
    verdict: Literal["EXCELLENT", "GOOD", "FAIR", "POOR"]
    recommendations: list[str] = field(default_factory=list)

    # Verdict thresholds
    VERDICT_THRESHOLDS: dict[str, int] = field(
        default_factory=lambda: {
            "EXCELLENT": 90,
            "GOOD": 75,
            "FAIR": 60,
            "POOR": 0,
        }
    )

    @staticmethod
    def determine_verdict(score: float) -> str:
        """Determine verdict based on overall score."""
        thresholds = {"EXCELLENT": 90, "GOOD": 75, "FAIR": 60, "POOR": 0}
        for verdict, threshold in thresholds.items():
            if score >= threshold:
                return verdict
        return "POOR"

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "request": self.request,
            "timestamp": self.timestamp,
            "phases": {k: v.to_dict() for k, v in self.phases.items()},
            "overall": self.overall.to_dict(),
            "verdict": self.verdict,
            "recommendations": self.recommendations,
        }


@dataclass
class ComparisonResult:
    """Result of comparing two session evaluations."""

    session1_id: str
    session2_id: str
    score_diff: float
    phase_diffs: dict[str, float]
    trend: Literal["IMPROVED", "REGRESSION", "STABLE"]
    recommendations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "session1_id": self.session1_id,
            "session2_id": self.session2_id,
            "score_diff": round(self.score_diff, 1),
            "phase_diffs": {k: round(v, 1) for k, v in self.phase_diffs.items()},
            "trend": self.trend,
            "recommendations": self.recommendations,
        }
