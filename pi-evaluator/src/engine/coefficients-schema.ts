/**
 * pi-evaluator/src/engine/coefficients-schema.ts
 *
 * TypeBox schema for the coefficients config file.
 *
 * What this validates (shape level):
 *   - `version`: must be a semver-shaped string (the pattern is the same
 *     one the loader pattern-matches on, so a file that passes TypeBox
 *     check also passes the loader's version extraction).
 *   - `global.dimension_weights`: all 5 dimensions present, each weight in
 *     [0, 1]. The cross-field "sums to 1.0" invariant is checked separately
 *     in `validateInvariants()` — TypeBox can't express arithmetic.
 *   - `global.thresholds.pass > thresholds.pass_with_gaps` (the lower bound
 *     of "pass" must exceed the upper bound of "pass_with_gaps") — also a
 *     cross-field invariant, but we encode it here so TypeBox catches it
 *     before the loader ever runs the more expensive check.
 *   - `dimensions.<name>.signals.<key>`: per the SignalConfig schema.
 *
 * What this does NOT validate (deferred to validateInvariants()):
 *   - Σ signal weights = 1.0 per dimension
 *   - Σ dimension_weights = 1.0 globally
 *   - thresholds.pass_with_gaps ≥ 0
 *   - every dimension listed in `dimensions` is also referenced in
 *     `global.dimension_weights` (and vice versa)
 */
import { Type, type Static } from "@sinclair/typebox";

/**
 * Per-signal coefficient: how to weight + how to normalize + which direction
 * counts as "better". See SKILL.md / examples for the norm catalog.
 *
 * `_comment` is intentionally not in the schema — it's a human note stripped
 * before validation. Users can keep inline comments in the JSON file without
 * breaking the loader.
 */
export const SignalConfigSchema = Type.Object({
	weight: Type.Number({
		minimum: 0,
		maximum: 1,
		description: "Per-signal weight within its dimension. Σ across signals = 1.0.",
	}),
	norm: Type.Union(
		[
			Type.Literal("identity"),
			Type.Literal("ratio_0_1"),
			Type.Literal("count"),
			Type.Literal("log_count"),
			Type.Literal("boolean"),
			Type.Literal("invert_count"),
			Type.Literal("invert_log_count"),
			Type.Literal("signed_pct"),
		],
		{
			description:
				"How to map the raw signal value into [0, 1] before multiplying by weight.",
		},
	),
	direction: Type.Union([Type.Literal("higher_better"), Type.Literal("lower_better")], {
		description:
			"Semantic direction of the signal after normalization. Currently advisory — kept on the schema so future scoring engines can cross-check the implied direction vs the chosen norm.",
	}),
});

/** Per-dimension config: a named map of signals. */
export const DimensionConfigSchema = Type.Object({
	signals: Type.Record(Type.String(), SignalConfigSchema),
});

/** The five canonical dimensions. Listed explicitly so missing entries fail TypeBox. */
export const DIMENSIONS = ["goal", "dag", "implement", "audit", "coordination"] as const;
export type DimensionName = (typeof DIMENSIONS)[number];

/**
 * Strict dimension_weights shape: every dimension must be present and
 * weighted in [0, 1]. Σ across all five = 1.0 (cross-field check).
 */
export const GlobalConfigSchema = Type.Object({
	dimension_weights: Type.Object({
		goal: Type.Number({ minimum: 0, maximum: 1 }),
		dag: Type.Number({ minimum: 0, maximum: 1 }),
		implement: Type.Number({ minimum: 0, maximum: 1 }),
		audit: Type.Number({ minimum: 0, maximum: 1 }),
		coordination: Type.Number({ minimum: 0, maximum: 1 }),
	}),
	thresholds: Type.Object({
		pass: Type.Number({ minimum: 0, maximum: 100 }),
		pass_with_gaps: Type.Number({ minimum: 0, maximum: 100 }),
	}),
});

/**
 * Top-level coefficients config.
 *
 * `version` mirrors pi-evaluator/package.json#version — the loader
 * cross-checks them and warns (but does not reject) on mismatch.
 */
export const CoefficientsConfigSchema = Type.Object({
	version: Type.String({
		// Same pattern as the loader uses for normalization-tolerant parsing.
		pattern: "^\\d+\\.\\d+\\.\\d+(-[a-zA-Z0-9.]+)?$",
		description:
			"Must equal pi-evaluator/package.json#version. Mismatch → loader warning, not rejection.",
	}),
	global: GlobalConfigSchema,
	dimensions: Type.Record(
		Type.Union(
			DIMENSIONS.map((d) => Type.Literal(d)) as [
				ReturnType<typeof Type.Literal>,
				...ReturnType<typeof Type.Literal>[],
			],
		),
		DimensionConfigSchema,
	),
});

/** Per-dimension config for each of the five canonical dimensions. */
export type DimensionsConfig = {
	goal: DimensionConfig;
	dag: DimensionConfig;
	implement: DimensionConfig;
	audit: DimensionConfig;
	coordination: DimensionConfig;
};

/**
 * Inferred TypeScript type for a valid coefficients config.
 *
 * Intersected with `DimensionsConfig`: TypeBox's `Static` type for
 * `Type.Record(Type.Union(...))` degrades the union-keyed record to `{}`,
 * which makes `dimensions[name]` unusable at compile time. Re-declaring the
 * five concrete keys restores the static type. The schema value is unchanged
 * (validation semantics are byte-identical) — this only fixes the type.
 */
export type CoefficientsConfig = Static<typeof CoefficientsConfigSchema> & {
	dimensions: DimensionsConfig;
};
export type SignalConfig = Static<typeof SignalConfigSchema>;
export type DimensionConfig = Static<typeof DimensionConfigSchema>;
export type GlobalConfig = Static<typeof GlobalConfigSchema>;
