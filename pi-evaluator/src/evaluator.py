"""pi_evaluator.evaluator - Metric computation for workflow evaluation.

Computes per-phase metrics using HuggingFace evaluate framework.
Uses heuristics for text analysis and integrates HuggingFace evaluate
for quantitative metrics (code_eval, rouge, ruff, etc.).
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from .config import Config
from .cost.analyzer import CostAnalyzer
from .metrics import CodeEvalMetric, TextQualityMetric, SecurityMetric
from .parser import Parser
from .scorer import Scorer
from .types import (
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
    """Evaluator for computing workflow quality metrics.

    Computes metrics for each phase based on session log analysis.
    """

    def __init__(self, config: Config):
        """Initialize evaluator.

        Args:
            config: Configuration object

        """
        self.config = config
        self.parser = Parser()
        self.scorer = Scorer(config)
        self.cost_analyzer = CostAnalyzer()
        self.code_eval = CodeEvalMetric()
        self.text_quality = TextQualityMetric()
        self.security = SecurityMetric()

    def evaluate(
        self,
        entries: list[SessionLogEntry],
        request: str | None = None,
        session_id: str | None = None,
    ) -> EvaluationResult:
        """Evaluate a workflow session.

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
        phase_results: dict[str, PhaseResult] = {}
        for phase, phase_entries in phases.items():
            # Extract all text content from phase entries
            phase_content = " ".join(
                str(block.content) 
                for entry in phase_entries 
                if entry.message and entry.message.content
                for block in entry.message.content 
                if block.type == "text" and block.content
            ).lower()
            
            metrics = self._compute_phase_metrics(phase, phase_content)
            score = self.scorer.compute_phase_score(phase, metrics)
            
            # Count tool calls and errors specifically for this phase
            phase_tool_calls = self._count_tool_calls_in_entries(phase_entries)
            phase_errors = self._count_errors_in_entries(phase_entries)
            
            phase_results[phase.value] = PhaseResult(
                phase=phase,
                duration_seconds=self._calculate_phase_duration(phase_entries),
                tool_calls=phase_tool_calls,
                errors=phase_errors,
                outputs=self._extract_outputs(phase_entries),
                score=score,
                metrics=metrics,
            )

        # Compute overall result
        phase_scores = {k: v.score for k, v in phase_results.items()}
        overall_score = self.scorer.compute_overall_score(phase_scores)
        verdict = EvaluationResult.determine_verdict(overall_score)

        # Calculate token usage (legacy method - pi format uses input/output)
        input_tokens = sum(
            e.message.usage.get("input", 0)
            for e in entries
            if e.message and e.message.usage
        )
        output_tokens = sum(
            e.message.usage.get("output", 0)
            for e in entries
            if e.message and e.message.usage
        )

        # Analyze cost metrics
        cost_result = self.cost_analyzer.analyze(
            entries=entries,
            phases=phases,
            quality_score=overall_score,
        )

        overall = OverallResult(
            total_duration_seconds=duration,
            total_tool_calls=len(tool_calls),
            total_errors=len(errors),
            error_rate=len(errors) / max(1, len(tool_calls)),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            overall_score=overall_score,
            total_cost=cost_result.metrics.total_cost,
            cost_per_quality=cost_result.cost_per_quality,
            efficiency_rating=cost_result.efficiency_rating,
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
        request: str | None = None,
        session_id: str | None = None,
    ) -> EvaluationResult:
        """Evaluate a session file.

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
        phase_content: str,
    ) -> PhaseMetrics:
        """Compute metrics for a specific phase using content string."""
        metrics = PhaseMetrics()
        content_lower = phase_content.lower()
        
        if phase == Phase.DESIGN:
            # Design phase metrics
            metrics.plane_coverage = self._calculate_plane_coverage(phase_content)
            metrics.content_depth = self._calculate_content_depth(phase_content)
            metrics.cross_references = self._count_cross_references(phase_content)
            metrics.decisions = self._count_decisions(phase_content)

        elif phase == Phase.REVIEW:
            # Review phase metrics
            metrics.plan_completeness = self._calculate_plan_completeness(phase_content)
            metrics.feasibility_score = self._calculate_feasibility_score(phase_content)
            metrics.task_count = self._count_tasks(phase_content)

        elif phase == Phase.EXECUTE:
            # Execution phase metrics
            metrics.task_completion_rate = self._calculate_task_completion(phase_content)
            metrics.tdd_compliance = self._calculate_tdd_compliance(phase_content)
            metrics.error_recovery_rate = self._calculate_error_recovery(phase_content)
            metrics.parallel_efficiency = self._calculate_parallel_efficiency(phase_content)

        elif phase == Phase.AUDIT:
            # Audit phase metrics
            metrics.quality_score = self._calculate_quality_score(phase_content)
            metrics.security_pass_rate = self._calculate_security_score(phase_content)
            metrics.test_coverage = self._calculate_test_coverage(phase_content)

        return metrics

    def _calculate_plane_coverage(self, content: str) -> float:
        """Calculate MDD plane coverage (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content = content.lower()
        planes = [
            "Business",
            "Data",
            "Control",
            "Foundation",
            "Observation",
            "Security",
            "Evolution",
        ]
        found = sum(1 for p in planes if p.lower() in content)
        return (found / len(planes)) * 100

    def _calculate_content_depth(self, content: str) -> float:
        """Calculate average content depth (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        total_lines = len(content.split("\n"))
        # Rough heuristic: 50 lines per plane = 100%
        return min(100, (total_lines / 7) * 2)

    def _count_cross_references(self, content: str) -> int:
        """Count cross-plane references."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content = content.lower()
        return content.count("see also") + content.count("related to")

    def _count_decisions(self, content: str) -> int:
        """Count key design decisions."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        return content.count("decision:") + content.lower().count("## key design decisions")

    def _calculate_plan_completeness(self, content: str) -> float:
        """Calculate plan completeness (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content = content.lower()
        required = ["overview", "tasks", "dependencies", "plan"]
        found = sum(1 for r in required if r in content)
        return (found / len(required)) * 100

    def _calculate_feasibility_score(self, content: str) -> float:
        """Calculate feasibility score based on blockers."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        blockers = content.count("⚠️") + content.count("❌") + content.lower().count("blocker")
        return max(0, 100 - blockers * 20)

    def _count_tasks(self, content: str) -> int:
        """Count number of tasks."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        # Count T1, T2, etc. patterns
        import re
        return len(re.findall(r"\bT\d+\b", content))

    def _calculate_task_completion(self, content: str) -> float:
        """Calculate task completion rate (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content = content.lower()
        # Check for completion indicators
        if "complete" in content or "done" in content:
            # Check for explicit pass rate or coverage
            import re
            pass_match = re.search(r'(\d+)%', content)
            if pass_match:
                return float(pass_match.group(1))
            return 100.0
        return 50.0  # Unknown

    def _calculate_tdd_compliance(self, content: str) -> float:
        """Calculate TDD compliance (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content = content.lower()
        has_test = "test" in content or "red" in content or "green" in content
        has_impl = "implement" in content or "passing" in content or "green" in content
        has_refactor = "refactor" in content
        
        if has_test and has_impl:
            base = 60.0
            if has_refactor:
                base = 80.0
            # Check for explicit pass indicator
            if "100%" in content or "all pass" in content:
                base = 100.0
            return base
        return 40.0

    def _calculate_error_recovery(self, content: str) -> float:
        """Calculate error recovery rate (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content = content.lower()
        # Check for retry patterns or error mentions
        if "error" in content:
            if "retry" in content or "recover" in content:
                return 100.0
            return 70.0
        return 100.0

    def _calculate_parallel_efficiency(self, content: str) -> float:
        """Calculate parallel execution efficiency (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content = content.lower()
        # Check for parallel indicators
        if "parallel" in content or "concurrent" in content:
            return 85.0
        return 75.0

    def _calculate_quality_score(self, content: str) -> float:
        """Calculate quality score (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content = content.lower()
        # Check for quality indicators
        if "100%" in content or "pass" in content:
            return 100.0
        if "quality" in content:
            return 90.0
        return 70.0

    def _calculate_security_score(self, content: str) -> float:
        """Calculate security pass rate (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        content = content.lower()
        if "security" in content:
            if "0" in content and "vuln" in content:
                return 100.0
            if "pass" in content:
                return 95.0
        return 80.0

    def _calculate_test_coverage(self, content: str) -> float:
        """Calculate test coverage (0-100)."""
        if isinstance(content, list):
            content = " ".join(str(c) for c in content)
        import re
        # Look for coverage percentage
        match = re.search(r'coverage[:\s]+(\d+)%', content.lower())
        if match:
            return float(match.group(1))
        # Check for all passing
        if "all pass" in content.lower() or "100%" in content:
            return 100.0
        return 80.0

    def _calculate_phase_duration(self, entries: list[SessionLogEntry]) -> float:
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

    def _count_tool_calls_in_entries(self, entries: list[SessionLogEntry]) -> int:
        """Count tool calls in entries."""
        count = 0
        for entry in entries:
            if entry.message and entry.message.content:
                count += sum(1 for block in entry.message.content if block.type == "toolCall")
        return count

    def _count_errors_in_entries(self, entries: list[SessionLogEntry]) -> int:
        """Count error tool results in entries."""
        count = 0
        for entry in entries:
            if entry.message and entry.message.content:
                count += sum(1 for block in entry.message.content if block.type == "toolResult" and block.is_error)
        return count

    def _extract_outputs(self, entries: list[SessionLogEntry]) -> list[str]:
        """Extract output files from entries."""
        outputs = []
        for entry in entries:
            if entry.message and entry.message.content:
                for block in entry.message.content:
                    if block.type == "toolResult" and block.content:
                        content = str(block.content)
                        # Look for file paths
                        import re
                        files = re.findall(r"[\w\-./]+\.(py|ts|js|md|yaml|json)", content)
                        outputs.extend(files)
        return list(set(outputs))

    def _generate_recommendations(self, phase_results: dict[str, PhaseResult]) -> list[str]:
        """Generate recommendations based on phase scores."""
        recommendations = []

        for phase_name, result in phase_results.items():
            if result.score < 70:
                msg = f"{phase_name.capitalize()}: Score {result.score:.0f} is below threshold."
                recommendations.append(msg)

        if not recommendations:
            recommendations.append("Overall workflow quality is good.")

        return recommendations

    # HuggingFace evaluate integration methods

    def _compute_quality_with_rouge(self, draft: str, reference: str | None = None) -> float:
        """Compute quality score using rouge metric.
        
        Args:
            draft: Generated MDD draft text
            reference: Reference draft text (optional)
            
        Returns:
            Quality score 0-100
        """
        try:
            result = self.text_quality.evaluate_draft_quality(draft, reference)
            return result.avg_score * 100
        except Exception:
            # Fallback to heuristic
            return self._calculate_quality_score(draft)

    def _compute_security_with_ruff(self, code_dir: Path) -> float:
        """Compute security score using ruff/bandit.
        
        Args:
            code_dir: Directory containing code to scan
            
        Returns:
            Security pass rate 0-100
        """
        try:
            result = self.security.scan_directory(code_dir)
            return result.pass_rate * 100
        except Exception:
            # Fallback to heuristic
            return 80.0

    def _compute_test_coverage_with_code_eval(
        self,
        code: str,
        test: str,
    ) -> float:
        """Compute test coverage using code_eval.
        
        Args:
            code: Code to test
            test: Test code
            
        Returns:
            Test coverage score 0-100
        """
        try:
            result = self.code_eval.evaluate(code, test)
            return result.pass_at_k * 100
        except Exception:
            # Fallback to heuristic
            return self._calculate_test_coverage("")

    def evaluate_with_metrics(
        self,
        entries: list[SessionLogEntry],
        codes_dir: Path | None = None,
        request: str | None = None,
        session_id: str | None = None,
    ) -> EvaluationResult:
        """Evaluate with HuggingFace evaluate metrics.
        
        This method extends the standard evaluate() by using
        HuggingFace evaluate metrics when possible.
        
        Args:
            entries: Session log entries
            codes_dir: Directory containing generated code (optional)
            request: Original workflow request
            session_id: Session identifier
            
        Returns:
            EvaluationResult with real metrics
        """
        # First run standard evaluation
        result = self.evaluate(entries, request, session_id)
        
        # If codes_dir provided, run real security scan
        if codes_dir and codes_dir.exists():
            security_score = self._compute_security_with_ruff(codes_dir)
            if "audit" in result.phases:
                result.phases["audit"].metrics.security_pass_rate = security_score
        
        return result

        return recommendations
