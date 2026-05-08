"""pi_evaluator.runner - Workflow execution for Four Sages.

Spawns pi subprocess, monitors phase transitions, and keeps workflow running.
Auto-proceeds: detects phase completion and sends next command automatically.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path

from pi_evaluator.config import Config


class RunnerError(Exception):
    """Runner error exception."""

    pass


class Runner:
    """Runner for executing Four Sages workflows.

    Orchestrates:
    1. Environment validation
    2. Session directory creation
    3. pi subprocess spawning
    4. Phase monitoring and auto-proceed
    5. Session log capture
    """

    # Patterns for phase/tool completion detection
    COMPLETION_PATTERNS = [
        # Tool success patterns
        re.compile(r'"success":\s*true', re.I),
        re.compile(r'draft.*created', re.I),
        re.compile(r'score:\s*\d+', re.I),
        re.compile(r'(?:task|phase).*(?:complete|done|finished)', re.I),
        re.compile(r'verdict.*(?:APPROVED|PASS)', re.I),
        re.compile(r'✅|✓', re.I),
        # Workflow completion
        re.compile(r'workflow.*(?:complete|ended|archived)', re.I),
        re.compile(r'phase.*complete', re.I),
    ]

    # Patterns for workflow end
    WORKFLOW_END_PATTERNS = [
        re.compile(r'workflow.*archived', re.I),
        re.compile(r'phase.*complete', re.I),
        re.compile(r'\$'),  # pi prompt marker
    ]

    def __init__(self, config: Config):
        """Initialize runner.

        Args:
            config: Configuration object

        """
        self.config = config
        self.session_id = ""
        self.process: subprocess.Popen | None = None
        self.output_thread: threading.Thread | None = None
        self.should_continue = threading.Event()
        self.is_complete = threading.Event()
        self.output_buffer: list[str] = []
        self._lock = threading.Lock()
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
            request: Workflow request string
            auto_approve: Enable auto-proceed (default: from config)
            timeout: Override timeout (default: from config)

        Returns:
            Path to session.jsonl file

        Raises:
            RunnerError: If workflow execution fails

        """
        # Generate session ID
        self.session_id = self.generate_session_id()
        self._sent_commands = []

        # Get settings
        if auto_approve is None:
            auto_approve = self.config.auto_approve
        if timeout is None:
            timeout = self.config.timeout

        # Create directories
        self.config.ensure_dirs(self.session_id)
        session_path = self.config.get_session_path(self.session_id)

        if self.config.verbose:
            print(f"Starting workflow: session_id={self.session_id}")
            print(f"Session path: {session_path}")
            print(f"Auto-proceed: {auto_approve}")

        # Spawn pi subprocess
        self._spawn_subprocess(request, session_path, auto_approve, timeout)

        return session_path

    def _spawn_subprocess(
        self, request: str, session_path: Path, auto_proceed: bool, timeout: int
    ) -> None:
        """Spawn pi subprocess with monitoring."""
        try:
            # Set up environment
            env = os.environ.copy()
            env["PI_SESSION_LOG"] = str(session_path)

            # Spawn process
            self.process = subprocess.Popen(
                [self.config.pi_path, "--print"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=env,
            )

            # Start output monitor thread
            self.output_thread = threading.Thread(
                target=self._monitor_output,
                args=(session_path,),
                daemon=True,
            )
            self.output_thread.start()

            # Send initial request
            if self.config.verbose:
                print(f"Sending request: {request[:50]}...")

            self.process.stdin.write(request + "\n")
            self.process.stdin.flush()

            # Monitor for phases and keep workflow running
            if auto_proceed:
                self._auto_proceed_loop(timeout)
            else:
                # Just wait for completion or timeout
                self.process.wait(timeout=timeout)

        except subprocess.TimeoutExpired:
            self._terminate()
            raise RunnerError(f"Workflow timed out after {timeout}s") from None
        except OSError as e:
            raise RunnerError(f"Failed to spawn pi subprocess: {e}") from e
        except Exception as e:
            self._terminate()
            raise RunnerError(f"Workflow execution failed: {e}") from e

    def _monitor_output(self, session_path: Path) -> None:
        """Monitor stdout and capture session logs."""
        if not self.process or not self.process.stdout:
            return

        try:
            for line in iter(self.process.stdout.readline, ""):
                if not line:
                    break

                # Add to buffer
                with self._lock:
                    self.output_buffer.append(line.rstrip())

                    # Check for completion patterns
                    for pattern in self.COMPLETION_PATTERNS:
                        if pattern.search(line):
                            self.should_continue.set()
                            break

                    # Check for workflow end
                    for pattern in self.WORKFLOW_END_PATTERNS:
                        if pattern.search(line):
                            self.is_complete.set()
                            break

                    # Detect session log path
                    if "session" in line.lower() and ".jsonl" in line:
                        # Could extract path here if needed
                        pass

        except Exception:
            pass  # Process may have ended

    def _auto_proceed_loop(self, timeout: int) -> None:
        """Auto-proceed: detect phase completion and send next command.

        The workflow auto-proceeds based on tool completion.
        We just keep it running and detect completion patterns.
        """
        start_time = time.time()
        last_activity = start_time
        activity_count = 0
        max_activity = 20  # Safety limit for command injections

        while activity_count < max_activity:
            # Check timeout
            elapsed = time.time() - start_time
            if elapsed > timeout:
                self._terminate()
                raise RunnerError(f"Workflow timed out after {timeout}s") from None

            # Check if workflow is complete
            if self._is_workflow_complete():
                break

            # Wait for activity (completion signal)
            if self.should_continue.wait(timeout=3):
                self.should_continue.clear()
                last_activity = time.time()
                activity_count += 1

                # Wait for output stabilization
                time.sleep(0.3)

                # Determine next command based on current activity
                next_cmd = self._get_next_command()
                if next_cmd:
                    self._send_command(next_cmd)
                    if self.config.verbose:
                        print(f"Auto-proceed: sent '/{next_cmd}' (#{activity_count})")

            # Check if no activity for extended time (workflow might be idle/waiting)
            idle_time = time.time() - last_activity
            if idle_time > 10 and activity_count < max_activity:
                # Check if workflow is still running
                if self.process and self.process.poll() is None:
                    last_activity = time.time()
                    # Try to detect if we need to send a command

            # Check if process ended
            if self.process and self.process.poll() is not None:
                break

        # Wait for final output
        time.sleep(1)

        # Wait for process to finish
        if self.process:
            try:
                self.process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self._terminate()

    def _is_workflow_complete(self) -> bool:
        """Check if workflow has completed."""
        if self.is_complete.is_set():
            return True

        # Check output buffer for completion patterns
        with self._lock:
            for line in self.output_buffer:
                if "workflow" in line.lower() and "complete" in line.lower():
                    return True
                if "archived" in line.lower():
                    return True

        return False

    def _get_next_command(self) -> str | None:
        """Get next command based on current state.

        Note: The actual workflow logic is handled by pi/agent.
        This just provides hints for continuation if needed.
        """
        # Check state.json to determine current phase
        state = self._read_state()
        if not state:
            return None

        phase = state.get("phase", "")

        # Map phase to next logical command
        phase_to_next = {
            "design": "qiaochui-review",
            "plan": "luban-execute-all",
            "implement": "gaoyao-review",
            "review": "fuxi-end",
        }

        return phase_to_next.get(phase)

    def _read_state(self) -> dict | None:
        """Read current workflow state from state.json."""
        # Try to find state.json in common locations
        possible_paths = [
            ".sages/workspace/state.json",
            Path.cwd() / ".sages" / "workspace" / "state.json",
        ]

        for path in possible_paths:
            full_path = Path(path)
            if full_path.exists():
                try:
                    with open(full_path) as f:
                        return json.load(f)
                except Exception:
                    pass

        return None

    def _send_command(self, command: str) -> None:
        """Send command to pi process."""
        if self.process and self.process.stdin:
            try:
                self.process.stdin.write(f"/{command}\n")
                self.process.stdin.flush()
                self._sent_commands.append(command)
            except OSError:
                pass

    def _terminate(self) -> None:
        """Terminate the subprocess."""
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
            except OSError:
                pass

    def get_output(self) -> list[str]:
        """Get captured output lines."""
        with self._lock:
            return self.output_buffer.copy()

    def get_session_id(self) -> str:
        """Get current session ID."""
        return self.session_id

    def get_sent_commands(self) -> list[str]:
        """Get list of auto-sent commands."""
        return self._sent_commands.copy()