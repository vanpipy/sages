"""Tests for evaluating pi sessions from directory paths.

This module tests support for evaluating sessions from:
- pi sessions directory: ~/.pi/agent/sessions/--home-leroy--
- Individual session files
"""

import json
from pathlib import Path

import pytest

from src.config import Config


class TestPiSessionsDirectory:
    """Tests for pi sessions directory evaluation."""

    @pytest.fixture
    def pi_sessions_dir(self, tmp_path):
        """Create a mock pi sessions directory structure."""
        sessions_dir = tmp_path / "sessions" / "--home-leroy--"
        sessions_dir.mkdir(parents=True)
        
        # Create first session
        session1 = sessions_dir / "2026-04-27T15-42-23-269Z_019dcf9b-2024-7109-98b7-de34cd24e0cd.jsonl"
        entries1 = [
            {
                "type": "session",
                "id": "019dcf9b",
                "timestamp": "2026-04-27T15:42:23.269Z",
            },
            {
                "type": "message",
                "id": "msg1",
                "timestamp": "2026-04-27T15:42:30.000Z",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "hi"}],
                }
            },
            {
                "type": "message",
                "id": "msg2",
                "timestamp": "2026-04-27T15:42:31.000Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Hi! How can I help you today?"}
                    ],
                    "usage": {"input": 100, "output": 50},
                }
            }
        ]
        with open(session1, "w") as f:
            for entry in entries1:
                f.write(json.dumps(entry) + "\n")
        
        # Create second session (longer, with tool calls)
        session2 = sessions_dir / "2026-04-29T02-39-07-319Z_019dd71a-be37-70ce-b1f2-e9bb7f3767ee.jsonl"
        entries2 = [
            {
                "type": "session",
                "id": "019dd71a",
                "timestamp": "2026-04-29T02:39:07.319Z",
            },
            {
                "type": "message",
                "id": "msg3",
                "timestamp": "2026-04-29T02:40:20.781Z",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "Create a REST API"}],
                }
            },
            {
                "type": "message",
                "id": "msg4",
                "timestamp": "2026-04-29T02:40:26.686Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "I'll help you create a REST API."},
                        {"type": "toolCall", "name": "fuxi_request", "arguments": {"request": "REST API"}},
                    ],
                    "usage": {"input": 200, "output": 150},
                }
            },
            {
                "type": "message",
                "id": "msg5",
                "timestamp": "2026-04-29T02:40:30.000Z",
                "message": {
                    "role": "toolResult",
                    "content": [{"type": "toolResult", "content": "Draft created"}],
                }
            }
        ]
        with open(session2, "w") as f:
            for entry in entries2:
                f.write(json.dumps(entry) + "\n")
        
        return sessions_dir

    def test_detect_session_files_in_directory(self, pi_sessions_dir):
        """Test detecting session files in a pi sessions directory."""
        session_files = list(pi_sessions_dir.glob("*.jsonl"))
        assert len(session_files) == 2
        
        # Files should be sorted by timestamp
        filenames = [f.name for f in session_files]
        assert any("019dcf9b" in f for f in filenames)
        assert any("019dd71a" in f for f in filenames)

    def test_get_latest_session(self, pi_sessions_dir):
        """Test getting the latest session file."""
        session_files = sorted(
            pi_sessions_dir.glob("*.jsonl"),
            key=lambda f: f.name
        )
        latest = session_files[-1]
        assert "019dd71a" in latest.name

    def test_parse_session_id_from_filename(self, pi_sessions_dir):
        """Test extracting session ID from pi session filename."""
        from src.parser import Parser
        
        # pi session filenames: 2026-04-29T02-39-07-319Z_019dd71a-be37-70ce-b1f2-e9bb7f3767ee.jsonl
        filename = "2026-04-29T02-39-07-319Z_019dd71a-be37-70ce-b1f2-e9bb7f3767ee.jsonl"
        
        # Session ID is the second part after underscore
        parts = filename.split("_")
        assert len(parts) == 2
        session_id = parts[1].replace(".jsonl", "")
        assert session_id == "019dd71a-be37-70ce-b1f2-e9bb7f3767ee"

    def test_evaluate_all_sessions_in_directory(self, pi_sessions_dir, tmp_path):
        """Test evaluating all sessions in a pi sessions directory."""
        from src.parser import Parser
        from src.evaluator import Evaluator
        
        config = Config(output_dir=tmp_path)
        
        session_files = sorted(pi_sessions_dir.glob("*.jsonl"))
        results = []
        
        for session_file in session_files:
            parser = Parser()
            entries = parser.parse(session_file)
            
            # Extract session ID from filename
            parts = session_file.name.split("_")
            session_id = parts[1].replace(".jsonl", "") if len(parts) == 2 else session_file.stem
            
            evaluator = Evaluator(config)
            result = evaluator.evaluate(entries, session_id=session_id)
            results.append(result)
        
        assert len(results) == 2
        # First session should have lower tool call count
        assert results[0].overall.total_tool_calls == 0
        # Second session should have tool calls
        assert results[1].overall.total_tool_calls == 1

    def test_pi_sessions_directory_path_handling(self, pi_sessions_dir):
        """Test handling of pi sessions directory path format."""
        # pi sessions directories have special characters
        path_str = str(pi_sessions_dir)
        assert "--home-leroy--" in path_str
        
        # Path should exist and be a directory
        path = Path(pi_sessions_dir)
        assert path.exists()
        assert path.is_dir()
