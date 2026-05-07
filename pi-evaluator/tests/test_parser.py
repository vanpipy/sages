"""Tests for pi_evaluator.parser module."""

import json
from pathlib import Path

import pytest

from pi_evaluator.parser import Parser, ParserError
from pi_evaluator.types import Phase


class TestParser:
    """Tests for Parser class."""

    @pytest.fixture
    def sample_jsonl(self, tmp_path):
        """Create a sample JSONL file for testing."""
        file_path = tmp_path / "session.jsonl"
        entries = [
            {"type": "session_start", "timestamp": "2026-05-07T10:00:00Z", "message": None},
            {
                "type": "message",
                "timestamp": "2026-05-07T10:00:01Z",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "content": "Hello"}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 50},
                },
            },
            {
                "type": "message",
                "timestamp": "2026-05-07T10:00:02Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "name": "fuxi_create_draft",
                            "arguments": {"request": "test"},
                        }
                    ],
                },
            },
            {"type": "session_end", "timestamp": "2026-05-07T10:00:10Z", "message": None},
        ]
        with open(file_path, "w") as f:
            for entry in entries:
                f.write(json.dumps(entry) + "\n")
        return file_path

    def test_parse_file(self, sample_jsonl):
        """Test parsing a JSONL file."""
        parser = Parser()
        entries = parser.parse(sample_jsonl)
        assert len(entries) == 4
        assert parser.line_count == 4

    def test_parse_iter(self, sample_jsonl):
        """Test iterative parsing."""
        parser = Parser()
        entries = list(parser.parse_iter(sample_jsonl))
        assert len(entries) == 4

    def test_session_entry(self, sample_jsonl):
        """Test parsing session start/end entries."""
        parser = Parser()
        entries = parser.parse(sample_jsonl)
        assert entries[0].type == "session_start"
        assert entries[3].type == "session_end"

    def test_message_entry(self, sample_jsonl):
        """Test parsing message entries."""
        parser = Parser()
        entries = parser.parse(sample_jsonl)
        msg_entry = entries[1]
        assert msg_entry.type == "message"
        assert msg_entry.message.role == "user"
        assert len(msg_entry.message.content) == 1

    def test_tool_call_extraction(self, sample_jsonl):
        """Test extracting tool calls."""
        parser = Parser()
        entries = parser.parse(sample_jsonl)
        tool_calls = parser.get_tool_calls(entries)
        assert len(tool_calls) == 1
        entry, block = tool_calls[0]
        assert block.type == "toolCall"
        assert block.name == "fuxi_create_draft"

    def test_message_entries_filter(self, sample_jsonl):
        """Test filtering message entries."""
        parser = Parser()
        entries = parser.parse(sample_jsonl)
        msg_entries = parser.get_message_entries(entries)
        assert len(msg_entries) == 2

    def test_session_duration(self, sample_jsonl):
        """Test calculating session duration."""
        parser = Parser()
        entries = parser.parse(sample_jsonl)
        duration = parser.get_session_duration(entries)
        assert duration == 10.0  # 10 seconds

    def test_statistics(self, sample_jsonl):
        """Test parsing statistics."""
        parser = Parser()
        entries = parser.parse(sample_jsonl)
        stats = parser.get_statistics(entries)
        assert stats["total_lines"] == 4
        assert stats["total_entries"] == 4
        assert stats["tool_calls"] == 1
        assert stats["message_entries"] == 2

    def test_file_not_found(self):
        """Test error on missing file."""
        parser = Parser()
        with pytest.raises(ParserError, match="not found"):
            parser.parse(Path("/nonexistent/session.jsonl"))

    def test_strict_mode_malformed(self, tmp_path):
        """Test strict mode with malformed JSON."""
        file_path = tmp_path / "malformed.jsonl"
        with open(file_path, "w") as f:
            f.write('{"type": "message", "timestamp": "2026-05-07T10:00:00Z"}\n')
            f.write("this is not json\n")
            f.write('{"type": "message", "timestamp": "2026-05-07T10:00:01Z"}\n')

        # Non-strict mode: should skip malformed
        parser = Parser(strict=False)
        entries = parser.parse(file_path)
        assert len(entries) == 2
        assert parser.error_count == 1

        # Strict mode: should raise
        parser_strict = Parser(strict=True)
        with pytest.raises(ParserError, match="Line 2"):
            parser_strict.parse(file_path)


class TestPhaseDetection:
    """Tests for phase detection."""

    def test_detect_design_phase(self):
        """Test design phase detection."""
        from pi_evaluator.types import detect_phase

        assert detect_phase("fuxi_create_draft") == Phase.DESIGN
        assert detect_phase("fuxi_get_draft") == Phase.DESIGN
        assert detect_phase("fuxi_get_status") == Phase.DESIGN

    def test_detect_review_phase(self):
        """Test review phase detection."""
        from pi_evaluator.types import detect_phase

        assert detect_phase("qiaochui_review") == Phase.REVIEW
        assert detect_phase("qiaochui_decompose") == Phase.REVIEW

    def test_detect_execute_phase(self):
        """Test execute phase detection."""
        from pi_evaluator.types import detect_phase

        assert detect_phase("luban_execute_task") == Phase.EXECUTE
        assert detect_phase("luban_execute_all") == Phase.EXECUTE
        assert detect_phase("luban_get_status") == Phase.EXECUTE

    def test_detect_audit_phase(self):
        """Test audit phase detection."""
        from pi_evaluator.types import detect_phase

        assert detect_phase("gaoyao_review") == Phase.AUDIT
        assert detect_phase("gaoyao_check_security") == Phase.AUDIT

    def test_detect_unknown_phase(self):
        """Test unknown phase returns None."""
        from pi_evaluator.types import detect_phase

        assert detect_phase("unknown_tool") is None
        assert detect_phase("") is None
