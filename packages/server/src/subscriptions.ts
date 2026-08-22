import { sendSubState } from './emitter.js'
import type { Subscription } from './events.js'
import type { ButtonStyle } from './render/buttonStyle.js'
import { DEFAULT_BUTTON_STYLE } from './render/buttonStyle.js'
import type { RenderBudget } from './render/budget.js'
import type { ButtonRenderer } from './render/renderer.js'
import type { SatelliteSession } from './satelliteSession.js'

/**
 * Content for the virtual pages that subscriptions observe.
 *
 * Subscriptions are connection-scoped and reference an absolute `page/row/column` rather than any
 * surface, so they cannot be driven by a scenario the way a device can — a scenario belongs to a
 * device. This owns the button content at each location instead, and pushes `SUB-STATE` to every
 * subscription watching a location when it changes.
 */
export class SubscriptionPages {
	readonly #content = new Map<string, ButtonStyle>()

	constructor(
		private readonly renderer: ButtonRenderer,
		private readonly budget: RenderBudget
	) {}

	static key(pageNumber: number, row: number, column: number): string {
		return `${pageNumber}/${row}/${column}`
	}

	/**
	 * What a location currently shows.
	 *
	 * A location nobody has set is a valid subscription target — the spec is explicit that
	 * subscribing to an empty location succeeds and streams an empty button — so this returns a
	 * blank style rather than undefined.
	 */
	get(key: string): ButtonStyle {
		return this.#content.get(key) ?? DEFAULT_BUTTON_STYLE
	}

	entries(): { location: string; style: ButtonStyle }[] {
		return [...this.#content.entries()].map(([location, style]) => ({ location, style }))
	}

	/** Set a location's content and push it to everyone watching. Returns how many were notified. */
	set(key: string, style: Partial<ButtonStyle>, sessions: Iterable<SatelliteSession>): number {
		const merged = { ...this.get(key), ...style }
		this.#content.set(key, merged)
		return this.broadcast(key, sessions)
	}

	broadcast(key: string, sessions: Iterable<SatelliteSession>): number {
		const style = this.get(key)
		let notified = 0

		for (const session of sessions) {
			for (const subscription of session.subscriptions.values()) {
				if (locationKey(subscription) !== key) continue
				sendSubState(session.connection, subscription, style, this.renderer, this.budget, session.capabilities)
				notified++
			}
		}
		return notified
	}
}

export function locationKey(subscription: Subscription): string {
	return SubscriptionPages.key(
		subscription.location.pageNumber,
		subscription.location.row,
		subscription.location.column
	)
}
