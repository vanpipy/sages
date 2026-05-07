"""
Design phase metrics (Fuxi) for HuggingFace evaluate framework.
"""

from typing import Any, Dict, List

from pi_evaluator.types import PhaseMetrics, SessionLogEntry


def compute_design_metrics(entries: List[SessionLogEntry]) -> PhaseMetrics:
    """
    Compute metrics for Design phase (Fuxi).

    Metrics:
    - plane_coverage: % of MDD planes with content
    - content_depth: Average lines per plane section
    - cross_references: Count of cross-plane links
    - decisions: Count of key decisions documented

    Args:
        entries: Session log entries for design phase

    Returns:
        PhaseMetrics with design-specific metrics
    """
    metrics = PhaseMetrics()

    # Extract text content
    content = _get_text_content(entries)

    # Plane coverage (7 planes)
    planes = ["Business", "Data", "Control", "Foundation", "Observation", "Security", "Evolution"]
    planes_found = sum(1 for p in planes if p in content)
    metrics.plane_coverage = (planes_found / len(planes)) * 100

    # Content depth
    total_lines = len(content.split("\n"))
    metrics.content_depth = min(100, (total_lines / len(planes)) * 2)

    # Cross references
    metrics.cross_references = content.lower().count("see also") + content.lower().count("related to")

    # Key decisions
    metrics.decisions = content.count("Decision:") + content.count("## Key Design Decisions")

    return metrics


def _get_text_content(entries: List[SessionLogEntry]) -> str:
    """Extract text content from entries."""
    parts = []
    for entry in entries:
        if entry.message:
            for block in entry.message.content:
                if block.type == "text" and block.content:
                    parts.append(str(block.content))
    return " ".join(parts)
