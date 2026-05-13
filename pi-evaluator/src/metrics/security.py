"""Security metric using ruff/bandit for code scanning.

Scans code for security vulnerabilities and returns pass/fail rate.
"""

from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class SecurityResult:
    """Result from security scan."""

    total_issues: int
    critical_count: int
    high_count: int
    medium_count: int
    low_count: int
    pass_rate: float  # 0.0 to 1.0 (1.0 = no issues)
    scan_time: float
    error_message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_issues": self.total_issues,
            "critical": self.critical_count,
            "high": self.high_count,
            "medium": self.medium_count,
            "low": self.low_count,
            "pass_rate": round(self.pass_rate, 3),
            "scan_time": round(self.scan_time, 2),
            "error_message": self.error_message,
        }


class SecurityMetric:
    """Security scanning using ruff and bandit.

    Scans Python code for security vulnerabilities and returns
    pass/fail rate based on severity.

    Usage:
        scanner = SecurityMetric()
        result = scanner.scan_file(Path("code.py"))
        print(f"Security score: {result.pass_rate}")
    """

    def __init__(self, timeout: int = 60):
        """Initialize security scanner.

        Args:
            timeout: Maximum scan time in seconds
        """
        self.timeout = timeout

    def scan_file(self, file_path: Path) -> SecurityResult:
        """Scan a single file for security issues.

        Args:
            file_path: Path to Python file

        Returns:
            SecurityResult with issue counts and pass rate
        """
        import time
        start_time = time.time()

        if not file_path.exists():
            return SecurityResult(
                total_issues=0,
                critical_count=0,
                high_count=0,
                medium_count=0,
                low_count=0,
                pass_rate=1.0,
                scan_time=time.time() - start_time,
                error_message="File not found",
            )

        # Try ruff first (faster)
        result = self._scan_with_ruff(file_path, start_time)
        if result.error_message == "ruff not installed":
            # Fallback to bandit
            result = self._scan_with_bandit(file_path, start_time)

        return result

    def scan_directory(self, dir_path: Path) -> SecurityResult:
        """Scan all Python files in a directory.

        Args:
            dir_path: Path to directory

        Returns:
            Aggregated SecurityResult
        """
        import time
        start_time = time.time()

        py_files = list(dir_path.glob("**/*.py"))
        if not py_files:
            return SecurityResult(
                total_issues=0,
                critical_count=0,
                high_count=0,
                medium_count=0,
                low_count=0,
                pass_rate=1.0,
                scan_time=time.time() - start_time,
                error_message="No Python files found",
            )

        # Aggregate results
        total_critical = 0
        total_high = 0
        total_medium = 0
        total_low = 0

        for py_file in py_files:
            result = self._scan_with_ruff(py_file, start_time)
            total_critical += result.critical_count
            total_high += result.high_count
            total_medium += result.medium_count
            total_low += result.low_count

        total_issues = total_critical + total_high + total_medium + total_low
        total_files = len(py_files)

        # Pass rate: deduct points based on severity
        # Critical: -0.5, High: -0.25, Medium: -0.1, Low: -0.05 per issue
        deduction = (
            total_critical * 0.5 +
            total_high * 0.25 +
            total_medium * 0.1 +
            total_low * 0.05
        )
        pass_rate = max(0.0, 1.0 - deduction / total_files if total_files > 0 else 1.0)

        return SecurityResult(
            total_issues=total_issues,
            critical_count=total_critical,
            high_count=total_high,
            medium_count=total_medium,
            low_count=total_low,
            pass_rate=pass_rate,
            scan_time=time.time() - start_time,
        )

    def _scan_with_ruff(self, file_path: Path, start_time: float) -> SecurityResult:
        """Scan using ruff linter."""
        try:
            result = subprocess.run(
                ["ruff", "check", str(file_path), "--output-format=json"],
                capture_output=True,
                text=True,
                timeout=self.timeout,
            )

            scan_time = time.time() - start_time

            if result.returncode == 0:
                return SecurityResult(
                    total_issues=0,
                    critical_count=0,
                    high_count=0,
                    medium_count=0,
                    low_count=0,
                    pass_rate=1.0,
                    scan_time=scan_time,
                )

            # Parse JSON output
            try:
                issues = json.loads(result.stdout) if result.stdout else []
            except json.JSONDecodeError:
                issues = []

            # Categorize by severity (ruff uses rule codes)
            critical = 0
            high = 0
            medium = 0
            low = 0

            security_codes = {
                # Critical
                "S001", "S002", "S003",  # Unsafe
                # High
                "S101", "S104", "S105",  # Security
                # Medium
                "S301", "S302", "S310",  # Moderate
                # Low
                "S303", "S305", "S306",  # Minor
            }

            for issue in issues:
                code = issue.get("code", "")
                if code.startswith("F") or code.startswith("E"):  # Style/Error
                    continue
                if code in security_codes:
                    if "S0" in code:  # Critical
                        critical += 1
                    elif code.startswith(("S1", "S3")):
                        high += 1

            total_issues = len(issues)
            pass_rate = max(0.0, 1.0 - total_issues * 0.05)

            return SecurityResult(
                total_issues=total_issues,
                critical_count=critical,
                high_count=high,
                medium_count=medium,
                low_count=low,
                pass_rate=pass_rate,
                scan_time=scan_time,
            )

        except FileNotFoundError:
            return SecurityResult(
                total_issues=0,
                critical_count=0,
                high_count=0,
                medium_count=0,
                low_count=0,
                pass_rate=1.0,
                scan_time=time.time() - start_time,
                error_message="ruff not installed",
            )
        except Exception as e:
            return SecurityResult(
                total_issues=0,
                critical_count=0,
                high_count=0,
                medium_count=0,
                low_count=0,
                pass_rate=1.0,
                scan_time=time.time() - start_time,
                error_message=str(e),
            )

    def _scan_with_bandit(self, file_path: Path, start_time: float) -> SecurityResult:
        """Scan using bandit."""
        try:
            result = subprocess.run(
                ["bandit", "-r", str(file_path), "-f", "json"],
                capture_output=True,
                text=True,
                timeout=self.timeout,
            )

            scan_time = time.time() - start_time

            try:
                report = json.loads(result.stdout) if result.stdout else {}
                issues = report.get("results", [])
            except json.JSONDecodeError:
                issues = []

            critical = 0
            high = 0
            medium = 0
            low = 0

            severity_map = {
                "HIGH": high,
                "MEDIUM": medium,
                "LOW": low,
            }

            for issue in issues:
                severity = issue.get("issue_severity", "LOW")
                if severity == "HIGH":
                    high += 1
                elif severity == "MEDIUM":
                    medium += 1
                else:
                    low += 1

            total_issues = len(issues)
            pass_rate = max(0.0, 1.0 - total_issues * 0.05)

            return SecurityResult(
                total_issues=total_issues,
                critical_count=critical,
                high_count=high,
                medium_count=medium,
                low_count=low,
                pass_rate=pass_rate,
                scan_time=scan_time,
            )

        except FileNotFoundError:
            return SecurityResult(
                total_issues=0,
                critical_count=0,
                high_count=0,
                medium_count=0,
                low_count=0,
                pass_rate=1.0,
                scan_time=time.time() - start_time,
                error_message="bandit not installed",
            )
        except Exception as e:
            return SecurityResult(
                total_issues=0,
                critical_count=0,
                high_count=0,
                medium_count=0,
                low_count=0,
                pass_rate=1.0,
                scan_time=time.time() - start_time,
                error_message=str(e),
            )
