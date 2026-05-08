"""Tests for pi_evaluator.config module."""

from pathlib import Path

import pytest

from pi_evaluator.config import (
    DEFAULTS,
    Config,
    ConfigError,
    load_config,
)


class TestConfig:
    """Tests for Config dataclass."""

    def test_default_config(self):
        """Test default configuration values."""
        config = Config()
        assert config.output_dir == Path(DEFAULTS["output_dir"])
        assert config.pi_path == DEFAULTS["pi_path"]
        assert config.auto_approve is True
        assert config.timeout == DEFAULTS["timeout"]
        assert config.phase_weights == {"design": 0.3, "review": 0.2, "execute": 0.3, "audit": 0.2}

    def test_custom_config(self):
        """Test custom configuration."""
        config = Config(
            output_dir=Path("/custom/path"),
            pi_path="/usr/local/bin/pi",
            auto_approve=False,
            timeout=7200,
        )
        assert config.output_dir == Path("/custom/path")
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

    def test_to_dict(self):
        """Test configuration serialization."""
        config = Config(output_dir=Path("/test"))
        data = config.to_dict()
        assert data["output_dir"] == "/test"
        assert data["phase_weights"]["design"] == 0.3


class TestNewDirectoryStructure:
    """Tests for the new {id}/codes, {id}/sessions, {id}/report structure."""

    def test_get_codes_dir(self):
        """Test codes directory path."""
        config = Config(output_dir=Path("/data"))
        codes_dir = config.get_codes_dir("abc123")
        assert codes_dir == Path("/data/abc123/codes")

    def test_get_sessions_dir(self):
        """Test sessions directory path."""
        config = Config(output_dir=Path("/data"))
        sessions_dir = config.get_sessions_dir("abc123")
        assert sessions_dir == Path("/data/abc123/sessions")

    def test_get_report_dir(self):
        """Test report directory path."""
        config = Config(output_dir=Path("/data"))
        report_dir = config.get_report_dir("abc123")
        assert report_dir == Path("/data/abc123/report")

    def test_get_session_path(self):
        """Test session.jsonl path."""
        config = Config(output_dir=Path("/data"))
        session_path = config.get_session_path("abc123")
        assert session_path == Path("/data/abc123/sessions/session.jsonl")

    def test_get_evaluation_path(self):
        """Test evaluation.json path."""
        config = Config(output_dir=Path("/data"))
        eval_path = config.get_evaluation_path("abc123")
        assert eval_path == Path("/data/abc123/report/evaluation.json")

    def test_get_report_md_path(self):
        """Test report.md path."""
        config = Config(output_dir=Path("/data"))
        md_path = config.get_report_md_path("abc123")
        assert md_path == Path("/data/abc123/report/report.md")

    def test_ensure_dirs_creates_all_three(self, tmp_path):
        """Test ensure_dirs creates codes, sessions, and report subdirs."""
        config = Config(output_dir=tmp_path)
        config.ensure_dirs("abc123")

        assert (tmp_path / "abc123/codes").exists()
        assert (tmp_path / "abc123/sessions").exists()
        assert (tmp_path / "abc123/report").exists()


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