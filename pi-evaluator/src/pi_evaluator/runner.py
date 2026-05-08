"""pi_evaluator.runner - Workflow execution for Four Sages.

Runs Four Sages workflows using pi --print mode with comprehensive requests.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from pathlib import Path

from pi_evaluator.config import Config


class RunnerError(Exception):
    """Runner error exception."""

    pass


class APIKeyMissingError(RunnerError):
    """No API keys configured for pi."""

    pass


class Runner:
    """Runner for executing Four Sages workflows.

    Uses pi --print mode with a comprehensive request that guides
    the agent through all workflow phases automatically.
    """

    def __init__(self, config: Config):
        """Initialize runner.

        Args:
            config: Configuration object

        """
        self.config = config
        self.session_id = ""
        self.output_buffer: list[str] = []
        self._sent_commands: list[str] = []

    def generate_session_id(self) -> str:
        """Generate unique session ID from UUID4."""
        return str(uuid.uuid4())[:8]

    def run_workflow(
        self,
        request: str,
        auto_approve: bool | None = None,
        timeout: int | None = None,
    ) -> Path:
        """Run a Four Sages workflow.

        Args:
            request: Workflow request string (initial command or full workflow)
            auto_approve: Enable auto-proceed (not used - always enabled in --print mode)
            timeout: Override timeout (default: from config)

        Returns:
            Path to session.jsonl file

        Raises:
            RunnerError: If workflow execution fails

        """
        # Generate session ID
        self.session_id = self.generate_session_id()
        self._sent_commands = []
        self.output_buffer = []

        # Get settings
        if timeout is None:
            timeout = self.config.timeout

        # Create directories
        self.config.ensure_dirs(self.session_id)
        session_path = self.config.get_session_path(self.session_id)

        if self.config.verbose:
            print(f"Starting workflow: session_id={self.session_id}")
            print(f"Session path: {session_path}")

        # Check for API keys first
        if not self._has_api_keys():
            raise APIKeyMissingError(
                "No API keys configured for pi. "
                "Please set at least one API key environment variable."
            )

        # Build comprehensive request
        full_request = self._build_full_request(request)

        # Run pi in --print mode
        self._run_print_mode(full_request, session_path, timeout)

        return session_path

    def _has_api_keys(self) -> bool:
        """Check if any API keys are configured."""
        api_key_vars = [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GOOGLE_API_KEY",
            "GEMINI_API_KEY",
            "DEEPSEEK_API_KEY",
            "AZURE_OPENAI_API_KEY",
            "GROQ_API_KEY",
        ]
        return any(os.environ.get(var) for var in api_key_vars)

    def _build_full_request(self, request: str) -> str:
        """Build a comprehensive request that runs the full workflow."""
        # Check if request is already a full workflow command
        if "qiaochui-review" in request or "luban-execute" in request:
            return request

        # Build a request that guides through all phases
        return f"""{request}

Please execute the complete Four Sages workflow:
1. Start with fuxi-start to initialize the workflow
2. Create MDD design draft with fuxi-request
3. Review the draft with qiaochui-review (aim for score > 80)
4. Decompose into tasks with qiaochui-decompose
5. Execute tasks with luban-execute-all (follow TDD: RED → GREEN → REFACTOR)
6. Audit quality with gaoyao-review
7. Archive with fuxi-end

Show progress and summary at the end. Be concise but complete all phases."""

    def _run_print_mode(
        self, request: str, session_path: Path, timeout: int
    ) -> None:
        """Run pi in --print mode with the given request."""
        try:
            # Build command
            cmd = [self.config.pi_path, "--print"]
            
            if os.environ.get("DEEPSEEK_API_KEY"):
                cmd.extend(["--model", "deepseek/deepseek-v4-flash"])
            elif os.environ.get("ANTHROPIC_API_KEY"):
                cmd.extend(["--model", "claude-sonnet-4-20250514"])
            elif os.environ.get("OPENAI_API_KEY"):
                cmd.extend(["--model", "gpt-4o-mini"])

            if self.config.verbose:
                print(f"Running: {' '.join(cmd[:4])}...")

            # Set up environment
            env = os.environ.copy()
            env["PI_SESSION_LOG"] = str(session_path)

            # Spawn process
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )

            # Send request
            process.stdin.write(request + "\n")
            process.stdin.flush()
            process.stdin.close()

            # Wait for completion
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                raise RunnerError(f"Workflow timed out after {timeout}s") from None

            # Capture output
            self.output_buffer = stdout.splitlines()

            # Write session entries
            self._write_session_entries(session_path, stdout)

            if self.config.verbose:
                print(f"Completed. Output: {len(self.output_buffer)} lines")
                if stderr:
                    print(f"Stderr: {stderr[:200]}")

        except OSError as e:
            raise RunnerError(f"Failed to spawn pi subprocess: {e}") from e
        except Exception as e:
            raise RunnerError(f"Workflow execution failed: {e}") from e

    def _write_session_entries(self, session_path: Path, output: str) -> None:
        """Write session entries to JSONL file."""
        from datetime import datetime
        
        # Split output into logical chunks (by line groups or blank lines)
        lines = output.split("\n")
        
        try:
            with open(session_path, "w") as f:
                current_entry = ""
                for line in lines:
                    if line.strip() == "" and current_entry:
                        # Write accumulated entry
                        entry = {
                            "type": "message",
                            "timestamp": datetime.utcnow().isoformat() + "Z",
                            "content": current_entry.strip(),
                        }
                        f.write(json.dumps(entry) + "\n")
                        current_entry = ""
                    else:
                        current_entry += line + "\n"
                
                # Write final entry if any
                if current_entry.strip():
                    entry = {
                        "type": "message",
                        "timestamp": datetime.utcnow().isoformat() + "Z",
                        "content": current_entry.strip(),
                    }
                    f.write(json.dumps(entry) + "\n")
        except Exception as e:
            if self.config.verbose:
                print(f"Warning: Failed to write session file: {e}")

    def get_output(self) -> list[str]:
        """Get captured output lines."""
        return self.output_buffer.copy()

    def get_session_id(self) -> str:
        """Get current session ID."""
        return self.session_id

    def get_sent_commands(self) -> list[str]:
        """Get list of auto-sent commands."""
        return self._sent_commands.copy()
