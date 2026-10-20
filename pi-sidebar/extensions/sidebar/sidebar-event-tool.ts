import { Type, type Static } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SidebarEvent, SidebarState } from "./types.js";
import { SIDEBAR_EVENT_LOG_MAX } from "./types.js";

/**
 * Action surface exposed to the LLM via the `sidebar_event` tool.
 *
 * The channel is generic — any extension (including ours) can
 * `pi.events.emit("sidebar:event", payload)` and the sidebar
 * reacts identically.
 */
export type SidebarEventAction = SidebarEvent["action"];

export const SIDEBAR_EVENT_ACTIONS = [
	"show",
	"highlight",
	"badge",
	"toast",
	"log",
	"clear",
] as const satisfies readonly SidebarEventAction[];

/** TypeBox schema backing the LLM-facing `sidebar_event` tool. */
const SidebarEventParams = Type.Object({
	action: Type.Union(
		SIDEBAR_EVENT_ACTIONS.map((a) => Type.Literal(a)),
		{ description: "Which sidebar interaction to apply." },
	),
	target: Type.Optional(
		Type.String({
			description:
				"Identifier the action targets (task id, agent id, etc.). Optional for `toast` and un-scoped `clear`.",
		}),
	),
	data: Type.Optional(
		Type.Object(
			{},
			{
				additionalProperties: true,
				description:
					"Free-form payload. For `toast` reads `data.message` + `data.level`. For `badge`/`log` is stored verbatim.",
			},
		),
	),
});

export type SidebarEventParams = Static<typeof SidebarEventParams>;

/**
 * Wire the `sidebar_event` tool + the `sidebar:event` channel listener.
 *
 * The two halves are split so the host (typically `extensions/sidebar.ts`)
 * owns state lifecycle:
 *
 * - `pi.registerTool(...)` — LLM-facing tool. Emits one
 *   `sidebar:event` per invocation and returns a success envelope.
 * - `pi.events.on("sidebar:event", ...)` — internal handler that
 *   mutates `state` and triggers `requestRender()`. Wired even when
 *   the tool is not present, so other extensions on the same
 *   `pi.events` bus can drive the sidebar.
 *
 * Tested handlers are isolated: each test reconstructs the wiring
 * against a fake `pi` + `state`, so we do not rely on a running UI.
 */
export function registerSidebarEventTool(
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | undefined,
	getState: () => SidebarState,
	requestRender: () => void,
): void {
	pi.registerTool({
		name: "sidebar_event",
		label: "Sidebar event",
		description:
			"Emit a structured event onto the sidebar (show / highlight / badge / toast / log / clear). " +
			"Use `target` to scope an event to a task or agent id; `data` carries a free-form payload. " +
			"The same `sidebar:event` channel is reachable via `pi.events.emit(\"sidebar:event\", …)` from any extension.",
		parameters: SidebarEventParams,

		async execute(
			_toolCallId: string,
			params: SidebarEventParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		) {
			const ts = Date.now();
			pi.events.emit("sidebar:event", {
				action: params.action,
				target: params.target,
				data: params.data as Record<string, unknown> | undefined,
				ts,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `sidebar:event emitted (action=${params.action})`,
					},
				],
				details: {
					emitted: true,
					event: "sidebar:event",
					ts,
				},
			};
		},
	});

	pi.events.on("sidebar:event", (raw: unknown) => {
		const event = raw as Partial<SidebarEvent>;
		const action = event.action;
		if (!action || !SIDEBAR_EVENT_ACTIONS.includes(action as SidebarEventAction)) {
			return;
		}
		const target =
			typeof event.target === "string" ? (event.target as string) : undefined;
		const data =
			event.data && typeof event.data === "object" && !Array.isArray(event.data)
				? (event.data as Record<string, unknown>)
				: undefined;
		const ts =
			typeof event.ts === "number" && Number.isFinite(event.ts)
				? (event.ts as number)
				: Date.now();
		const state = getState();
		switch (action as SidebarEventAction) {
			case "show":
			case "highlight":
				state.highlightedId = target;
				break;
			case "badge":
				state.badges.push({ ts, target, data });
				break;
			case "toast": {
				const ctx = getCtx();
				const message =
					typeof data?.message === "string" && data.message.length > 0
						? (data.message as string)
						: "sidebar";
				const levelRaw = data?.level;
				const level: "info" | "warning" | "error" =
					levelRaw === "warning" || levelRaw === "error"
						? levelRaw
						: "info";
				try {
					ctx?.ui.notify(message, level);
				} catch {
					// ctx unavailable (print mode / extension unloaded) — swallow
				}
				break;
			}
			case "log":
				state.eventLog.push({ ts, target, data });
				if (state.eventLog.length > SIDEBAR_EVENT_LOG_MAX) {
					state.eventLog.splice(
						0,
						state.eventLog.length - SIDEBAR_EVENT_LOG_MAX,
					);
				}
				break;
			case "clear":
				if (target === undefined) {
					state.highlightedId = undefined;
					state.badges = [];
				} else {
					if (state.highlightedId === target) state.highlightedId = undefined;
					state.badges = state.badges.filter((b) => b.target !== target);
				}
				break;
			default:
				return;
		}
		requestRender();
	});
}
