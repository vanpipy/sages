/**
 * MDD Seven Planes — type-only module.
 *
 * Preserves the MDD classification vocabulary that DAG templates rely on
 * (see pi/skills/orchestrator/templates/dag/*.yaml), even though the
 * four-sage workflow that produced MDD draft.md has been removed.
 *
 * The planes are still semantically meaningful: each TaskNode in a DAG
 * declares which plane(s) it touches, which lets the orchestrator audit
 * for plane-coverage gaps without re-running the full MDD ceremony.
 */

/** MDD Seven Planes — the canonical classification. */
export type MDDPlane =
	| "Business"
	| "Data"
	| "Control"
	| "Foundation"
	| "Observation"
	| "Security"
	| "Evolution";

/** Task priority — used to break ties in batch assignment. */
export type MDDPriority = "high" | "medium" | "low";

/** The set of all MDD planes, in canonical order. */
export const MDD_PLANES: readonly MDDPlane[] = [
	"Business",
	"Data",
	"Control",
	"Foundation",
	"Observation",
	"Security",
	"Evolution",
] as const;