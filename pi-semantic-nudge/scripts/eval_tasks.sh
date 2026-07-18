#!/usr/bin/env bash
# Real LLM compliance eval for pi-semantic-nudge.
# Runs N representative tasks via `pi -p --mode json`, extracts tool names,
# reports semantic-tool vs builtin-tool usage per task.
#
# Usage:  bash scripts/eval_tasks.sh [output_dir]
#
# Output: stdout table + eval-report.md in output_dir

set -uo pipefail

cd "$(dirname "$0")/../.."
OUTPUT_DIR="${1:-/tmp/semantic-nudge-eval}"
mkdir -p "$OUTPUT_DIR"

# 12 representative tasks. Each has an "expected class":
#   SYMBOL    — needs semantic (find symbol, references, etc.)
#   GRAPH     — needs graph query (architecture, related, abstract)
#   GIT       — needs git impact (changes, blast radius)
#   TEXT      — small file/text, builtin OK (grep/read fine)
#
# Format: class|user prompt
TASKS=(
    "SYMBOL|Find the class WorkflowStateManager in this project and tell me what file it's in."
    "SYMBOL|Who calls the function audit() inside pi/scripts/install.sh?"
    "GRAPH|Show me the overall package architecture of this repo."
    "GIT|What symbols would be affected if I delete install_pi_serena from install.sh?"
    "GRAPH|Find all files that import or reference the 'serena' module."
    "TEXT|What are the dependencies of @sages/pi-serena?"
    "TEXT|Search for TODO comments under pi/src/."
    "GRAPH|How are error handling patterns related across the sage modules?"
    "SYMBOL|Find the function that creates a new sage workflow."
    "SYMBOL|List all the tools exposed by the gaoyao audit lifecycle."
    "TEXT|Find every occurrence of the word 'eager' in pi-graphify/templates/mcp.json."
    "GRAPH|Which abstractions in pi/ are most-imported by other modules?"
)

PROVIDER="minimax-cn"
MODEL="MiniMax-M3"

# Tool categorization
SEMANTIC_PATTERN="^(serena_|codebase_memory_|graphify_)"

printf "Running %d tasks via pi -p --mode json...\n" "${#TASKS[@]}"

declare -a TASK_CLASS=()
declare -a TASK_TEXT=()
declare -a TOOLS_USED=()
declare -a FIRST_TOOL=()
declare -a COMPLIANT_ANY=()
declare -a COMPLIANT_FIRST=()

for i in "${!TASKS[@]}"; do
    spec="${TASKS[$i]}"
    cls="${spec%%|*}"
    txt="${spec#*|}"
    echo "[$((i+1))/${#TASKS[@]}] [$cls] $txt"

    raw=$(echo "$txt" | timeout 120 pi -p --no-session \
        --provider "$PROVIDER" --model "$MODEL" \
        --mode json 2>/dev/null || echo "")

    echo "$raw" > "$OUTPUT_DIR/task-$((i+1)).jsonl"

    tools=$(echo "$raw" | grep -o '"toolName" *: *"[^"]*"' \
        | sed -E 's/.*"toolName" *: *"([^"]*)".*/\1/' \
        | awk '!seen[$0]++')

    first=$(echo "$tools" | head -1)
    [ -z "$first" ] && first="(none)"

    used_semantic="NO"
    if echo "$tools" | grep -qE "$SEMANTIC_PATTERN"; then
        used_semantic="YES"
    fi

    # Expected: SYMBOL/GIT/GRAPH should use semantic. TEXT is fine with builtin.
    expected="NO"
    case "$cls" in
        SYMBOL|GIT|GRAPH) expected="YES" ;;
        TEXT)              expected="OK_BUILTIN" ;;
    esac

    TASK_CLASS+=("$cls")
    TASK_TEXT+=("$txt")
    TOOLS_USED+=("$tools")
    FIRST_TOOL+=("$first")
    COMPLIANT_ANY+=("$used_semantic")
    if [ "$first" = "(none)" ]; then
        COMPLIANT_FIRST+=("N/A")
    elif echo "$first" | grep -qE "$SEMANTIC_PATTERN"; then
        COMPLIANT_FIRST+=("YES")
    else
        COMPLIANT_FIRST+=("NO")
    fi

    echo "      first: $first"
    echo "      semantic_used: $used_semantic"
done

echo
echo "==============================================================="
echo "  LLM COMPLIANCE EVAL (real model: $MODEL)"
echo "==============================================================="
echo
echo "Definitions:"
echo "  CLASS     = task category (SYMBOL/GIT/GRAPH need semantic; TEXT = grep OK)"
echo "  First     = first tool the LLM picked"
echo "  Used.Sem? = did the LLM use ANY semantic tool at all during the task"
echo

printf "  %-7s  %-50s  %-25s  %-9s  %s\n" \
    "CLASS" "Task" "First tool" "Used.Sem" "Verdict"
printf "  %-7s  %-50s  %-25s  %-9s  %s\n" \
    "-----" "$(printf '%.0s-' {1..50})" "$(printf '%.0s-' {1..25})" "$(printf '%.0s-' {1..9})" "$(printf '%.0s-' {1..7})"

