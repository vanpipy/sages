"""Code evaluation metric using HuggingFace evaluate.

Executes code and measures pass@k (probability of passing within k attempts).
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class CodeEvalResult:
    """Result from code evaluation."""

    pass_at_k: float  # 0.0 to 1.0
    total_tests: int
    passed_tests: int
    failed_tests: int
    execution_time: float
    error_message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "pass_at_k": round(self.pass_at_k, 3),
            "total_tests": self.total_tests,
            "passed_tests": self.passed_tests,
            "failed_tests": self.failed_tests,
            "execution_time": round(self.execution_time, 2),
            "error_message": self.error_message,
        }


class CodeEvalMetric:
    """Code evaluation using HuggingFace evaluate framework.

    This wraps the evaluate.load("code_eval") functionality for
    running actual code and tests.

    Usage:
        metric = CodeEvalMetric()
        result = metric.evaluate(code="def add(a,b): return a+b", test="assert add(1,2)==3")
        print(f"Pass rate: {result.pass_at_k}")
    """

    def __init__(self, timeout: int = 30):
        """Initialize code evaluator.

        Args:
            timeout: Maximum execution time in seconds
        """
        self.timeout = timeout
        self._evaluator = None

    def _load_evaluator(self):
        """Lazy load the HuggingFace code_eval evaluator."""
        if self._evaluator is None:
            try:
                from evaluate import load
                self._evaluator = load("code_eval")
            except Exception as e:
                raise ImportError(
                    "HuggingFace evaluate not installed. Run: pip install evaluate"
                ) from e
        return self._evaluator

    def evaluate(
        self,
        code: str,
        test: str,
        k: int = 1,
    ) -> CodeEvalResult:
        """Evaluate code against tests.

        Args:
            code: The code to evaluate
            test: Test code to run
            k: Number of attempts (pass@k)

        Returns:
            CodeEvalResult with pass@k score
        """
        import time
        start_time = time.time()

        try:
            evaluator = self._load_evaluator()
            results = evaluator.compute(
                predictions=[[code]],
                references=[test],
                k=k,
            )

            execution_time = time.time() - start_time

            pass_at_k = results.get("pass_at_k", [0.0])[0]
            passed = results.get("passed", [0])[0]
            total = results.get("total", [0])[0]

            return CodeEvalResult(
                pass_at_k=pass_at_k,
                total_tests=total,
                passed_tests=passed,
                failed_tests=total - passed,
                execution_time=execution_time,
            )

        except ImportError:
            # Fallback to simple pytest run
            return self._fallback_evaluate(code, test, start_time)
        except Exception as e:
            execution_time = time.time() - start_time
            return CodeEvalResult(
                pass_at_k=0.0,
                total_tests=0,
                passed_tests=0,
                failed_tests=0,
                execution_time=execution_time,
                error_message=str(e),
            )

    def _fallback_evaluate(
        self,
        code: str,
        test: str,
        start_time: float,
    ) -> CodeEvalResult:
        """Fallback evaluation using pytest.

        Creates temporary files and runs pytest.
        """
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            # Write code file
            code_file = Path(tmpdir) / "solution.py"
            code_file.write_text(code)

            # Write test file
            test_file = Path(tmpdir) / "test_solution.py"
            test_file.write_text(test)

            try:
                result = subprocess.run(
                    ["pytest", str(test_file), "-v", "--tb=short"],
                    capture_output=True,
                    text=True,
                    timeout=self.timeout,
                    cwd=tmpdir,
                )

                execution_time = time.time() - start_time

                # Parse pytest output
                passed = result.stdout.count(" PASSED")
                failed = result.stdout.count(" FAILED")
                total = passed + failed

                pass_at_k = passed / total if total > 0 else 0.0

                return CodeEvalResult(
                    pass_at_k=pass_at_k,
                    total_tests=total,
                    passed_tests=passed,
                    failed_tests=failed,
                    execution_time=execution_time,
                )

            except subprocess.TimeoutExpired:
                return CodeEvalResult(
                    pass_at_k=0.0,
                    total_tests=0,
                    passed_tests=0,
                    failed_tests=0,
                    execution_time=self.timeout,
                    error_message="Test execution timed out",
                )
            except FileNotFoundError:
                return CodeEvalResult(
                    pass_at_k=0.0,
                    total_tests=0,
                    passed_tests=0,
                    failed_tests=0,
                    execution_time=time.time() - start_time,
                    error_message="pytest not installed",
                )
            except Exception as e:
                return CodeEvalResult(
                    pass_at_k=0.0,
                    total_tests=0,
                    passed_tests=0,
                    failed_tests=0,
                    execution_time=time.time() - start_time,
                    error_message=str(e),
                )

    def evaluate_directory(
        self,
        code_dir: Path,
        test_pattern: str = "test_*.py",
    ) -> CodeEvalResult:
        """Evaluate all test files in a directory.

        Args:
            code_dir: Directory containing code and tests
            test_pattern: Glob pattern for test files

        Returns:
            Aggregated CodeEvalResult
        """
        import time
        start_time = time.time()

        test_files = list(code_dir.glob(test_pattern))
        if not test_files:
            return CodeEvalResult(
                pass_at_k=0.0,
                total_tests=0,
                passed_tests=0,
                failed_tests=0,
                execution_time=time.time() - start_time,
                error_message="No test files found",
            )

        try:
            result = subprocess.run(
                ["pytest", str(code_dir), "-v", "--tb=short", "-q"],
                capture_output=True,
                text=True,
                timeout=self.timeout,
                cwd=str(code_dir),
            )

            execution_time = time.time() - start_time

            # Parse output
            passed = result.stdout.count(" PASSED")
            failed = result.stdout.count(" FAILED")
            total = passed + failed

            pass_at_k = passed / total if total > 0 else 0.0

            return CodeEvalResult(
                pass_at_k=pass_at_k,
                total_tests=total,
                passed_tests=passed,
                failed_tests=failed,
                execution_time=execution_time,
            )

        except Exception as e:
            return CodeEvalResult(
                pass_at_k=0.0,
                total_tests=0,
                passed_tests=0,
                failed_tests=0,
                execution_time=time.time() - start_time,
                error_message=str(e),
            )
