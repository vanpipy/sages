"""
pi_evaluator.runner - Workflow execution with auto-approve

Spawns pi subprocess, monitors phase transitions, and injects auto-approve commands.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from pi_evaluator.config import Config


class RunnerError(Exception):
    """Runner error exception."""

    pass


class Runner:
    """
    Runner for executing Four Sages workflows with auto-approve.

    Orchestrates:
    1. Environment validation
    2. Session directory creation
    3. pi subprocess spawning
    4. Phase monitoring and auto-approve injection
    5. Session log capture
    """

    # Patterns for phase completion detection
    PHASE_PATTERNS = [
        # QiaoChui review output
        (re.compile(r"verdict.*(?:APPROVED|REVISE|REJECT)", re.I), "approve"),
        # LuBan status output
        (re.compile(r"(?:task|phase).*(?:complete|done|finished)", re.I), "approve"),
        # GaoYao audit output
        (re.compile(r"(?:quality|audit).*review.*complete", re.I), "approve"),
        # General completion markers
        (re.compile(r"✅|✓|complete|done|finished", re.I), "approve"),
    ]

    # Patterns for workflow completion
    WORKFLOW_COMPLETE_PATTERNS = [
        re.compile(r"workflow.*complete", re.I),
        re.compile(r"all phases.*finished", re.I),
        re.compile(r"\[DONE\]", re.I),
    ]

    def __init__(self, config: Config):
        """
        Initialize runner.

        Args:
            config: Configuration object
        """
        self.config = config
        self.session_id = ""
        self.process: Optional[subprocess.Popen] = None
        self.output_thread: Optional[threading.Thread] = None
        self.should_approve = threading.Event()
        self.is_complete = threading.Event()
        self.output_buffer: list[str] = []
        self._lock = threading.Lock()

    def generate_session_id(self) -> str:
        """Generate unique session ID from UUID4."""
        return str(uuid.uuid4())[:8]

    def run_workflow(
        self,
        request: str,
        auto_approve: Optional[bool] = None,
        timeout: Optional[int] = None,
    ) -> Path:
        """
        Run a Four Sages workflow with auto-approve.

        Args:
            request: Workflow request string
            auto_approve: Override auto-approve setting (default: from config)
            timeout: Override timeout (default: from config)

        Returns:
            Path to session.jsonl file

        Raises:
            RunnerError: If workflow execution fails
        """
        # Generate session ID
        self.session_id = self.generate_session_id()

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
            print(f"Auto-approve: {auto_approve}")

        # Spawn pi subprocess
        self._spawn_subprocess(request, session_path, auto_approve, timeout)

        return session_path

    def _spawn_subprocess(
        self, request: str, session_path: Path, auto_approve: bool, timeout: int
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

            # Send request
            if self.config.verbose:
                print(f"Sending request: {request[:50]}...")

            self.process.stdin.write(request + "\n")
            self.process.stdin.flush()

            # Monitor for phases and inject auto-approve
            if auto_approve:
                self._auto_approve_loop(timeout)
            else:
                # Just wait for completion or timeout
                self.process.wait(timeout=timeout)

        except subprocess.TimeoutExpired:
            self._terminate()
            raise RunnerError(f"Workflow timed out after {timeout}s")
        except OSError as e:
            raise RunnerError(f"Failed to spawn pi subprocess: {e}")
        except Exception as e:
            self._terminate()
            raise RunnerError(f"Workflow execution failed: {e}")

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

                    # Check for phase completion
                    for pattern, action in self.PHASE_PATTERNS:
                        if pattern.search(line):
                            self.should_approve.set()
                            break

                    # Check for workflow completion
                    for pattern in self.WORKFLOW_COMPLETE_PATTERNS:
                        if pattern.search(line):
                            self.is_complete.set()
                            break

                    # Detect session log path
                    if "session" in line.lower() and ".jsonl" in line:
                        # Could extract path here if needed
                        pass

        except Exception:
            pass  # Process may have ended

    def _auto_approve_loop(self, timeout: int) -> None:
        """Loop to detect phases and inject auto-approve."""
        start_time = time.time()
        approve_count = 0
        max_approves = 10  # Safety limit

        while approve_count < max_approves:
            # Check timeout
            elapsed = time.time() - start_time
            if elapsed > timeout:
                self._terminate()
                raise RunnerError(f"Workflow timed out after {timeout}s")

            # Check if complete
            if self.is_complete.is_set():
                break

            # Wait for approval signal
            if self.should_approve.wait(timeout=2):
                self.should_approve.clear()

                # Wait for output stabilization
                time.sleep(0.5)

                # Inject approve
                if self.process and self.process.stdin:
                    try:
                        self.process.stdin.write("/fuxi-approve\n")
                        self.process.stdin.flush()
                        approve_count += 1

                        if self.config.verbose:
                            print(f"Auto-approved phase #{approve_count}")

                    except OSError:
                        break

            # Check if process ended
            if self.process and self.process.poll() is not None:
                break

        # Wait for process to finish
        if self.process:
            try:
                self.process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self._terminate()

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
