/**
 * Client half — intentionally inert.
 *
 * ## Why there is no panel any more
 *
 * This half used to register a `conversation.session.header.actions` entry
 * (`id: 'swarm-scheduler'`, order -25) that rendered a read-only panel over the
 * scheduling pool. The panel was fed by `GET /api/swarm/board`, registered on
 * the host half by `src/host-route.ts`.
 *
 * That route is gone, and the panel went with it:
 *   - `host-route.ts` was removed during the file-driven rewrite, so nothing
 *     registers `/api/swarm/board` any more;
 *   - re-registering it would need `ctx.webServer`, which is **not reliably
 *     resolvable from this plugin's fiber** — measured across several boots
 *     (one `ROUTE REGISTERED`, the rest `ROUTE SKIPPED webServer not mounted`),
 *     see DESIGN.md §12.2.
 *
 * A header button that opens a panel saying "board unavailable" is worse than no
 * button: it advertises a capability the plugin cannot honour. So the client
 * half now contributes **nothing** — no slot, no poll, no DOM.
 *
 * ## What a restore would need first
 *
 * A data source the host half can actually reach. Either a resolvable
 * `webServer` route, or — better suited to the current design — a tool-driven
 * read path, since the file pool is already the single source of truth and its
 * six tools are reachable from both halves' callers. The panel is an optional
 * visualisation layer (DESIGN.md §5); it is not part of the scheduling contract,
 * and scheduling works without it.
 *
 * The `slots` injection is deliberately absent: this half registers no UI at
 * all, so declaring the dependency would be a declaration no code reads — the
 * same kind of empty claim that route B removed from the host half.
 */

/**
 * The client context, declared structurally.
 *
 * The previous version imported `ClientContext` from
 * `@deepseek-ai/dsh-client-runtime/client`. No published version of that package
 * matches this runtime, so the import resolved to nothing and `tsc` failed with
 * `TS2307` — which is why this file was never in `tsconfig.json`'s include and
 * went unchecked. Since the half now does nothing, an empty structural type is
 * both sufficient and checkable: it removes the unresolvable dependency instead
 * of suppressing the error, and lets this file be type checked like the rest.
 *
 * Restoring a panel means restoring real code here, and with it the question of
 * how to type the client context properly.
 */
export interface ClientContextLike {
  readonly [key: string]: unknown
}

export const name = 'dsh-swarm-scheduler-beta-client'

/**
 * Keep the client entry point valid but contribution-free.
 *
 * `apply` stays exported and synchronous: the loader expects a client half to
 * export one, and an entry that throws or is missing would be a load failure
 * rather than an intentional absence.
 */
export function apply(_ctx: ClientContextLike): void {
  // No slots, no routes, no polling. Intentionally empty.
}
