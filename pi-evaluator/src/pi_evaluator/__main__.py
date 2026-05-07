#!/usr/bin/env python3
"""pi-evaluator CLI - Auto-run and evaluate Four Sages Agents workflow sessions.

Usage:
    pi-evaluator --check-env
    pi-evaluator --run "Create REST API"
    pi-evaluator session.jsonl
    pi-evaluator s1.jsonl s2.jsonl --compare
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pi_evaluator import (
    Comparator,
    Config,
    Evaluator,
    Parser,
    Reporter,
    Runner,
    ValidationResult,
    load_config,
    validate_or_exit,
)


def create_parser() -> argparse.ArgumentParser:
    """Create CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="pi-evaluator",
        description="Auto-run and evaluate Four Sages Agents workflow sessions",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --check-env
  %(prog)s --run "Create REST API"
  %(prog)s session.jsonl
  %(prog)s s1.jsonl s2.jsonl --compare
        """,
    )

    # Global options
    parser.add_argument(
        "--output-dir",
        "-o",
        type=Path,
        help="Output directory (default: ./evaluations)",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="count",
        default=0,
        help="Increase verbosity (can stack: -v, -vv, -vvv)",
    )
    parser.add_argument(
        "--config",
        "-c",
        type=Path,
        help="Config file path",
    )

    # Subcommands
    subparsers = parser.add_subparsers(dest="command", required=True)

    # check-env command
    subparsers.add_parser("check-env", help="Validate environment setup")

    # run command
    run_parser = subparsers.add_parser("run", help="Run workflow and evaluate")
    run_parser.add_argument("request", help="Workflow request string")
    run_parser.add_argument(
        "--no-auto-approve",
        action="store_true",
        help="Disable auto-approve",
    )
    run_parser.add_argument(
        "--timeout",
        type=int,
        help="Workflow timeout in seconds (default: from config)",
    )

    # evaluate command
    eval_parser = subparsers.add_parser("evaluate", help="Evaluate existing session")
    eval_parser.add_argument("session", type=Path, help="Path to session.jsonl")
    eval_parser.add_argument(
        "--request",
        help="Original workflow request (for reference)",
    )

    # compare command
    cmp_parser = subparsers.add_parser("compare", help="Compare two sessions")
    cmp_parser.add_argument("session1", type=Path, help="First session file")
    cmp_parser.add_argument("session2", type=Path, help="Second session file")

    return parser


def cmd_check_env(config: Config) -> int:
    """Handle check-env command."""
    result: ValidationResult = validate_or_exit(config.pi_path)
    print(result)
    return 0 if result.valid else 1


def cmd_run(args: argparse.Namespace, config: Config) -> int:
    """Handle run command."""
    # Validate environment first
    if config.verbose:
        print("Validating environment...")
    validate_or_exit(config.pi_path)

    # Run workflow
    if config.verbose:
        print(f"Running workflow: {args.request[:50]}...")

    runner = Runner(config)
    try:
        session_path = runner.run_workflow(
            args.request,
            auto_approve=not args.no_auto_approve,
            timeout=args.timeout,
        )

        if config.verbose:
            print(f"Session saved to: {session_path}")

        # Evaluate session
        if config.verbose:
            print("Evaluating session...")

        parser = Parser()
        entries = parser.parse(session_path)

        evaluator = Evaluator(config)
        result = evaluator.evaluate(entries, request=args.request, session_id=runner.session_id)

        # Save results
        reporter = Reporter(config.output_dir)
        json_path, md_path = reporter.save_evaluation(
            result, config.get_evaluation_dir(runner.session_id)
        )

        if config.verbose:
            print(f"Evaluation saved to: {json_path}")
            print(f"Report saved to: {md_path}")

        # Print summary
        print(f"\nVerdict: {result.verdict}")
        print(f"Overall Score: {result.overall.overall_score:.1f}")

        return 0 if result.verdict != "POOR" else 1

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


def cmd_evaluate(args: argparse.Namespace, config: Config) -> int:
    """Handle evaluate command."""
    if config.verbose:
        print(f"Evaluating: {args.session}")

    parser = Parser()
    try:
        entries = parser.parse(args.session)
    except Exception as e:
        print(f"Error parsing session: {e}", file=sys.stderr)
        return 1

    evaluator = Evaluator(config)
    result = evaluator.evaluate(
        entries,
        request=args.request,
        session_id=args.session.parent.name,
    )

    # Output results
    output = json.dumps(result.to_dict(), indent=2)
    print(output)

    return 0


def cmd_compare(args: argparse.Namespace, config: Config) -> int:
    """Handle compare command."""
    if config.verbose:
        print(f"Comparing: {args.session1} vs {args.session2}")

    comparator = Comparator(config)
    try:
        comparison = comparator.compare_files(args.session1, args.session2)
    except Exception as e:
        print(f"Error comparing sessions: {e}", file=sys.stderr)
        return 1

    # Output results
    output = json.dumps(comparison.to_dict(), indent=2)
    print(output)

    return 0


def main() -> int:
    """Main entry point."""
    parser = create_parser()
    args = parser.parse_args()

    # Load configuration
    config = load_config(
        output_dir=args.output_dir,
        verbose=args.verbose > 0,
        config_file=args.config,
    )

    # Execute command
    if args.command == "check-env":
        return cmd_check_env(config)
    elif args.command == "run":
        return cmd_run(args, config)
    elif args.command == "evaluate":
        return cmd_evaluate(args, config)
    elif args.command == "compare":
        return cmd_compare(args, config)

    return 0


if __name__ == "__main__":
    sys.exit(main())
