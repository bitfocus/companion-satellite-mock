import { useEffect, useState } from 'react'
import { trpc } from './trpc.js'

/**
 * Renders a client's declared `CONFIG_FIELDS` as a form, exactly as Companion's surface settings
 * panel does, and pushes each change back as `DEVICE-CONFIG`.
 *
 * The field schema is Companion's own, so what renders here is what a real Companion would render.
 */

interface ConfigFieldBase {
	id: string
	label: string
	description?: string
	tooltip?: string
}

export type ConfigField = ConfigFieldBase &
	(
		| { type: 'static-text'; value: string }
		| { type: 'textinput'; default?: string; regex?: string; multiline?: boolean }
		| {
				type: 'dropdown'
				choices: readonly { id: string | number; label: string }[]
				default?: string | number
				allowCustom?: boolean
		  }
		| { type: 'number'; min: number; max: number; default?: number; step?: number }
		| { type: 'checkbox'; default?: boolean }
	)

/**
 * Compile a field's declared pattern, in Companion's `/…/flags` form or bare.
 *
 * Enforced here in the browser and never on the server: the pattern comes from the satellite client,
 * and a backtracking one would stall the shared server's event loop. Here it can only stall the tab
 * of whoever connected that client.
 */
function fieldPattern(regex: string | undefined): RegExp | undefined {
	if (!regex) return undefined
	const match = /^\/(.*)\/([a-z]*)$/.exec(regex)
	try {
		return match ? new RegExp(match[1] ?? '', match[2]) : new RegExp(regex)
	} catch {
		// An unparseable pattern from the client is not a reason to refuse the operator's value.
		return undefined
	}
}

export function DeviceConfigPanel({
	sessionId,
	fields,
	values,
}: {
	sessionId: string
	fields: readonly ConfigField[] | null
	values: Record<string, string | number | boolean>
}) {
	const [error, setError] = useState<string | null>(null)

	if (!fields || fields.length === 0) {
		return (
			<section className="card" data-testid="config-panel">
				<h2>Device config</h2>
				<p className="hint">
					This client declared no <code>CONFIG_FIELDS</code>. If it does, the fields appear here and changes
					are pushed back as <code>DEVICE-CONFIG</code>.
				</p>
			</section>
		)
	}

	const set = (fieldId: string, value: string | number | boolean) => {
		trpc.setConfigValue.mutate({ sessionId, fieldId, value }).then(
			() => setError(null),
			(caught: unknown) => setError(caught instanceof Error ? caught.message : 'Rejected')
		)
	}

	return (
		<section className="card" data-testid="config-panel">
			<h2>Device config</h2>
			<p className="hint">Declared by the client. Changes are pushed back as DEVICE-CONFIG.</p>

			{fields.map((field) => {
				const value = values[field.id]

				if (field.type === 'static-text') {
					return (
						<p key={field.id} className="hint" data-testid={`config-${field.id}`}>
							<strong>{field.label}</strong> {field.value}
						</p>
					)
				}

				if (field.type === 'checkbox') {
					return (
						<label key={field.id} className="check" title={field.tooltip}>
							<input
								type="checkbox"
								checked={value === true}
								data-testid={`config-${field.id}`}
								onChange={(event) => set(field.id, event.target.checked)}
							/>
							{field.label}
						</label>
					)
				}

				return (
					<label key={field.id} className="field" title={field.tooltip}>
						<span>{field.label}</span>

						{field.type === 'textinput' ? (
							<TextField
								field={field}
								value={String(value ?? '')}
								onCommit={(next) => set(field.id, next)}
								onInvalid={setError}
							/>
						) : field.type === 'dropdown' ? (
							<select
								value={String(value ?? '')}
								data-testid={`config-${field.id}`}
								onChange={(event) => set(field.id, event.target.value)}
							>
								{field.choices.map((choice) => (
									<option key={String(choice.id)} value={String(choice.id)}>
										{choice.label}
									</option>
								))}
							</select>
						) : (
							<input
								type="number"
								value={String(value ?? '')}
								data-testid={`config-${field.id}`}
								min={field.min}
								max={field.max}
								step={field.step ?? 1}
								onChange={(event) => set(field.id, Number(event.target.value))}
							/>
						)}

						{field.description && <small>{field.description}</small>}
					</label>
				)
			})}

			{error && <p className="error">{error}</p>}
		</section>
	)
}

/**
 * A text field that keeps a local draft and sends it on blur or Enter, once it matches the declared
 * pattern. Sending on every keystroke would make a pattern like `^\d{3}$` reject the first digit
 * typed, leaving the field impossible to fill in.
 */
function TextField({
	field,
	value,
	onCommit,
	onInvalid,
}: {
	field: Extract<ConfigField, { type: 'textinput' }>
	value: string
	onCommit: (value: string) => void
	onInvalid: (message: string) => void
}) {
	const [draft, setDraft] = useState(value)
	useEffect(() => setDraft(value), [value])

	const commit = () => {
		if (draft === value) return
		const pattern = fieldPattern(field.regex)
		if (pattern && !pattern.test(draft)) {
			onInvalid(`${field.label} must match ${field.regex}`)
			return
		}
		onCommit(draft)
	}

	return (
		<input
			type="text"
			value={draft}
			data-testid={`config-${field.id}`}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === 'Enter') commit()
			}}
		/>
	)
}
