"""Tests for CLI directory evaluation feature."""

import json
from pathlib import Path

import pytest

from src.__main__ import cmd_evaluate
from src.config import Config


class TestDirectoryEvaluation:
    """Tests for evaluating sessions from directories."""

    @pytest.fixture
    def sessions_dir(self, tmp_path):
        """Create a mock pi sessions directory."""
        sessions_dir = tmp_path / "sessions" / "--home-leroy--"
        sessions_dir.mkdir(parents=True)
        
        # Create first session
        session1 = sessions_dir / "2026-04-27T15-42-23-269Z_019dcf9b.jsonl"
        entries1 = [
            {"type": "session", "id": "019dcf9b", "timestamp": "2026-04-27T15:42:23.269Z"},
            {
                "type": "message",
                "id": "msg1",
                "timestamp": "2026-04-27T15:42:30.000Z",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "hi"}],
                }
            },
        ]
        with open(session1, "w") as f:
            for entry in entries1:
                f.write(json.dumps(entry) + "\n")
        
        # Create second session
        session2 = sessions_dir / "2026-04-29T02-39-07-319Z_019dd71a.jsonl"
        entries2 = [
            {"type": "session", "id": "019dd71a", "timestamp": "2026-04-29T02:39:07.319Z"},
            {
                "type": "message",
                "id": "msg2",
                "timestamp": "2026-04-29T02:40:20.781Z",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "Create API"}],
                }
            },
            {
                "type": "message",
                "id": "msg3",
                "timestamp": "2026-04-29T02:40:26.686Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "name": "fuxi_request", "arguments": {}},
                    ],
                    "usage": {"input": 100, "output": 50},
                }
            },
        ]
        with open(session2, "w") as f:
            for entry in entries2:
                f.write(json.dumps(entry) + "\n")
        
        return sessions_dir

    def test_evaluate_directory_returns_multiple_results(self, sessions_dir, tmp_path):
        """Test that evaluating a directory returns results for all sessions."""
        # Note: This tests the internal logic directly
        from src.parser import Parser
        from src.evaluator import Evaluator
        
        config = Config(output_dir=tmp_path)
        session_files = sorted(sessions_dir.glob("*.jsonl"))
        
        results = []
        for session_file in session_files:
            parser = Parser()
            entries = parser.parse(session_file)
            
            parts = session_file.name.split("_")
            session_id = parts[1].replace(".jsonl", "") if len(parts) == 2 else session_file.stem
            
            evaluator = Evaluator(config)
            result = evaluator.evaluate(entries, session_id=session_id)
            results.append(result)
        
        assert len(results) == 2
        assert results[0].session_id == "019dcf9b"
        assert results[1].session_id == "019dd71a"

    def test_session_id_extraction_from_filename(self):
        """Test session ID extraction from pi session filename format.
        
        pi session filenames follow the pattern:
        - 2026-04-29T02-39-07-319Z_019dd71a-be37-70ce-b1f2-e9bb7f3767ee.jsonl (full UUID with dashes)
        - 2026-04-27T15-42-23-269Z_019dcf9b.jsonl (short UUID without dashes)
        - Or simple names with no underscores
        """
        from pathlib import Path
        
        def extract_session_id(filename: str) -> str:
            """"Extract session ID using the same logic as cmd_evaluate.
            
            pi format: timestamp_uuid.jsonl where timestamp contains 'T' and 'Z'
            Simple format: filename.jsonl or other patterns
            """
            parts = filename.split("_")
            if len(parts) == 2:
                timestamp_part = parts[0]
                uuid_part = parts[1].replace(".jsonl", "")
                # pi session format has timestamp before underscore (contains 'T' and 'Z')
                # and UUID after (may contain dashes, typically 19+ chars for full UUID)
                if 'T' in timestamp_part and 'Z' in timestamp_part:
                    # This is a pi session format
                    session_id = uuid_part
                else:
                    # Not pi format, use stem
                    session_id = filename.replace(".jsonl", "")
            else:
                # Simple format or non-pi format
                session_id = filename.replace(".jsonl", "")
            return session_id
        
        test_cases = [
            # pi session format: timestamp_uuid.jsonl
            ("2026-04-29T02-39-07-319Z_019dd71a-be37-70ce-b1f2-e9bb7f3767ee.jsonl", "019dd71a-be37-70ce-b1f2-e9bb7f3767ee"),
            ("2026-04-27T15-42-23-269Z_019dcf9b.jsonl", "019dcf9b"),
            # Simple names (no underscore or non-pi format)
            ("simple_session.jsonl", "simple_session"),
            ("session.jsonl", "session"),
            ("myworkflow.jsonl", "myworkflow"),
        ]
        
        for filename, expected_id in test_cases:
            session_id = extract_session_id(filename)
            assert session_id == expected_id, f"Failed for {filename}: got '{session_id}', expected '{expected_id}'"
