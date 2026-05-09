"""Tests for pi session JSONL format parsing.

This module tests support for the pi coding agent session format:
- type: "session" - session start marker
- type: "model_change" - model change event
- type: "thinking_level_change" - thinking level change
- type: "message" - message with nested message field
"""

import json
from pathlib import Path

import pytest

from src.parser import Parser
from src.types import ContentBlock, Message, Phase


class TestPiSessionFormat:
    """Tests for pi session JSONL format parsing."""

    @pytest.fixture
    def pi_session_jsonl(self, tmp_path):
        """Create a sample pi session JSONL file."""
        file_path = tmp_path / "pi_session.jsonl"
        entries = [
            # Session start
            {
                "type": "session",
                "version": 3,
                "id": "019dd71a-be37-70ce-b1f2-e9bb7f3767ee",
                "timestamp": "2026-04-29T02:39:07.319Z",
                "cwd": "/home/leroy"
            },
            # Model change
            {
                "type": "model_change",
                "id": "1383ebba",
                "parentId": None,
                "timestamp": "2026-04-29T02:39:07.361Z",
                "provider": "minimax-cn",
                "modelId": "MiniMax-M2.7"
            },
            # Thinking level change
            {
                "type": "thinking_level_change",
                "id": "f40a70c6",
                "parentId": "1383ebba",
                "timestamp": "2026-04-29T02:39:07.361Z",
                "thinkingLevel": "medium"
            },
            # User message
            {
                "type": "message",
                "id": "721c7df0",
                "parentId": "f40a70c6",
                "timestamp": "2026-04-29T02:40:20.781Z",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "Please help me to config the subagents"
                        }
                    ],
                    "timestamp": 1777430420778
                }
            },
            # Assistant message with tool calls
            {
                "type": "message",
                "id": "440cf390",
                "parentId": "721c7df0",
                "timestamp": "2026-04-29T02:40:26.686Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "thinking",
                            "thinking": "The user is asking about configuring subagents"
                        },
                        {
                            "type": "text",
                            "text": "I'd be happy to help you configure subagents!"
                        },
                        {
                            "type": "toolCall",
                            "id": "call_function_abc123",
                            "name": "read",
                            "arguments": {"path": "/some/file.md"}
                        },
                        {
                            "type": "toolCall",
                            "id": "call_function_def456",
                            "name": "bash",
                            "arguments": {"command": "ls -la"}
                        }
                    ],
                    "api": "anthropic-messages",
                    "provider": "minimax-cn",
                    "model": "MiniMax-M2.7",
                    "usage": {
                        "input": 365,
                        "output": 108,
                        "cacheRead": 2293,
                        "cacheWrite": 0,
                        "totalTokens": 2766
                    },
                    "stopReason": "toolUse",
                    "timestamp": 1777430420822,
                    "responseId": "0640a29af431d5b378d8f0191c1b573b"
                }
            },
            # Tool result
            {
                "type": "message",
                "id": "abc123",
                "parentId": "440cf390",
                "timestamp": "2026-04-29T02:40:30.000Z",
                "message": {
                    "role": "toolResult",
                    "content": [
                        {
                            "type": "toolResult",
                            "id": "call_function_abc123",
                            "content": "File contents here...",
                            "isError": False
                        }
                    ],
                    "timestamp": 1777430430000
                }
            },
            # Error tool result
            {
                "type": "message",
                "id": "def456",
                "parentId": "440cf390",
                "timestamp": "2026-04-29T02:40:31.000Z",
                "message": {
                    "role": "toolResult",
                    "content": [
                        {
                            "type": "toolResult",
                            "id": "call_function_def456",
                            "content": "ENOENT: no such file",
                            "isError": True
                        }
                    ],
                    "timestamp": 1777430431000
                }
            }
        ]
        with open(file_path, "w") as f:
            for entry in entries:
                f.write(json.dumps(entry) + "\n")
        return file_path

    def test_parse_pi_session_format(self, pi_session_jsonl):
        """Test parsing pi session JSONL format."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Should parse all 7 entries
        assert len(entries) == 7

    def test_session_start_entry(self, pi_session_jsonl):
        """Test parsing session start entry."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # First entry is session marker
        assert entries[0].type == "session_start"
        assert entries[0].timestamp == "2026-04-29T02:39:07.319Z"

    def test_model_change_entry(self, pi_session_jsonl):
        """Test parsing model change entry."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Second entry is model change
        assert entries[1].type == "model_change"
        assert entries[1].timestamp == "2026-04-29T02:39:07.361Z"

    def test_thinking_level_change_entry(self, pi_session_jsonl):
        """Test parsing thinking level change entry."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Third entry is thinking level change
        assert entries[2].type == "thinking_level_change"
        assert entries[2].timestamp == "2026-04-29T02:39:07.361Z"

    def test_user_message_parsing(self, pi_session_jsonl):
        """Test parsing user message with text content."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Fourth entry is user message
        user_msg = entries[3]
        assert user_msg.type == "message"
        assert user_msg.message is not None
        assert user_msg.message.role == "user"
        
        # Check text content block
        text_block = user_msg.message.content[0]
        assert text_block.type == "text"
        assert text_block.content == "Please help me to config the subagents"

    def test_assistant_message_parsing(self, pi_session_jsonl):
        """Test parsing assistant message with tool calls."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Fifth entry is assistant message
        assistant_msg = entries[4]
        assert assistant_msg.type == "message"
        assert assistant_msg.message.role == "assistant"
        
        # Check content blocks
        blocks = assistant_msg.message.content
        block_types = [b.type for b in blocks]
        assert "thinking" in block_types
        assert "text" in block_types
        assert "toolCall" in block_types
        
        # Check tool calls
        tool_calls = [b for b in blocks if b.type == "toolCall"]
        assert len(tool_calls) == 2
        assert tool_calls[0].name == "read"
        assert tool_calls[0].arguments == {"path": "/some/file.md"}
        assert tool_calls[1].name == "bash"
        assert tool_calls[1].arguments == {"command": "ls -la"}

    def test_usage_extraction(self, pi_session_jsonl):
        """Test extracting token usage from assistant messages."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Fifth entry is assistant with usage
        assistant_msg = entries[4]
        assert assistant_msg.message.usage is not None
        # Pi format uses 'input'/'output' keys
        assert assistant_msg.message.usage.get("prompt_tokens") == 365
        assert assistant_msg.message.usage.get("completion_tokens") == 108

    def test_tool_result_parsing(self, pi_session_jsonl):
        """Test parsing tool result messages."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Sixth entry is tool result (success)
        tool_result = entries[5]
        assert tool_result.type == "message"
        assert tool_result.message.role == "toolResult"
        
        result_block = tool_result.message.content[0]
        assert result_block.type == "toolResult"
        assert result_block.content == "File contents here..."
        assert result_block.is_error is False

    def test_error_tool_result_parsing(self, pi_session_jsonl):
        """Test parsing error tool result messages."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Seventh entry is tool result (error)
        error_result = entries[6]
        assert error_result.type == "message"
        assert error_result.message.role == "toolResult"
        
        result_block = error_result.message.content[0]
        assert result_block.type == "toolResult"
        assert result_block.is_error is True
        assert "ENOENT" in str(result_block.content)

    def test_get_tool_calls_from_pi_session(self, pi_session_jsonl):
        """Test extracting all tool calls from pi session."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        tool_calls = parser.get_tool_calls(entries)
        assert len(tool_calls) == 2
        
        # Verify tool call details
        _, read_call = tool_calls[0]
        assert read_call.name == "read"
        assert read_call.arguments == {"path": "/some/file.md"}

    def test_get_errors_from_pi_session(self, pi_session_jsonl):
        """Test extracting error tool results from pi session."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Get all error tool results
        errors = []
        for entry in entries:
            if entry.message and entry.message.content:
                for block in entry.message.content:
                    if block.type == "toolResult" and block.is_error:
                        errors.append(block)
        
        assert len(errors) == 1
        assert errors[0].is_error is True

    def test_session_duration_from_pi_session(self, pi_session_jsonl):
        """Test calculating session duration from pi session entries."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        duration = parser.get_session_duration(entries)
        assert duration is not None
        # Duration should be from first to last timestamp (~54 seconds)
        assert duration > 50

    def test_statistics_from_pi_session(self, pi_session_jsonl):
        """Test parsing statistics from pi session."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        stats = parser.get_statistics(entries)
        assert stats["total_lines"] == 7
        assert stats["total_entries"] == 7
        assert stats["tool_calls"] == 2

    def test_detect_phases_from_tool_calls(self, pi_session_jsonl):
        """Test phase detection from tool call names."""
        parser = Parser()
        entries = parser.parse(pi_session_jsonl)
        
        # Create a test entry with a tool call that should be detected
        from src.types import SessionLogEntry
        
        design_entry = SessionLogEntry(
            type="message",
            timestamp="2026-04-29T02:40:00.000Z",
            message=Message(
                role="assistant",
                content=[
                    ContentBlock(
                        type="toolCall",
                        name="fuxi_create_draft",
                        arguments={"request": "test"}
                    )
                ]
            )
        )
        
        from src.types import detect_phase
        assert detect_phase("fuxi_create_draft") == Phase.DESIGN
        assert detect_phase("qiaochui_review") == Phase.REVIEW
        assert detect_phase("luban_execute_task") == Phase.EXECUTE
        assert detect_phase("gaoyao_review") == Phase.AUDIT
