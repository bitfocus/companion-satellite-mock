import {
	LEGACY_BITMAP_SIZE,
	LEGACY_BUTTONS_PER_ROW,
	LEGACY_MAX_BUTTONS,
	MAX_KEYS_PER_ROW,
	MAX_KEYS_TOTAL,
	MIN_BITMAP_SIZE_PARAM,
} from './constants.js'
import { isFalsey, isTruthy, parseStringParamWithBooleanFallback, type ParsedParams } from './parse.js'
import type { SatelliteControlStylePreset, SatelliteSurfaceLayout } from './upstream/SatelliteSurfaceManifestSchema.js'

export interface GridSize {
	rows: number
	columns: number
}

export interface ResolvedControl {
	id: string
	row: number
	column: number
	style: SatelliteControlStylePreset
}

/**
 * The internal surface model.
 *
 * Legacy (`KEYS_TOTAL`/`KEYS_PER_ROW`/flags) and advanced (`LAYOUT_MANIFEST`) registrations both
 * normalise into this, exactly as Companion does — it builds the same manifest shape internally from
 * the legacy parameters. Drawing code then addresses controls by id and never has to care which mode
 * the client used; only the emitter does, when it chooses between `KEY=` and `CONTROLID=`.
 */
export interface Surface {
	/** True when the client supplied a `LAYOUT_MANIFEST`, which decides `KEY` vs `CONTROLID`. */
	fromManifest: boolean
	gridSize: GridSize
	controls: Map<string, ResolvedControl>
}

export type LegacyGridError = 'Invalid KEYS_TOTAL' | 'Invalid KEYS_PER_ROW'

/**
 * Build the manifest Companion would synthesise from legacy `ADD-DEVICE` parameters.
 *
 * Returns an error string rather than throwing, since every caller turns it straight into a protocol
 * error response.
 */
export function layoutFromLegacyParams(params: ParsedParams): SatelliteSurfaceLayout | LegacyGridError {
	const keysTotal = params.KEYS_TOTAL ? Number(params.KEYS_TOTAL) : LEGACY_MAX_BUTTONS
	if (isNaN(keysTotal) || keysTotal <= 0 || keysTotal > MAX_KEYS_TOTAL) return 'Invalid KEYS_TOTAL'

	const keysPerRow = params.KEYS_PER_ROW ? Number(params.KEYS_PER_ROW) : LEGACY_BUTTONS_PER_ROW
	if (isNaN(keysPerRow) || keysPerRow <= 0 || keysPerRow > MAX_KEYS_PER_ROW) return 'Invalid KEYS_PER_ROW'

	const style: SatelliteControlStylePreset = {}

	if (params.BITMAPS !== undefined && !isFalsey(params.BITMAPS)) {
		let size = Number(params.BITMAPS)
		// A boolean-looking value, or an implausibly small number, means the legacy 72px size.
		if (isNaN(size) || size < MIN_BITMAP_SIZE_PARAM) size = LEGACY_BITMAP_SIZE
		style.bitmap = { w: size, h: size }
	}

	const colors = parseStringParamWithBooleanFallback(['hex', 'rgb'] as const, 'hex', params.COLORS)
	if (colors) style.colors = colors

	style.text = params.TEXT !== undefined && isTruthy(params.TEXT)
	style.textStyle = params.TEXT_STYLE !== undefined && isTruthy(params.TEXT_STYLE)

	const controls: SatelliteSurfaceLayout['controls'] = {}
	for (let i = 0; i < keysTotal; i++) {
		const row = Math.floor(i / keysPerRow)
		const column = i % keysPerRow
		controls[`${row}/${column}`] = { row, column }
	}

	return { stylePresets: { default: style }, controls }
}

/** Resolve a layout into the internal model, applying named style presets to each control. */
export function buildSurface(layout: SatelliteSurfaceLayout, fromManifest: boolean): Surface {
	const controls = new Map<string, ResolvedControl>()
	let rows = 0
	let columns = 0

	for (const [id, definition] of Object.entries(layout.controls)) {
		const preset = definition.stylePreset
			? (layout.stylePresets[definition.stylePreset] ?? layout.stylePresets.default)
			: layout.stylePresets.default

		controls.set(id, { id, row: definition.row, column: definition.column, style: preset })
		rows = Math.max(rows, definition.row + 1)
		columns = Math.max(columns, definition.column + 1)
	}

	return { fromManifest, gridSize: { rows, columns }, controls }
}

export function convertIndexToXY(index: number, gridSize: GridSize): [x: number, y: number] | null {
	if (isNaN(index) || index < 0 || index >= gridSize.columns * gridSize.rows) return null
	return [index % gridSize.columns, Math.floor(index / gridSize.columns)]
}

export function convertXYToIndex(x: number, y: number, gridSize: GridSize): number | null {
	if (x < 0 || y < 0 || x >= gridSize.columns || y >= gridSize.rows) return null
	return y * gridSize.columns + x
}

/**
 * Parse a legacy `KEY` parameter, which since 1.6 may be either a flat index or `row/column`.
 *
 * Note the row/column form is checked *first*, and that a leading `+` is tolerated on either part —
 * both quirks of upstream's regex. Returns `[x, y]`, i.e. column first, which is the opposite order
 * to the wire format.
 */
export function parseKeyParam(key: string, gridSize: GridSize): [x: number, y: number] | null {
	const keynum = Number(key)
	const match = /^\+?(\d+)\/\+?(\d+)$/.exec(key)

	if (match && Number(match[1]) < gridSize.rows && Number(match[2]) < gridSize.columns) {
		return [Number(match[2]), Number(match[1])]
	}
	if (!isNaN(keynum) && keynum < gridSize.columns * gridSize.rows && keynum >= 0) {
		return convertIndexToXY(keynum, gridSize)
	}
	return null
}

/** Find the control at a grid position, for legacy-mode input where there is no control id. */
export function controlAt(surface: Surface, x: number, y: number): ResolvedControl | undefined {
	for (const control of surface.controls.values()) {
		if (control.column === x && control.row === y) return control
	}
	return undefined
}
