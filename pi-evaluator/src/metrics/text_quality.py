"""Text quality metric using HuggingFace evaluate (rouge/bleu).

Compares generated text against reference for quality assessment.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class TextQualityResult:
    """Result from text quality evaluation."""

    rouge1: float  # ROUGE-1 score (unigrams)
    rouge2: float  # ROUGE-2 score (bigrams)
    rougeL: float  # ROUGE-L score (longest common subsequence)
    bleu: float  # BLEU score
    avg_score: float  # Average of all metrics
    error_message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "rouge1": round(self.rouge1, 3),
            "rouge2": round(self.rouge2, 3),
            "rougeL": round(self.rougeL, 3),
            "bleu": round(self.bleu, 3),
            "avg_score": round(self.avg_score, 3),
            "error_message": self.error_message,
        }


class TextQualityMetric:
    """Text quality evaluation using HuggingFace evaluate.

    This wraps rouge and bleu metrics for comparing generated text
    against reference/candidate text.

    Usage:
        metric = TextQualityMetric()
        result = metric.evaluate(
            prediction="The quick brown fox jumps",
            reference="A fast brown fox leaps"
        )
        print(f"Quality score: {result.avg_score}")
    """

    def __init__(self):
        """Initialize text quality evaluator."""
        self._rouge = None
        self._bleu = None

    def _load_rouge(self):
        """Lazy load rouge metric."""
        if self._rouge is None:
            try:
                from evaluate import load
                self._rouge = load("rouge")
            except Exception as e:
                raise ImportError(
                    "HuggingFace evaluate not installed. Run: pip install evaluate"
                ) from e
        return self._rouge

    def _load_bleu(self):
        """Lazy load bleu metric."""
        if self._bleu is None:
            try:
                from evaluate import load
                self._bleu = load("sacrebleu")
            except Exception:
                try:
                    from evaluate import load
                    self._bleu = load("bleu")
                except Exception as e:
                    raise ImportError(
                        "HuggingFace evaluate not installed. Run: pip install evaluate"
                    ) from e
        return self._bleu

    def evaluate(
        self,
        prediction: str,
        reference: str,
    ) -> TextQualityResult:
        """Evaluate text quality.

        Args:
            prediction: Generated text
            reference: Reference text to compare against

        Returns:
            TextQualityResult with quality scores
        """
        rouge_result = self._evaluate_rouge(prediction, reference)
        bleu_result = self._evaluate_bleu(prediction, reference)

        avg_score = (rouge_result["rougeL"] + bleu_result) / 2

        return TextQualityResult(
            rouge1=rouge_result.get("rouge1", 0.0),
            rouge2=rouge_result.get("rouge2", 0.0),
            rougeL=rouge_result.get("rougeL", 0.0),
            bleu=bleu_result,
            avg_score=avg_score,
        )

    def _evaluate_rouge(
        self,
        prediction: str,
        reference: str,
    ) -> dict[str, float]:
        """Evaluate using ROUGE metric."""
        try:
            rouge = self._load_rouge()
            results = rouge.compute(
                predictions=[prediction],
                references=[reference],
            )
            return {
                "rouge1": results.get("rouge1", 0.0),
                "rouge2": results.get("rouge2", 0.0),
                "rougeL": results.get("rougeL", 0.0),
            }
        except Exception as e:
            # Fallback to simple word overlap
            return self._fallback_rouge(prediction, reference)

    def _fallback_rouge(
        self,
        prediction: str,
        reference: str,
    ) -> dict[str, float]:
        """Fallback ROUGE using simple word overlap."""
        pred_words = set(prediction.lower().split())
        ref_words = set(reference.lower().split())

        if not ref_words:
            return {"rouge1": 0.0, "rouge2": 0.0, "rougeL": 0.0}

        # ROUGE-1: unigram overlap
        overlap = pred_words & ref_words
        rouge1 = len(overlap) / len(ref_words) if ref_words else 0.0

        # ROUGE-2: bigram overlap (simplified)
        pred_bigrams = set(
            tuple(prediction.lower().split()[i:i+2])
            for i in range(len(prediction.split()) - 1)
        )
        ref_bigrams = set(
            tuple(reference.lower().split()[i:i+2])
            for i in range(len(reference.split()) - 1)
        )
        rouge2 = len(pred_bigrams & ref_bigrams) / len(ref_bigrams) if ref_bigrams else 0.0

        # ROUGE-L: longest common subsequence (simplified to overlap ratio)
        rougeL = rouge1

        return {
            "rouge1": rouge1,
            "rouge2": rouge2,
            "rougeL": rougeL,
        }

    def _evaluate_bleu(
        self,
        prediction: str,
        reference: str,
    ) -> float:
        """Evaluate using BLEU metric."""
        try:
            bleu = self._load_bleu()
            results = bleu.compute(
                predictions=[prediction],
                references=[reference],
            )
            return results.get("score", 0.0) / 100.0  # Normalize to 0-1
        except Exception:
            # Fallback to simple similarity
            return self._fallback_bleu(prediction, reference)

    def _fallback_bleu(
        self,
        prediction: str,
        reference: str,
    ) -> float:
        """Fallback BLEU using word overlap."""
        pred_words = prediction.lower().split()
        ref_words = reference.lower().split()

        if not ref_words:
            return 0.0

        # Simple n-gram precision
        matches = sum(1 for w in pred_words if w in ref_words)
        return matches / len(pred_words) if pred_words else 0.0

    def evaluate_batch(
        self,
        predictions: list[str],
        references: list[str],
    ) -> list[TextQualityResult]:
        """Evaluate multiple text pairs.

        Args:
            predictions: List of generated texts
            references: List of reference texts

        Returns:
            List of TextQualityResult
        """
        if len(predictions) != len(references):
            raise ValueError("predictions and references must have same length")

        return [
            self.evaluate(pred, ref)
            for pred, ref in zip(predictions, references)
        ]

    def evaluate_draft_quality(
        self,
        draft: str,
        reference_draft: str | None = None,
    ) -> TextQualityResult:
        """Evaluate MDD draft quality.

        Args:
            draft: Generated MDD draft text
            reference_draft: Reference draft to compare (optional)

        Returns:
            TextQualityResult with quality scores
        """
        if reference_draft:
            return self.evaluate(draft, reference_draft)

        # If no reference, use quality indicators
        quality_indicators = [
            "Business", "Data", "Control", "Foundation",
            "Observation", "Security", "Evolution",
            "plane", "metric", "design", "decision",
        ]

        draft_lower = draft.lower()
        indicators_found = sum(
            1 for indicator in quality_indicators
            if indicator.lower() in draft_lower
        )

        # Score based on coverage
        score = indicators_found / len(quality_indicators)

        return TextQualityResult(
            rouge1=score,
            rouge2=score * 0.8,
            rougeL=score,
            bleu=score,
            avg_score=score,
        )
