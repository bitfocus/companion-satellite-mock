import type { TestPattern } from './patterns.js'

/** What a control should look like. The renderer's only input. */
export interface ButtonStyle {
	bgColor: string
	textColor: string
	text: string
	/** A number, or 'auto' to size to fit. */
	fontSize: number | 'auto'
	pressed: boolean
	type: 'BUTTON' | 'PAGEUP' | 'PAGEDOWN' | 'PAGENUM'
	/** 0-1, drives an LED gauge when the control's style preset asks for one. */
	gauge?: number
	/**
	 * A test pattern drawn over the background. With a pattern, `text` becomes a small label strip
	 * along the bottom rather than centred text, so it does not cover what is being tested.
	 */
	pattern?: TestPattern
}

export const DEFAULT_BUTTON_STYLE: ButtonStyle = {
	bgColor: '#000000',
	textColor: '#ffffff',
	text: '',
	fontSize: 'auto',
	pressed: false,
	type: 'BUTTON',
}

/**
 * A stable cache key for a style at a given size and format.
 *
 * JSON rather than a joined string, because button text is arbitrary: any separator it can also
 * contain makes distinct styles collide. `text:"AB", fontSize:1` and `text:"A", fontSize:"B1"` would
 * share a key and one button would render the other's image — exactly the class of bug this mock
 * exists to find rather than cause. JSON is unambiguous by construction.
 */
export function styleCacheKey(
	style: ButtonStyle,
	width: number,
	height: number,
	format: string,
	rotation: number
): string {
	return JSON.stringify([
		style.bgColor,
		style.textColor,
		style.text,
		style.fontSize,
		style.pressed,
		style.type,
		style.gauge ?? null,
		style.pattern ?? null,
		width,
		height,
		format,
		rotation,
	])
}