total=${#TASKS[@]}
first_yes=0
any_yes=0
pragmatic_ok=0
relevant_total=0

for i in "${!TASKS[@]}"; do
    cls="${TASK_CLASS[$i]}"
    txt="${TASK_TEXT[$i]}"
    first="${FIRST_TOOL[$i]}"
    used="${COMPLIANT_ANY[$i]}"
    first_yes_flag="${COMPLIANT_FIRST[$i]}"

    # Truncate task text to 48 chars
    short_txt="${txt:0:48}"
    [ "${#txt}" -gt 48 ] && short_txt="${short_txt}..."

    # Verdict: did LLM make a "good" choice?
    if [ "$cls" = "TEXT" ]; then
        # Builtin is acceptable for TEXT tasks
        verdict="OK (builtin)"
        pragmatic_ok=$((pragmatic_ok+1))
        mark="✅"
    elif [ "$used" = "YES" ]; then
        # Semantic was used somewhere
        relevant_total=$((relevant_total+1))
        if [ "$first_yes_flag" = "YES" ]; then
            first_yes=$((first_yes+1))
            any_yes=$((any_yes+1))
            verdict="STRONG ✅"
            mark="✅"
        else
            any_yes=$((any_yes+1))
            verdict="WEAK ⚠️ "
            mark="⚠️ "
        fi
    else
        relevant_total=$((relevant_total+1))
        verdict="MISS ❌"
        mark="❌"
    fi

    printf "  %-7s  %-50s  %-25s  %-9s  %s %s\n" \
        "$cls" "$short_txt" "$first" "$used" "$mark" "$verdict"
done

echo
echo "==============================================================="
echo "  SUMMARY"
echo "==============================================================="
echo

# Overall: any semantic usage / total tasks
any_pct=$(( any_yes * 100 / total ))
echo "  Any semantic used:           $any_yes / $total = ${any_pct}%"

# Strong semantic (first tool was semantic) / total
strong_pct=$(( first_yes * 100 / total ))
echo "  First tool was semantic:     $first_yes / $total = ${strong_pct}%"

# On relevant tasks (SYMBOL/GIT/GRAPH), how many used semantic
relevant_total_count=0
relevant_used_count=0
for i in "${!TASK_CLASS[@]}"; do
    cls="${TASK_CLASS[$i]}"
    used="${COMPLIANT_ANY[$i]}"
    if [ "$cls" != "TEXT" ]; then
        relevant_total_count=$((relevant_total_count+1))
        [ "$used" = "YES" ] && relevant_used_count=$((relevant_used_count+1))
    fi
done
if [ "$relevant_total_count" -gt 0 ]; then
    rel_pct=$(( relevant_used_count * 100 / relevant_total_count ))
    echo "  Semantic on RELEVANT tasks:  $relevant_used_count / $relevant_total_count = ${rel_pct}%"
else
    echo "  Semantic on RELEVANT tasks:  N/A"
fi

# Builtin OK for TEXT tasks
text_pct=$(( pragmatic_ok * 100 / total ))
echo "  Builtin OK on TEXT tasks:    $pragmatic_ok / $total = ${text_pct}%"

echo
echo "  Note: 'TEXT' tasks are intentionally fine with grep/read (small file content)."
echo "        'SYMBOL'/'GIT'/'GRAPH' tasks SHOULD use semantic tools."
echo

# Write machine-readable report
{
    echo "# LLM Compliance Eval Report"
    echo
    echo "- Model: \`$MODEL\`"
    echo "- Tasks: $total"
    echo
    echo "## Summary"
    echo
    echo "- Any semantic used: **$any_yes / $total** = ${any_pct}%"
    echo "- First tool was semantic: **$first_yes / $total** = ${strong_pct}%"
    echo "- Semantic on RELEVANT tasks (SYMBOL/GIT/GRAPH): **$relevant_used_count / $relevant_total_count** = $([ "$relevant_total_count" -gt 0 ] && echo "$rel_pct" || echo "N/A")%"
    echo "- Builtin OK on TEXT tasks: **$pragmatic_ok / $total** = ${text_pct}%"
    echo
    echo "## Per-task"
    echo
    for i in "${!TASKS[@]}"; do
        cls="${TASK_CLASS[$i]}"
        txt="${TASK_TEXT[$i]}"
        first="${FIRST_TOOL[$i]}"
        used="${COMPLIANT_ANY[$i]}"
        first_flag="${COMPLIANT_FIRST[$i]}"
        tools_comma=$(echo "${TOOLS_USED[$i]}" | tr '\n' ',' | sed 's/,$//')

        echo "### Task $((i+1)) [$cls]: $txt"
        echo
        echo "- First tool: \`$first\` ($first_flag)"
        echo "- Tools used: \`$tools_comma\`"
        echo "- Used semantic: $used"
        echo
    done
} > "$OUTPUT_DIR/eval-report.md"

echo "Report: $OUTPUT_DIR/eval-report.md"
echo "Per-task JSONL: $OUTPUT_DIR/task-*.jsonl"