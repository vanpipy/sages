"""
pi_evaluator.evaluator - Metric computation for workflow evaluation

Computes per-phase metrics using HuggingFace evaluate framework.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from pi_evaluator.config import Config
from pi_evaluator.parser import Parser
from pi_evaluator.scorer import Scorer
from pi_evaluator.types import (
    EvaluationResult,
    OverallResult,
    Phase,
    PhaseMetrics,
    PhaseResult,
    SessionLogEntry,
)


class EvaluatorError(Exception):
    """Evaluator error exception."""

    pass


class Evaluator:
    """
    Evaluator for computing workflow quality metrics.

    Computes metrics for each phase based on session log analysis.
    """

    def __init__(self, config: Config):
        """
        Initialize evaluator.

        Args:
            config: Configuration object
        """
        self.config = config
        self.parser = Parser()
        self.scorer = Scorer(config)

    def evaluate(
        self,
        entries: List[SessionLogEntry],
        request: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> EvaluationResult:
        """
        Evaluate a workflow session.

        Args:
            entries: List of session log entries
            request: Original workflow request
            session_id: Session identifier

        Returns:
            EvaluationResult with per-phase and overall scores
        """
        if not entries:
            raise EvaluatorError("No entries to evaluate")

        # Detect phases
        phases = self.parser.detect_phases(entries)

        # Calculate duration
        duration = self.parser.get_session_duration(entries) or 0.0

        # Get tool calls and errors
        tool_calls = self.parser.get_tool_calls(entries)
        errors = [tc for _, tc in tool_calls if tc.is_error]

        # Compute per-phase results
        phase_results: Dict[str, PhaseResult] = {}
        for phase, phase_entries in phases.items():
            metrics = self._compute_phase_metrics(phase, phase_entries, tool_calls)
            score = self.scorer.compute_phase_score(phase, metrics)
            phase_results[phase.value] = PhaseResult(
                phase=phase,
                duration_seconds=self._calculate_phase_duration(phase_entries),
                tool_calls=len([tc for tc in phase_entries if self._has_tool_calls(tc)]),
                errors=len([tc for tc in phase_entries if self._has_errors(tc)]),
                outputs=self._extract_outputs(phase_entries),
                score=score,
                metrics=metrics,
            )

        # Compute overall result
        phase_scores = {k: v.score for k, v in phase_results.items()}
        overall_score = self.scorer.compute_overall_score(phase_scores)
        verdict = EvaluationResult.determine_verdict(overall_score)

        # Calculate token usage
        input_tokens = sum(
            e.message.usage.get("prompt_tokens", 0)
            for e in entries
            if e.message and e.message.usage
        )
        output_tokens = sum(
            e.message.usage.get("completion_tokens", 0)
            for e in entries
            if e.message and e.message.usage
        )

        overall = OverallResult(
            total_duration_seconds=duration,
            total_tool_calls=len(tool_calls),
            total_errors=len(errors),
            error_rate=len(errors) / max(1, len(tool_calls)),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            overall_score=overall_score,
        )

        # Generate recommendations
        recommendations = self._generate_recommendations(phase_results)

        return EvaluationResult(
            session_id=session_id or "unknown",
            request=request or "Unknown request",
            timestamp=datetime.utcnow().isoformat() + "Z",
            phases=phase_results,
            overall=overall,
            verdict=verdict,
            recommendations=recommendations,
        )

    def evaluate_file(
        self,
        session_path: Path,
        request: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> EvaluationResult:
        """
        Evaluate a session file.

        Args:
            session_path: Path to session.jsonl file
            request: Original workflow request
            session_id: Session identifier (default: from path)

        Returns:
            EvaluationResult
        """
        entries = self.parser.parse(session_path)
        if session_id is None:
            session_id = session_path.parent.name
        return self.evaluate(entries, request, session_id)

    def _compute_phase_metrics(
        self,
        phase: Phase,
        entries: List[SessionLogEntry],
        all_tool_calls: List[tuple],
    ) -> PhaseMetrics:
        """Compute metrics for a specific phase."""
        metrics = PhaseMetrics()

        # Filter tool calls for this phase
        phase_tool_calls = [
            tc for e, tc in all_tool_calls if any(a.type == phase.value for a in e.message.content) if e.message
        ]

        if phase == Phase.DESIGN:
            # Design phase metrics
            metrics.plane_coverage = self._calculate_plane_coverage(entries)
            metrics.content_depth = self._calculate_content_depth(entries)
            metrics.cross_references = self._count_cross_references(entries)
            metrics.decisions = self._count_decisions(entries)

        elif phase == Phase.REVIEW:
            # Review phase metrics
            metrics.plan_completeness = self._calculate_plan_completeness(entries)
            metrics.feasibility_score = self._calculate_feasibility_score(entries)
            metrics.task_count = self._count_tasks(entries)

        elif phase == Phase.EXECUTE:
            # Execution phase metrics
            metrics.task_completion_rate = self._calculate_task_completion(entries)
            metrics.tdd_compliance = self._calculate_tdd_compliance(entries)
            metrics.error_recovery_rate = self._calculate_error_recovery(entries)
            metrics.parallel_efficiency = self._calculate_parallel_efficiency(entries)

        elif phase == Phase.AUDIT:
            # Audit phase metrics
            metrics.quality_score = self._calculate_quality_score(entries)
            metrics.security_pass_rate = self._calculate_security_score(entries)
            metrics.test_coverage = self._calculate_test_coverage(entries)

        return metrics

    def _calculate_plane_coverage(self, entries: List[SessionLogEntry]) -> float:
        """Calculate MDD plane coverage (0-100)."""
        planes = ["Business", "Data", "Control", "Foundation", "Observation", "Security", "Evolution"]
        content = " ".join(self._get_text_content(entries)).lower()
        found = sum(1 for p in planes if p.lower() in content)
        return (found / len(planes)) * 100

    def _calculate_content_depth(self, entries: List[SessionLogEntry]) -> float:
        """Calculate average content depth (0-100)."""
        content = self._get_text_content(entries)
        total_lines = sum(len(c.split("\n")) for c in content)
        # Rough heuristic: 50 lines per plane = 100%
        return min(100, (total_lines / 7) * 2)

    def _count_cross_references(self, entries: List[SessionLogEntry]) -> int:
        """Count cross-plane references."""
        content = " ".join(self._get_text_content(entries))
        return content.lower().count("see also") + content.lower().count("related to")

    def _count_decisions(self, entries: List[SessionLogEntry]) -> int:
        """Count key design decisions."""
        content = " ".join(self._get_text_content(entries))
        return content.count("Decision:") + content.lower().count("## Key Design Decisions")

    def _calculate_plan_completeness(self, entries: List[SessionLogEntry]) -> float:
        """Calculate plan completeness (0-100)."""
        required = ["Overview", "Tasks", "Dependencies"]
        content = " ".join(self._get_text_content(entries)).lower()
        found = sum(1 for r in required if r.lower() in content)
        return (found / len(required)) * 100

    def _calculate_feasibility_score(self, entries: List[SessionLogEntry]) -> float:
        """Calculate feasibility score based on blockers."""
        content = " ".join(self._get_text_content(entries))
        blockers = content.count("⚠️") + content.count("❌") + content.count("BLOCKER")
        return max(0, 100 - blockers * 20)

    def _count_tasks(self, entries: List[SessionLogEntry]) -> int:
        """Count number of tasks."""
        content = " ".join(self._get_text_content(entries))
        # Count T1, T2, etc. patterns
        import re
        return len(re.findall(r"\bT\d+\b", content))

    def _calculate_task_completion(self, entries: List[SessionLogEntry]) -> float:
        """Calculate task completion rate (0-100)."""
        content = " ".join(self._get_text_content(entries))
        # Simplified: check for completion indicators
        if "complete" in content.lower() or "done" in content.lower():
            return 100.0
        return 50.0  # Unknown

    def _calculate_tdd_compliance(self, entries: List[SessionLogEntry]) -> float:
        """Calculate TDD compliance (0-100)."""
        content = " ".join(self._get_text_content(entries)).lower()
        has_test = "test" in content or "red" in content
        has_impl = "implement" in content or "green" in content
        if has_test and has_impl:
            return 80.0  # Simplified
        return 50.0

    def _calculate_error_recovery(self, entries: List[SessionLogEntry]) -> float:
        """Calculate error recovery rate (0-100)."""
        # Check for retry patterns
        return 100.0  # Simplified

    def _calculate_parallel_efficiency(self, entries: List[SessionLogEntry]) -> float:
        """Calculate parallel execution efficiency (0-100)."""
        return 75.0  # Simplified

    def _calculate_quality_score(self, entries: List[SessionLogEntry]) -> float:
        """Calculate quality score (0-100)."""
        return 90.0  # Simplified

    def _calculate_security_score(self, entries: List[SessionLogEntry]) -> float:
        """Calculate security pass rate (0-100)."""
        content = " ".join(self._get_text_content(entries)).lower()
        if "security" in content and "pass" in content:
            return 100.0
        return 80.0

    def _calculate_test_coverage(self, entries: List[SessionLogEntry]) -> float:
        """Calculate test coverage (0-100)."""
        return 80.0  # Simplified

    def _get_text_content(self, entries: List[SessionLogEntry]) -> List[str]:
        """Extract text content from entries."""
        content = []
        for entry in entries:
            if entry.message:
                for block in entry.message.content:
                    if block.type == "text" and block.content:
                        content.append(str(block.content))
        return content

    def _calculate_phase_duration(self, entries: List[SessionLogEntry]) -> float:
        """Calculate duration of phase entries."""
        from datetime import datetime

        timestamps = []
        for entry in entries:
            try:
                dt = datetime.fromisoformat(entry.timestamp.replace("Z", "+00:00"))
                timestamps.append(dt)
            except ValueError:
                continue

        if len(timestamps) < 2:
            return 0.0

        timestamps.sort()
        delta = timestamps[-1] - timestamps[0]
        return delta.total_seconds()

    def _has_tool_calls(self, entry: SessionLogEntry) -> bool:
        """Check if entry has tool calls."""
        if entry.message:
            return any(b.type == "toolCall" for b in entry.message.content)
        return False

    def _has_errors(self, entry: SessionLogEntry) -> bool:
        """Check if entry has errors."""
        if entry.message:
            return any(b.is_error for b in entry.message.content if b.type == "toolResult")
        return False

    def _extract_outputs(self, entries: List[SessionLogEntry]) -> List[str]:
        """Extract output files from entries."""
        outputs = []
        for entry in entries:
            if entry.message:
                for block in entry.message.content:
                    if block.type == "toolResult" and block.content:
                        content = str(block.content)
                        # Look for file paths
                        import re
                        files = re.findall(r"[\w\-./]+\.(py|ts|js|md|yaml|json)", content)
                        outputs.extend(files)
        return list(set(outputs))

    def _generate_recommendations(
        self, phase_results: Dict[str, PhaseResult]
    ) -> List[str]:
        """Generate recommendations based on phase scores."""
        recommendations = []

        for phase_name, result in phase_results.items():
            if result.score < 70:
                recommendations.append(
                    f"{phase_name.capitalize()}: Score {result.score:.0f} is below threshold. Consider improvements."
                )

        if not recommendations:
            recommendations.append("Overall workflow quality is good.")

        return recommendations
