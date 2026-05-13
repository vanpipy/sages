"""Tests for pi_evaluator.metrics module.

Note: Tests that require HuggingFace network are marked with @pytest.mark.skip
"""

import pytest
from pathlib import Path

from src.metrics import CodeEvalMetric, TextQualityMetric, SecurityMetric
from src.metrics.code_eval import CodeEvalResult
from src.metrics.text_quality import TextQualityResult
from src.metrics.security import SecurityResult


class TestCodeEvalMetric:
    """Tests for CodeEvalMetric."""

    @pytest.fixture
    def metric(self):
        """Create metric instance."""
        return CodeEvalMetric(timeout=5)

    def test_result_to_dict(self):
        """Test CodeEvalResult serialization."""
        result = CodeEvalResult(
            pass_at_k=0.85,
            total_tests=10,
            passed_tests=8,
            failed_tests=2,
            execution_time=1.5,
        )

        data = result.to_dict()
        assert data["pass_at_k"] == 0.85
        assert data["total_tests"] == 10
        assert data["passed_tests"] == 8
        assert data["failed_tests"] == 2
        assert data["execution_time"] == 1.5

    def test_evaluate_with_network(self, metric):
        """Test evaluate with actual HuggingFace download."""
        code = "def add(a, b): return a + b"
        test = "assert add(1, 2) == 3"
        result = metric.evaluate(code, test)
        assert isinstance(result, CodeEvalResult)

    def test_evaluate_fallback_with_pytest(self, metric, tmp_path):
        """Test fallback evaluation using pytest."""
        # Create code file
        code_file = tmp_path / "solution.py"
        code_file.write_text("def add(a, b): return a + b")

        # Create test file
        test_file = tmp_path / "test_solution.py"
        test_file.write_text("from solution import add\nassert add(1, 2) == 3")

        result = metric.evaluate_directory(tmp_path)
        assert isinstance(result, CodeEvalResult)
        assert result.execution_time >= 0

    def test_evaluate_directory_no_tests(self, metric, tmp_path):
        """Test directory evaluation with no test files."""
        result = metric.evaluate_directory(tmp_path)
        assert result.total_tests == 0
        assert result.error_message is not None


class TestTextQualityMetric:
    """Tests for TextQualityMetric."""

    @pytest.fixture
    def metric(self):
        """Create metric instance."""
        return TextQualityMetric()

    def test_result_to_dict(self):
        """Test TextQualityResult serialization."""
        result = TextQualityResult(
            rouge1=0.5,
            rouge2=0.3,
            rougeL=0.4,
            bleu=0.35,
            avg_score=0.4,
        )

        data = result.to_dict()
        assert data["rouge1"] == 0.5
        assert data["rouge2"] == 0.3
        assert data["rougeL"] == 0.4
        assert data["bleu"] == 0.35
        assert data["avg_score"] == 0.4

    def test_fallback_rouge_similar_texts(self, metric):
        """Test fallback rouge with similar texts."""
        pred = "The quick brown fox jumps over the lazy dog"
        ref = "The fast brown fox leaps over the lazy dog"

        result = metric._fallback_rouge(pred, ref)

        # Should have reasonable scores for similar texts
        assert 0.0 <= result["rouge1"] <= 1.0
        assert 0.0 <= result["rouge2"] <= 1.0

    def test_fallback_rouge_identical(self, metric):
        """Test fallback rouge with identical texts."""
        text = "This is a test sentence"
        result = metric._fallback_rouge(text, text)
        assert result["rouge1"] >= 0.9

    def test_fallback_rouge_different(self, metric):
        """Test fallback rouge with different texts."""
        pred = "The quick brown fox"
        ref = "A completely different sentence"
        result = metric._fallback_rouge(pred, ref)
        assert result["rouge1"] < 0.5

    def test_fallback_bleu(self, metric):
        """Test fallback bleu calculation."""
        pred = "The quick brown fox jumps"
        ref = "The quick brown fox leaps"
        result = metric._fallback_bleu(pred, ref)
        assert 0.0 <= result <= 1.0

    def test_evaluate_draft_quality_no_reference(self, metric):
        """Test draft quality without reference (uses indicators)."""
        draft = """
        # Business Plane
        This is about business value.
        
        # Data Plane
        We need data models for entities.
        
        # Security Plane
        Authentication and authorization required.
        """

        result = metric.evaluate_draft_quality(draft)

        assert 0.0 <= result.avg_score <= 1.0
        # Should score higher with more MDD indicators
        assert result.avg_score > 0.3  # Has several planes

    def test_evaluate_draft_quality_empty(self, metric):
        """Test draft quality with empty content."""
        result = metric.evaluate_draft_quality("")
        assert result.avg_score == 0.0

    def test_evaluate_with_network(self, metric):
        """Test evaluate with actual HuggingFace download."""
        pred = "The quick brown fox jumps"
        ref = "The fast brown fox leaps"
        result = metric.evaluate(pred, ref)
        assert isinstance(result, TextQualityResult)


class TestSecurityMetric:
    """Tests for SecurityMetric."""

    @pytest.fixture
    def metric(self):
        """Create metric instance."""
        return SecurityMetric(timeout=10)

    def test_result_to_dict(self):
        """Test SecurityResult serialization."""
        result = SecurityResult(
            total_issues=5,
            critical_count=0,
            high_count=1,
            medium_count=2,
            low_count=2,
            pass_rate=0.95,
            scan_time=0.5,
        )

        data = result.to_dict()
        assert data["total_issues"] == 5
        assert data["critical"] == 0
        assert data["high"] == 1
        assert data["medium"] == 2
        assert data["low"] == 2
        assert data["pass_rate"] == 0.95

    def test_scan_nonexistent_file(self, metric, tmp_path):
        """Test scanning nonexistent file."""
        result = metric.scan_file(tmp_path / "nonexistent.py")
        assert result.error_message == "File not found"
        assert result.pass_rate == 1.0

    def test_scan_clean_code(self, metric, tmp_path):
        """Test scanning clean code."""
        code_file = tmp_path / "clean.py"
        code_file.write_text("""
def add(a, b):
    return a + b

class Calculator:
    def multiply(self, x, y):
        return x * y
""")

        result = metric.scan_file(code_file)
        assert isinstance(result, SecurityResult)
        assert 0.0 <= result.pass_rate <= 1.0

    def test_scan_directory(self, metric, tmp_path):
        """Test scanning directory."""
        (tmp_path / "module1.py").write_text("x = 1")
        (tmp_path / "module2.py").write_text("y = 2")

        result = metric.scan_directory(tmp_path)
        assert isinstance(result, SecurityResult)

    def test_scan_directory_no_files(self, metric, tmp_path):
        """Test scanning directory with no Python files."""
        (tmp_path / "readme.txt").write_text("Just a text file")
        result = metric.scan_directory(tmp_path)
        assert result.error_message == "No Python files found"
        assert result.pass_rate == 1.0
