"""pi_evaluator.parser - JSONL parsing for pi session logs.

Parses session log files in JSONL format into structured SessionLogEntry objects.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from pi_evaluator.types import ContentBlock, Phase, SessionLogEntry


class ParserError(Exception):
    """Parser error exception."""

    pass


class Parser:
    """Parser for pi session JSONL files.

    Parses session logs with format:
        {"type": "message", "timestamp": "...", "message": {...}}
        {"type": "message", "timestamp": "...", "message": {...}}
    """

    def __init__(self, strict: bool = False):
        """Initialize parser.

        Args:
            strict: If True, raise on malformed lines; if False, skip them

        """
        self.strict = strict
        self.line_count = 0
        self.error_count = 0

    def parse(self, path: Path) -> list[SessionLogEntry]:
        """Parse a JSONL file into a list of SessionLogEntry objects.

        Args:
            path: Path to session.jsonl file

        Returns:
            List of SessionLogEntry objects

        Raises:
            ParserError: If file cannot be read

        """
        if not path.exists():
            raise ParserError(f"Session file not found: {path}") from None

        entries = []
        self.line_count = 0
        self.error_count = 0

        try:
            with open(path) as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue

                    self.line_count += 1
                    try:
                        entry = SessionLogEntry.from_jsonl_line(line)
                        entries.append(entry)
                    except (json.JSONDecodeError, KeyError, ValueError) as e:
                        self.error_count += 1
                        if self.strict:
                            raise ParserError(f"Line {line_num}: {e}") from e
                        # Non-strict mode: skip malformed lines

        except OSError as e:
            raise ParserError(f"Failed to read file: {e}") from e

        return entries

    def parse_iter(self, path: Path) -> Iterator[SessionLogEntry]:
        """Parse a JSONL file iteratively (memory-efficient for large files).

        Args:
            path: Path to session.jsonl file

        Yields:
            SessionLogEntry objects

        """
        if not path.exists():
            raise ParserError(f"Session file not found: {path}") from None

        self.line_count = 0
        self.error_count = 0

        try:
            with open(path) as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue

                    self.line_count += 1
                    try:
                        entry = SessionLogEntry.from_jsonl_line(line)
                        yield entry
                    except (json.JSONDecodeError, KeyError, ValueError) as e:
                        self.error_count += 1
                        if self.strict:
                            raise ParserError(f"Line {line_num}: {e}") from e
        except OSError as e:
            raise ParserError(f"Failed to read file: {e}") from e

    def get_entries_by_type(
        self, entries: list[SessionLogEntry], entry_type: str
    ) -> list[SessionLogEntry]:
        """Filter entries by type."""
        return [e for e in entries if e.type == entry_type]

    def get_message_entries(self, entries: list[SessionLogEntry]) -> list[SessionLogEntry]:
        """Get only message-type entries."""
        return self.get_entries_by_type(entries, "message")

    def get_tool_calls(
        self, entries: list[SessionLogEntry]
    ) -> list[tuple[SessionLogEntry, ContentBlock]]:
        """Extract all tool calls from entries.

        Returns:
            List of (entry, tool_call) tuples

        """
        calls = []
        for entry in entries:
            if entry.message:
                for block in entry.message.content:
                    if block.type == "toolCall":
                        calls.append((entry, block))
        return calls

    def get_session_duration(self, entries: list[SessionLogEntry]) -> float | None:
        """Calculate session duration in seconds.

        Returns:
            Duration in seconds, or None if insufficient data

        """
        from datetime import datetime

        timestamps = []
        for entry in entries:
            try:
                dt = datetime.fromisoformat(entry.timestamp.replace("Z", "+00:00"))
                timestamps.append(dt)
            except ValueError:
                continue

        if len(timestamps) < 2:
            return None

        timestamps.sort()
        delta = timestamps[-1] - timestamps[0]
        return delta.total_seconds()

    def detect_phases(self, entries: list[SessionLogEntry]) -> dict[Phase, list[SessionLogEntry]]:
        """Detect and categorize entries by workflow phase.

        Returns:
            Dictionary mapping Phase to list of entries

        """
        from pi_evaluator.types import detect_phase

        phases: dict[Phase, list[SessionLogEntry]] = {
            Phase.DESIGN: [],
            Phase.REVIEW: [],
            Phase.EXECUTE: [],
            Phase.AUDIT: [],
        }

        current_phase: Phase | None = None

        for entry in entries:
            if entry.type == "session_start":
                continue
            if entry.type == "session_end":
                break

            if entry.message:
                for block in entry.message.content:
                    if block.type == "toolCall" and block.name:
                        phase = detect_phase(block.name)
                        if phase and phase in phases:
                            current_phase = phase
                            phases[phase].append(entry)

            # Assign entries to current phase
            if current_phase and entry.type == "message":
                phases[current_phase].append(entry)

        return phases

    def get_statistics(self, entries: list[SessionLogEntry]) -> dict[str, Any]:
        """Get parsing statistics.

        Returns:
            Dictionary with parsing statistics

        """
        return {
            "total_lines": self.line_count,
            "total_entries": len(entries),
            "error_count": self.error_count,
            "error_rate": self.error_count / max(1, self.line_count),
            "message_entries": len(self.get_message_entries(entries)),
            "tool_calls": len(self.get_tool_calls(entries)),
        }
