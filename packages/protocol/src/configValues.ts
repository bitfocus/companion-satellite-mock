import type { ConfigField, SatelliteConfigFields } from './upstream/SatelliteConfigFieldsSchema.js'

export type ConfigValue = string | number | boolean

/**
 * The value a field starts at when the operator has not set one.
 *
 * Companion pushes `DEVICE-CONFIG` once immediately after `ADD-DEVICE OK`, so a client that declared
 * config fields expects values before anyone has touched the UI. A field with no declared default
 * still needs *something*, or the payload would be missing keys the client is entitled to read.
 */
export function defaultValueFor(field: ConfigField): ConfigValue | undefined {
	switch (field.type) {
		case 'static-text':
			// Display only — it has no value, and inventing one would be a lie in the payload.
			return undefined
		case 'textinput':
			return field.default ?? ''
		case 'dropdown':
			// Falls back to the first choice rather than empty: a dropdown's value is meant to be one
			// of its choices, and the schema guarantees at least one.
			return field.default ?? field.choices[0]?.id
		case 'number':
			return field.default ?? field.min
		case 'checkbox':
			return field.default ?? false
	}
}

/** The complete initial payload for a set of declared fields. */
export function defaultConfigValues(fields: SatelliteConfigFields): Record<string, ConfigValue> {
	const values: Record<string, ConfigValue> = {}
	for (const field of fields) {
		const value = defaultValueFor(field)
		if (value !== undefined) values[field.id] = value
	}
	return values
}

/**
 * Coerce an operator-supplied value to the field's type, rejecting anything that does not fit.
 *
 * The web UI is public and unauthenticated, so a value arriving from it is untrusted input like any
 * other — and a client that declared a `number` field should never receive a string.
 */
export function coerceConfigValue(field: ConfigField, value: unknown): ConfigValue | undefined {
	switch (field.type) {
		case 'static-text':
			return undefined
		case 'textinput':
			// A declared `regex` is deliberately not enforced here. It comes from the satellite client
			// and the value from the web UI, and on a public server one person can supply both: a
			// catastrophically backtracking pattern like /^(a+)+$/ against thirty characters would hold
			// the event loop, and with it every session on the server, for minutes. The web UI checks
			// the pattern in the operator's own browser instead, where a bad one only stalls their tab.
			return typeof value === 'string' ? value : undefined
		case 'dropdown': {
			if (typeof value !== 'string' && typeof value !== 'number') return undefined
			if (field.allowCustom) return value
			return field.choices.some((choice) => choice.id === value) ? value : undefined
		}
		case 'number': {
			const numeric = typeof value === 'number' ? value : Number(value)
			if (!Number.isFinite(numeric)) return undefined
			return numeric < field.min || numeric > field.max ? undefined : numeric
		}
		case 'checkbox':
			return typeof value === 'boolean' ? value : undefined
	}
}
