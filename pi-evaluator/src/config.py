"""pi_evaluator.config - Configuration management for pi-evaluator.

Supports configuration from:
1. CLI arguments (highest priority)
2. Environment variables (PI_EVALUATOR_* prefix)
3. Config file (~/.pi-evaluator.yaml or ./.pi-evaluator.yaml)
4. Default values (lowest priority)
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Environment variable prefix
ENV_PREFIX = "PI_EVALUATOR_"

# Default values
DEFAULTS = {
    "output_dir": "./evaluations",
    "session_subdir": "sessions",
    "evaluation_subdir": "evaluations",
    "pi_path": "pi",
    "auto_approve": True,
    "timeout": 3600,
    "phase_weights": {"design": 0.3, "review": 0.2, "execute": 0.3, "audit": 0.2},
}


class ConfigError(Exception):
    """Configuration error exception."""

    pass


@dataclass
class Config:
    """Configuration for pi-evaluator.

    Attributes:
        output_dir: Base output directory
        session_subdir: Subdirectory for session logs
        evaluation_subdir: Subdirectory for evaluation reports
        pi_path: Path to pi binary
        auto_approve: Enable auto-approve for workflow phases
        timeout: Workflow timeout in seconds
        phase_weights: Weights for each phase in overall score
        verbose: Enable verbose output

    """

    output_dir: Path = field(default_factory=lambda: Path(DEFAULTS["output_dir"]))
    session_subdir: str = DEFAULTS["session_subdir"]
    evaluation_subdir: str = DEFAULTS["evaluation_subdir"]
    pi_path: str = DEFAULTS["pi_path"]
    auto_approve: bool = DEFAULTS["auto_approve"]
    timeout: int = DEFAULTS["timeout"]
    phase_weights: dict[str, float] = field(
        default_factory=lambda: DEFAULTS["phase_weights"].copy()
    )
    verbose: bool = False

    def __post_init__(self):
        """Validate and normalize configuration."""
        # Convert output_dir to Path
        if isinstance(self.output_dir, str):
            self.output_dir = Path(self.output_dir)

        # Validate phase weights sum to 1.0
        total = sum(self.phase_weights.values())
        if abs(total - 1.0) > 0.01:
            raise ConfigError(f"Phase weights must sum to 1.0, got {total}")

        # Validate timeout
        if self.timeout <= 0:
            raise ConfigError(f"Timeout must be positive, got {self.timeout}")

    @classmethod
    def from_env(cls) -> Config:
        """Create Config from environment variables."""
        return cls(
            output_dir=os.environ.get(f"{ENV_PREFIX}OUTPUT_DIR", DEFAULTS["output_dir"]),
            pi_path=os.environ.get(f"{ENV_PREFIX}PI_PATH", DEFAULTS["pi_path"]),
            auto_approve=os.environ.get(
                f"{ENV_PREFIX}AUTO_APPROVE", str(DEFAULTS["auto_approve"])
            ).lower()
            in ("true", "1", "yes"),
            timeout=int(os.environ.get(f"{ENV_PREFIX}TIMEOUT", str(DEFAULTS["timeout"]))),
            verbose=os.environ.get(f"{ENV_PREFIX}VERBOSE", "false").lower() in ("true", "1", "yes"),
        )

    @classmethod
    def from_file(cls, path: Path) -> Config:
        """Create Config from YAML file."""
        try:
            import yaml
        except ImportError as e:
            raise ConfigError("PyYAML required for config file parsing") from e

        if not path.exists():
            raise ConfigError(f"Config file not found: {path}")

        with open(path) as f:
            data = yaml.safe_load(f) or {}

        return cls(**data)

    def get_session_dir(self, session_id: str) -> Path:
        """Get directory for session logs."""
        return self.output_dir / self.session_subdir / session_id

    def get_session_path(self, session_id: str) -> Path:
        """Get path to session.jsonl file."""
        return self.get_sessions_dir(session_id) / "session.jsonl"

    def get_codes_dir(self, session_id: str) -> Path:
        """Get directory for generated code files."""
        return self.output_dir / session_id / "codes"

    def get_sessions_dir(self, session_id: str) -> Path:
        """Get directory for session logs."""
        return self.output_dir / session_id / "sessions"

    def get_report_dir(self, session_id: str) -> Path:
        """Get directory for report files."""
        return self.output_dir / session_id / "report"

    def get_evaluation_path(self, session_id: str) -> Path:
        """Get path to evaluation.json file."""
        return self.get_report_dir(session_id) / "evaluation.json"

    def get_report_md_path(self, session_id: str) -> Path:
        """Get path to report.md file."""
        return self.get_report_dir(session_id) / "report.md"

    def ensure_dirs(self, session_id: str) -> None:
        """Create necessary directories for a session."""
        self.get_codes_dir(session_id).mkdir(parents=True, exist_ok=True)
        self.get_sessions_dir(session_id).mkdir(parents=True, exist_ok=True)
        self.get_report_dir(session_id).mkdir(parents=True, exist_ok=True)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "output_dir": str(self.output_dir),
            "pi_path": self.pi_path,
            "auto_approve": self.auto_approve,
            "timeout": self.timeout,
            "phase_weights": self.phase_weights,
            "verbose": self.verbose,
        }


def load_config(
    output_dir: Path | None = None,
    verbose: bool = False,
    config_file: Path | None = None,
) -> Config:
    """Load configuration from multiple sources.

    Priority: CLI args > env vars > config file > defaults
    """
    # Start with defaults
    config_dict: dict[str, Any] = {}

    # Load from config file if provided
    if config_file and config_file.exists():
        config_dict.update(Config.from_file(config_file).to_dict())

    # Load from environment
    env_config = Config.from_env().to_dict()
    for key, value in env_config.items():
        if key not in config_dict:
            config_dict[key] = value

    # Override with CLI arguments
    if output_dir is not None:
        config_dict["output_dir"] = output_dir
    if verbose is not None:
        config_dict["verbose"] = verbose

    return Config(**config_dict)
