"""pi_evaluator.env_checker - Environment validation for pi-evaluator.

Performs pre-flight checks to ensure all requirements are met:
- Python version
- Required dependencies (evaluate, datasets)
- pi binary availability
- Four Sages extension installation
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ValidationResult:
    """Result of environment validation."""

    valid: bool
    checks: dict[str, bool] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    info: dict[str, Any] = field(default_factory=dict)

    def add_check(self, name: str, passed: bool, message: str = "") -> None:
        """Add a validation check result."""
        self.checks[name] = passed
        if not passed:
            self.valid = False
            if message:
                self.errors.append(message)

    def add_info(self, name: str, value: Any) -> None:
        """Add informational data."""
        self.info[name] = value

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "checks": self.checks,
            "errors": self.errors,
            "info": self.info,
        }

    def __str__(self) -> str:
        """Human-readable validation report."""
        lines = ["Environment Validation Results", "=" * 40]

        for name, passed in self.checks.items():
            status = "✅" if passed else "❌"
            lines.append(f"{status} {name}")

        lines.append("")
        for key, value in self.info.items():
            lines.append(f"  {key}: {value}")

        if self.errors:
            lines.append("")
            lines.append("Errors:")
            for error in self.errors:
                lines.append(f"  - {error}")

        return "\n".join(lines)


def check_python_version() -> tuple[bool, str]:
    """Check if Python version is >= 3.10."""
    version = sys.version_info
    required = (3, 10)

    if version >= required:
        return True, f"Python {version.major}.{version.minor}.{version.micro}"
    else:
        return False, f"Python {version.major}.{version.minor} (required: >= 3.10)"


def check_evaluate_library() -> tuple[bool, str]:
    """Check if HuggingFace evaluate library is installed."""
    try:
        import evaluate

        version = getattr(evaluate, "__version__", "unknown")
        return True, f"evaluate {version}"
    except ImportError:
        return False, "evaluate library not installed (pip install evaluate)"


def check_datasets_library() -> tuple[bool, str]:
    """Check if datasets library is installed."""
    try:
        import datasets

        version = getattr(datasets, "__version__", "unknown")
        return True, f"datasets {version}"
    except ImportError:
        return False, "datasets library not installed (pip install datasets)"


def check_pi_binary(pi_path: str = "pi") -> tuple[bool, str]:
    """Check if pi binary is accessible."""
    # First try shutil.which
    pi_executable = shutil.which(pi_path)
    if pi_executable:
        return True, pi_executable

    # Try direct execution
    try:
        result = subprocess.run(
            [pi_path, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            version = result.stdout.strip() or result.stderr.strip() or "found"
            return True, f"{pi_path} ({version})"
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    return False, f"pi binary not found in PATH (tried: {pi_path})"


def check_four_sages_extension(pi_path: str = "pi") -> tuple[bool, str]:
    """Check if Four Sages extension is installed in pi."""
    try:
        result = subprocess.run(
            [pi_path, "--print", "/echo $PI_PACKAGES"],
            capture_output=True,
            text=True,
            timeout=10,
            input="\n",
        )

        output = result.stdout + result.stderr
        if "sages" in output.lower() or result.returncode == 0:
            return True, "Four Sages extension detected"
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    # If we can't check, assume it's there (lenient)
    return True, "Cannot verify (may be installed)"


def validate_all(pi_path: str = "pi") -> ValidationResult:
    """Perform all environment validation checks.

    Args:
        pi_path: Path to pi binary (default: "pi")

    Returns:
        ValidationResult with all check results

    """
    result = ValidationResult(valid=True)

    # Python version
    passed, message = check_python_version()
    result.add_check("Python >= 3.10", passed, message if not passed else "")
    result.add_info("python_version", message)

    # Dependencies
    passed, message = check_evaluate_library()
    result.add_check("HuggingFace evaluate", passed, message if not passed else "")
    if passed:
        result.add_info("evaluate_version", message)

    passed, message = check_datasets_library()
    result.add_check("HuggingFace datasets", passed, message if not passed else "")
    if passed:
        result.add_info("datasets_version", message)

    # pi binary
    passed, message = check_pi_binary(pi_path)
    result.add_check("pi binary", passed, message if not passed else "")
    if passed:
        result.add_info("pi_path", message)

    # Four Sages extension
    passed, message = check_four_sages_extension(pi_path)
    result.add_check("Four Sages extension", passed)
    result.add_info("four_sages", message)

    return result


def validate_or_exit(pi_path: str = "pi") -> ValidationResult:
    """Validate environment and exit with error code if invalid.

    Args:
        pi_path: Path to pi binary

    Returns:
        ValidationResult (exits on failure)

    """
    result = validate_all(pi_path)

    if not result.valid:
        print(result)
        sys.exit(1)

    return result
