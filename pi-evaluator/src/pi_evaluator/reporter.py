"""pi_evaluator.reporter - Output formatters for evaluation results.

Generates JSON and Markdown reports from EvaluationResult.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pi_evaluator.types import ComparisonResult, EvaluationResult


class Reporter:
    """Reporter for generating evaluation output.

    Supports JSON and Markdown formats.
    """

    def __init__(self, output_dir: Path | None = None):
        """Initialize reporter.

        Args:
            output_dir: Base output directory (optional)

        """
        self.output_dir = output_dir

    def save_evaluation(
        self,
        result: EvaluationResult,
        output_dir: Path | None = None,
    ) -> tuple[Path, Path]:
        """Save evaluation result to JSON and Markdown files.

        Args:
            result: EvaluationResult to save
            output_dir: Output directory (default: self.output_dir)

        Returns:
            Tuple of (json_path, md_path)

        """
        if output_dir is None:
            output_dir = self.output_dir or Path(".")

        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Save JSON
        json_path = output_dir / "evaluation.json"
        with open(json_path, "w") as f:
            json.dump(result.to_dict(), f, indent=2)

        # Save Markdown
        md_path = output_dir / "report.md"
        with open(md_path, "w") as f:
            f.write(self.generate_markdown(result))

        return json_path, md_path

    def generate_json(self, result: EvaluationResult) -> str:
        """Generate JSON string from evaluation result.

        Args:
            result: EvaluationResult

        Returns:
            JSON string

        """
        return json.dumps(result.to_dict(), indent=2)

    def generate_markdown(self, result: EvaluationResult) -> str:
        """Generate Markdown report from evaluation result.

        Args:
            result: EvaluationResult

        Returns:
            Markdown string

        """
        verdict_emoji = {
            "EXCELLENT": "🟢",
            "GOOD": "🔵",
            "FAIR": "🟡",
            "POOR": "🔴",
        }.get(result.verdict, "⚪")

        lines = [
            f"# Evaluation Report: {result.session_id}",
            "",
            f"**Request**: {result.request}",
            f"**Verdict**: {verdict_emoji} {result.verdict} "
            f"({result.overall.overall_score:.1f}/100)",
            f"**Date**: {result.timestamp}",
            "",
            "## Summary",
            "",
            "| Phase | Score | Duration | Tool Calls | Errors |",
            "|-------|-------|----------|------------|--------|",
        ]

        # Phase summary table
        for phase_name, phase_result in result.phases.items():
            lines.append(
                f"| {phase_name.capitalize()} | {phase_result.score:.1f} | "
                f"{phase_result.duration_seconds:.1f}s | {phase_result.tool_calls} | "
                f"{phase_result.errors} |"
            )

        lines.extend(
            [
                "",
                "## Overall Metrics",
                "",
                f"- **Total Duration**: {result.overall.total_duration_seconds:.1f}s",
                f"- **Total Tool Calls**: {result.overall.total_tool_calls}",
                f"- **Error Rate**: {result.overall.error_rate:.1%}",
                f"- **Overall Score**: {result.overall.overall_score:.1f}",
                "",
                "## Phase Details",
                "",
            ]
        )

        # Detailed phase information
        for phase_name, phase_result in result.phases.items():
            lines.extend(
                [
                    f"### {phase_name.capitalize()} Phase",
                    "",
                    f"- **Score**: {phase_result.score:.1f}",
                    f"- **Duration**: {phase_result.duration_seconds:.1f}s",
                    f"- **Tool Calls**: {phase_result.tool_calls}",
                    f"- **Errors**: {phase_result.errors}",
                ]
            )

            if phase_result.outputs:
                lines.append(f"- **Outputs**: {', '.join(phase_result.outputs)}")

            # Metrics for this phase
            metrics = phase_result.metrics
            metrics_dict = metrics.to_dict()
            non_zero = {k: v for k, v in metrics_dict.items() if v > 0}

            if non_zero:
                lines.append("- **Metrics**:")
                for key, value in non_zero.items():
                    lines.append(
                        f"  - {key}: {value:.1f}"
                        if isinstance(value, float)
                        else f"  - {key}: {value}"
                    )

            lines.append("")

        # Recommendations
        if result.recommendations:
            lines.extend(
                [
                    "## Recommendations",
                    "",
                ]
            )
            for rec in result.recommendations:
                lines.append(f"- {rec}")
            lines.append("")

        return "\n".join(lines)

    def generate_comparison_markdown(self, comparison: ComparisonResult) -> str:
        """Generate Markdown comparison report.

        Args:
            comparison: ComparisonResult

        Returns:
            Markdown string

        """
        trend_emoji = {
            "IMPROVED": "📈",
            "REGRESSION": "📉",
            "STABLE": "➡️",
        }.get(comparison.trend, "⚪")

        lines = [
            f"# Comparison Report: {comparison.session1_id} vs {comparison.session2_id}",
            "",
            f"**Trend**: {trend_emoji} {comparison.trend}",
            f"**Score Difference**: {comparison.score_diff:+.1f}",
            "",
            "## Phase Comparison",
            "",
            "| Phase | Difference |",
            "|-------|------------|",
        ]

        for phase, diff in comparison.phase_diffs.items():
            sign = "+" if diff > 0 else ""
            lines.append(f"| {phase.capitalize()} | {sign}{diff:.1f} |")

        if comparison.recommendations:
            lines.extend(["", "## Recommendations", ""])
            for rec in comparison.recommendations:
                lines.append(f"- {rec}")

        return "\n".join(lines)
