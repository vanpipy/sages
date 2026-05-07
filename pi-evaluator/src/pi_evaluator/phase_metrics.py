"""Review phase metrics (QiaoChui) for pi-evaluator."""

from pi_evaluator.types import PhaseMetrics


def compute_review_metrics(entries, content: str) -> PhaseMetrics:
    """Compute metrics for Review phase (QiaoChui)."""
    metrics = PhaseMetrics()

    # Plan completeness
    required = ["Overview", "Tasks", "Dependencies"]
    found = sum(1 for r in required if r in content)
    metrics.plan_completeness = (found / len(required)) * 100

    # Feasibility score
    blockers = content.count("⚠️") + content.count("❌") + content.count("BLOCKER")
    metrics.feasibility_score = max(0, 100 - blockers * 20)

    # Task count
    import re

    metrics.task_count = len(re.findall(r"\bT\d+\b", content))

    return metrics
