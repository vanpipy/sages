"""Tests for pi_evaluator.config module."""

import os
import tempfile
from pathlib import Path

import pytest

from pi_evaluator.config import (
    Config,
    ConfigError,
    DEFAULTS,
    load_config,
)


class TestConfig:
    """Tests for Config dataclass."""

    def test_default_config(self):
        """Test default configuration values."""
        config = Config()
        assert config.output_dir == Path(DEFAULTS["output_dir"])
        assert config.session_subdir == DEFAULTS["session_subdir"]
        assert config.evaluation_subdir == DEFAULTS["evaluation_subdir"]
        assert config.pi_path == DEFAULTS["pi_path"]
        assert config.auto_approve is True
        assert config.timeout == DEFAULTS["timeout"]
        assert config.phase_weights == {"design": 0.3, "review": 0.2, "execute": 0.3, "audit": 0.2}

    def test_custom_config(self):
        """Test custom configuration."""
        config = Config(
            output_dir=Path("/custom/path"),
            session_subdir="custom_sessions",
            evaluation_subdir="custom_evals",
            pi_path="/usr/local/bin/pi",
            auto_approve=False,
            timeout=7200,
        )
        assert config.output_dir == Path("/custom/path")
        assert config.session_subdir == "custom_sessions"
        assert config.auto_approve is False
        assert config.timeout == 7200

    def test_invalid_phase_weights(self):
        """Test that invalid phase weights raise error."""
        with pytest.raises(ConfigError, match="must sum to 1.0"):
            Config(phase_weights={"design": 0.5, "review": 0.5, "execute": 0.5, "audit": 0.5})

    def test_invalid_timeout(self):
        """Test that invalid timeout raises error."""
        with pytest.raises(ConfigError, match="must be positive"):
            Config(timeout=0)

    def test_session_dir(self):
        """Test session directory path generation."""
        config = Config(output_dir=Path("/data"))
        session_dir = config.get_session_dir("abc123")
        assert session_dir == Path("/data/sessions/abc123")

    def test_evaluation_dir(self):
        """Test evaluation directory path generation."""
        config = Config(output_dir=Path("/data"))
        eval_dir = config.get_evaluation_dir("abc123")
        assert eval_dir == Path("/data/evaluations/abc123")

    def test_session_path(self):
        """Test session file path generation."""
        config = Config(output_dir=Path("/data"))
        session_path = config.get_session_path("abc123")
        assert session_path == Path("/data/sessions/abc123/session.jsonl")

    def test_to_dict(self):
        """Test configuration serialization."""
        config = Config(output_dir=Path("/test"))
        data = config.to_dict()
        assert data["output_dir"] == "/test"
        assert data["phase_weights"]["design"] == 0.3


class TestConfigFromEnv:
    """Tests for Config.from_env()."""

    def test_env_override(self, monkeypatch):
        """Test environment variable override."""
        monkeypatch.setenv("PI_EVALUATOR_OUTPUT_DIR", "/env/path")
        monkeypatch.setenv("PI_EVALUATOR_AUTO_APPROVE", "false")
        monkeypatch.setenv("PI_EVALUATOR_TIMEOUT", "1800")

        config = Config.from_env()
        assert config.output_dir == Path("/env/path")
        assert config.auto_approve is False
        assert config.timeout == 1800

    def test_env_auto_approve_true(self, monkeypatch):
        """Test auto_approve env parsing."""
        monkeypatch.setenv("PI_EVALUATOR_AUTO_APPROVE", "true")
        config = Config.from_env()
        assert config.auto_approve is True

    def test_env_auto_approve_yes(self, monkeypatch):
        """Test auto_approve env with 'yes'."""
        monkeypatch.setenv("PI_EVALUATOR_AUTO_APPROVE", "yes")
        config = Config.from_env()
        assert config.auto_approve is True

    def test_env_auto_approve_1(self, monkeypatch):
        """Test auto_approve env with '1'."""
        monkeypatch.setenv("PI_EVALUATOR_AUTO_APPROVE", "1")
        config = Config.from_env()
        assert config.auto_approve is True


class TestLoadConfig:
    """Tests for load_config function."""

    def test_load_default(self):
        """Test loading with defaults."""
        config = load_config()
        assert isinstance(config, Config)

    def test_load_with_output_dir(self, tmp_path):
        """Test loading with output_dir override."""
        config = load_config(output_dir=tmp_path)
        assert config.output_dir == tmp_path

    def test_load_with_verbose(self):
        """Test loading with verbose flag."""
        config = load_config(verbose=True)
        assert config.verbose is True
