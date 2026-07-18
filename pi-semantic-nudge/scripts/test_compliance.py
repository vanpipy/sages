#!/usr/bin/env python3
"""
Compliance test for pi-semantic-nudge.

Simulates 5 representative user tasks and reports which tool wins for each.
Uses token overlap + [PREFERRED] tag bonus as a proxy for LLM tool-selection probability.

Run:
    python3 scripts/test_compliance.py
"""

import json
import re
from pathlib import Path

CACHE = Path.home() / ".pi/agent/mcp-cache.json"

def tokenize(text):
    return set(re.findall(r"[a-z_]+", text.lower()))

def score(tool_desc, user_keywords):
    tool_tokens = tokenize(tool_desc)
    overlap = tool_tokens & user_keywords
    preferred_bonus = 5 if "[PREFERRED" in tool_desc[:30] else 0
    return len(overlap) + preferred_bonus, overlap

TASKS = [
    ("find class Foo",         {"find", "class", "definition", "symbol"}),
    ("who calls bar()",        {"callers", "calls", "references", "find"}),
    ("show project architecture", {"architecture", "overview", "structure", "project", "packages"}),
    ("git diff impact",        {"diff", "change", "impact", "blast", "affected"}),
    ("concept across modules", {"concept", "pattern", "related", "modules", "semantic"}),
]

BUILTINS = [
    {"name": "grep", "desc": "Search file contents using regex patterns"},
    {"name": "read", "desc": "Read file contents"},
    {"name": "find", "desc": "Find files by name pattern"},
]

SEMANTIC_SERVERS = ("serena", "codebase-memory-mcp", "graphify")


def main() -> int:
    if not CACHE.exists():
        print(f"❌ FAIL: mcp-cache.json not found at {CACHE}")
        print("   Run `pi` at least once to bootstrap the cache, then re-run this test.")
        return 1

    cache = json.loads(CACHE.read_text())

    compliant = 0
    results = []
    for name, keywords in TASKS:
        semantic_results = []
        for server_name in SEMANTIC_SERVERS:
            for tool in cache.get("servers", {}).get(server_name, {}).get("tools", []):
                full_name = f"{server_name.replace('-mcp', '').replace('-', '_')}_{tool['name']}"
                s, _ = score(tool["description"], keywords)
                semantic_results.append((full_name, s, "[PREFERRED" in tool["description"][:30]))
        semantic_results.sort(key=lambda x: -x[1])

        top_builtin_score = max(score(b["desc"], keywords)[0] for b in BUILTINS)
        top_sem = semantic_results[0] if semantic_results else (None, 0, False)
        is_compliant = bool(top_sem[2]) and top_sem[1] > top_builtin_score
        if is_compliant:
            compliant += 1
        results.append((name, top_sem[0] or "(none)", top_sem[1], top_builtin_score, is_compliant))

    total = len(TASKS)
    print("=" * 78)
    print("  COMPLIANCE TEST — 5 representative tasks")
    print("=" * 78)
    print()
    print(f"  {'Task':<32} {'Top Semantic':<28} {'Score':>5} {'Builtin':>7} {'OK':>3}")
    print(f"  {'-'*32} {'-'*28} {'-'*5} {'-'*7} {'-'*3}")
    for name, top_sem, sem_score, builtin_score, ok in results:
        status = "✅" if ok else "⚠️ "
        print(f"  {name:<32} {top_sem:<28} {sem_score:>5} {builtin_score:>7} {status:>3}")
    print()
    print(f"  COMPLIANCE RATE: {compliant}/{total} = {compliant/total*100:.0f}%")

    # Pre-flight checks
    total_patched = sum(
        1 for srv in SEMANTIC_SERVERS for t in cache.get("servers", {}).get(srv, {}).get("tools", [])
        if t.get("description", "").startswith("[PREFERRED")
    )
    total_tools = sum(len(cache.get("servers", {}).get(srv, {}).get("tools", [])) for srv in SEMANTIC_SERVERS)
    print(f"  PATCHED DESCRIPTIONS: {total_patched}/{total_tools} (need 100%)")
    print()

    if compliant == total and total_patched == total_tools:
        print("  ✅ ALL CHECKS PASSED")
        return 0
    print("  ⚠️  PARTIAL — run pi-semantic-nudge to auto-repatch, then retry")
    return 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
