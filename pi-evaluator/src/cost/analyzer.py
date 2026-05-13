"""Cost analyzer for pi-evaluator.

Extracts cost data from session logs and calculates efficiency metrics.
"""

from dataclasses import dataclass, field
from typing import Any

from ..types import SessionLogEntry, Phase


# Cost efficiency thresholds (cost per quality point in USD)
EFFICIENCY_THRESHOLDS = {
    "excellent": 0.0005,  # < $0.0005 per point
    "good": 0.002,         # < $0.002 per point
    "fair": 0.005,         # < $0.005 per point
    "poor": float('inf'),
}


@dataclass
class CostMetrics:
    """Cost metrics for a workflow session."""

    # Total costs (in USD)
    total_cost: float = 0.0
    input_cost: float = 0.0
    output_cost: float = 0.0
    cache_cost: float = 0.0

    # Token counts
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    total_tokens: int = 0

    # Derived metrics
    cache_hit_rate: float = 0.0  # cache_read / input_tokens

    # Cost per phase
    cost_by_phase: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_cost": round(self.total_cost, 6),
            "input_cost": round(self.input_cost, 6),
            "output_cost": round(self.output_cost, 6),
            "cache_cost": round(self.cache_cost, 6),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "total_tokens": self.total_tokens,
            "cache_hit_rate": round(self.cache_hit_rate, 3),
            "cost_by_phase": {k: round(v, 6) for k, v in self.cost_by_phase.items()},
        }


@dataclass
class CostResult:
    """Complete cost analysis result."""

    metrics: CostMetrics
    model: str
    cost_per_quality: float  # total_cost / quality_score
    efficiency_rating: str  # "excellent", "good", "fair", "poor"

    def to_dict(self) -> dict[str, Any]:
        return {
            "metrics": self.metrics.to_dict(),
            "model": self.model,
            "cost_per_quality_point": round(self.cost_per_quality, 6),
            "efficiency_rating": self.efficiency_rating,
        }


class CostAnalyzer:
    """Analyzer for workflow cost metrics."""

    def analyze(
        self,
        entries: list[SessionLogEntry],
        phases: dict[Phase, list[SessionLogEntry]],
        quality_score: float = 0.0,
    ) -> CostResult:
        """Analyze cost metrics from session entries.

        Args:
            entries: All session log entries
            phases: Entries grouped by phase
            quality_score: Overall quality score (0-100)

        Returns:
            CostResult with cost analysis
        """
        metrics = CostMetrics()

        # Extract cost from all assistant messages
        for entry in entries:
            if entry.message and entry.message.role == "assistant":
                usage = entry.message.usage or {}
                cost_data = usage.get("cost", {})

                if cost_data:
                    metrics.total_cost += cost_data.get("total", 0)
                    metrics.input_cost += cost_data.get("input", 0)
                    metrics.output_cost += cost_data.get("output", 0)
                    metrics.cache_cost += cost_data.get("cacheRead", 0)

                # Token counts
                metrics.input_tokens += usage.get("input", 0)
                metrics.output_tokens += usage.get("output", 0)
                metrics.cache_read_tokens += usage.get("cacheRead", 0)
                metrics.total_tokens += usage.get("totalTokens", 0)

        # Calculate cache hit rate
        if metrics.input_tokens > 0:
            metrics.cache_hit_rate = metrics.cache_read_tokens / metrics.input_tokens

        # Calculate cost per phase
        for phase, phase_entries in phases.items():
            phase_cost = self._extract_phase_cost(phase_entries)
            if phase_cost > 0:
                metrics.cost_by_phase[phase.value] = round(phase_cost, 6)

        # Detect model
        model = self._detect_model(entries)

        # Calculate cost per quality point
        cost_per_quality = 0.0
        if quality_score > 0:
            cost_per_quality = metrics.total_cost / quality_score

        # Determine efficiency rating
        efficiency_rating = self._get_efficiency_rating(cost_per_quality)

        return CostResult(
            metrics=metrics,
            model=model,
            cost_per_quality=cost_per_quality,
            efficiency_rating=efficiency_rating,
        )

    def _extract_phase_cost(self, entries: list[SessionLogEntry]) -> float:
        """Extract total cost from phase entries."""
        total = 0.0
        for entry in entries:
            if entry.message and entry.message.role == "assistant":
                cost_data = entry.message.usage.get("cost", {}) if entry.message.usage else {}
                total += cost_data.get("total", 0)
        return total

    def _detect_model(self, entries: list[SessionLogEntry]) -> str:
        """Detect the model used from session entries."""
        for entry in entries:
            if entry.type == "model_change":
                return entry.model_id or "unknown"
        return "unknown"

    def _get_efficiency_rating(self, cost_per_quality: float) -> str:
        """Determine efficiency rating based on cost per quality point."""
        # Zero cost is excellent (free is best!)
        if cost_per_quality <= 0:
            return "excellent"
        if cost_per_quality < EFFICIENCY_THRESHOLDS["excellent"]:
            return "excellent"
        elif cost_per_quality < EFFICIENCY_THRESHOLDS["good"]:
            return "good"
        elif cost_per_quality < EFFICIENCY_THRESHOLDS["fair"]:
            return "fair"
        return "poor"


def get_efficiency_rating(cost_per_quality: float) -> str:
    """Get efficiency rating for a cost per quality point value."""
    # Zero cost is excellent (free is best!)
    if cost_per_quality <= 0:
        return "excellent"
    if cost_per_quality < EFFICIENCY_THRESHOLDS["excellent"]:
        return "excellent"
    elif cost_per_quality < EFFICIENCY_THRESHOLDS["good"]:
        return "good"
    elif cost_per_quality < EFFICIENCY_THRESHOLDS["fair"]:
        return "fair"
    return "poor"
