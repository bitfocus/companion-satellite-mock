import { formatClaimCode } from '../claimCode.js'
import type { Scenario, ScenarioContext } from './types.js'

/**
 * The built-in scenario catalogue.
 *
 * Every scenario degrades: one that wants bitmaps still does something useful on a colour-and-text
 * surface, because a client under development may not have implemented bitmaps yet and that is
 * exactly when the mock is most useful.
 */

const PALETTE = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6']

const at = (context: ScenarioContext, index: number): string | undefined => context.controlIds[index]

/** Paint a control, but only if the surface actually has one there. */
function paint(context: ScenarioContext, index: number, style: Parameters<ScenarioContext['draw']>[1]): void {
	const id = at(context, index)
	if (id) context.draw(id, style)
}

// ---------------------------------------------------------------------------------------------
// 1. Unclaimed — the default, and the one an evaluator sees.
// ---------------------------------------------------------------------------------------------

export function unclaimedScenario(claimCode: string, publicUrl: string): Scenario {
	const formatted = formatClaimCode(claimCode)

	return {
		id: 'unclaimed',
		name: 'Unclaimed',
		description:
			'Shows the claim code on the surface itself, so it can be typed into the web UI without ' +
			'digging the device id out of the app. Also proves the surface is live: buttons respond.',
		wants: ['colors', 'text'],

		init(context) {
			context.drawAll({ bgColor: '#101014', textColor: '#ffffff', text: '' })

			paint(context, 0, { bgColor: '#8a2be2', text: 'UN-\nCLAIMED', textColor: '#ffffff' })

			// One character per key where there is room, otherwise the whole code on one button. A
			// four-key surface should still be claimable.
			const codeStart = 1
			if (context.controlIds.length >= codeStart + claimCode.length + 1) {
				for (let i = 0; i < claimCode.length; i++) {
					paint(context, codeStart + i, {
						bgColor: '#1e3a5f',
						textColor: '#ffffff',
						text: claimCode[i] ?? '',
						fontSize: 'auto',
					})
				}
			} else {
				paint(context, codeStart, { bgColor: '#1e3a5f', text: formatted, textColor: '#ffffff' })
			}

			// A couple of buttons that visibly react, so the surface is obviously alive even before
			// anyone claims it.
			const liveIndex = context.controlIds.length - 1
			paint(context, liveIndex, { bgColor: '#005f5f', text: 'PRESS\nME' })

			if (context.controlIds.length > 4) {
				paint(context, context.controlIds.length - 2, { bgColor: '#3f3f00', text: publicUrl, fontSize: 8 })
			}
		},

		onPress(context, controlId, pressed) {
			context.draw(controlId, { pressed, bgColor: pressed ? '#00b0b0' : '#005f5f' })
		},

		onRotate(context, controlId, delta) {
			const key = `rot:${controlId}`
			const value = ((context.state.get(key) as number) ?? 0) + delta
			context.state.set(key, value)
			context.draw(controlId, { text: `${value}`, bgColor: '#005f5f' })
		},
	}
}

// ---------------------------------------------------------------------------------------------
// 2. Input echo — the most useful scenario during client development.
// ---------------------------------------------------------------------------------------------

export const inputEchoScenario: Scenario = {
	id: 'input-echo',
	name: 'Input echo',
	description:
		'Shows exactly what the server received, and how it interpreted it. The fastest way to check ' +
		'a client is sending the key numbering, rotation deltas and press/release pairs it thinks it is.',
	wants: ['colors', 'text'],

	init(context) {
		context.drawAll({ bgColor: '#14141a', textColor: '#8899aa', text: '·' })
		paint(context, 0, { bgColor: '#202030', textColor: '#ffffff', text: 'PRESS\nANY' })
	},

	onPress(context, controlId, pressed) {
		context.draw(controlId, {
			bgColor: pressed ? '#c04000' : '#404040',
			textColor: '#ffffff',
			text: pressed ? controlId : `${controlId}\nup`,
			pressed,
		})
		paint(context, 0, { text: `${pressed ? 'DOWN' : 'UP'}\n${controlId}`, bgColor: '#202030' })
	},

	onRotate(context, controlId, delta) {
		const key = `rot:${controlId}`
		const total = ((context.state.get(key) as number) ?? 0) + delta
		context.state.set(key, total)
		// Both the raw delta and the running total: the delta is what proves 1.14 multi-step rotation
		// is being sent, and the total proves nothing is being dropped.
		context.draw(controlId, {
			bgColor: '#005080',
			textColor: '#ffffff',
			text: `${delta > 0 ? '+' : ''}${delta}\n=${total}`,
		})
	},

	onPincodeKey(context, digit) {
		paint(context, 0, { text: `PIN\n${digit}`, bgColor: '#602060' })
	},

	onVariable(context, id, value) {
		paint(context, 0, { text: `${id}\n${value.slice(0, 8)}`, bgColor: '#206020' })
	},
}

// ---------------------------------------------------------------------------------------------
// 3. Companion home — the believable-looking one, for demos and screenshots.
// ---------------------------------------------------------------------------------------------

const HOME_LABELS = [
	'CAM 1',
	'CAM 2',
	'CAM 3',
	'CAM 4',
	'ATEM\nPGM',
	'ATEM\nPVW',
	'REC',
	'STREAM',
	'VT 1',
	'VT 2',
	'AUDIO\nMUTE',
	'LOWER\nTHIRD',
	'TITLES',
	'REPLAY',
	'BUG\nON',
	'FADE\nOUT',
]

export const companionHomeScenario: Scenario = {
	id: 'companion-home',
	name: 'Companion home',
	description:
		'A believable Companion page: page up/down/number keys, realistic labels and press latching. ' +
		'The scenario to use for screenshots and a demo video.',
	wants: ['colors', 'text', 'bitmaps'],

	init(context) {
		const { columns } = context.gridSize

		context.controlIds.forEach((controlId, index) => {
			// The last column becomes page navigation when the surface is wide enough for it, which is
			// how a Stream Deck page row is usually laid out.
			const column = columns > 0 ? index % columns : 0
			const isNavColumn = columns >= 4 && column === columns - 1
			const row = columns > 0 ? Math.floor(index / columns) : index

			if (isNavColumn && row === 0) {
				context.draw(controlId, { type: 'PAGEUP', bgColor: '#202020', textColor: '#ffffff', text: '' })
				return
			}
			if (isNavColumn && row === 1) {
				context.draw(controlId, { type: 'PAGENUM', bgColor: '#202020', textColor: '#ffffff', text: '1' })
				return
			}
			if (isNavColumn && row === 2) {
				context.draw(controlId, { type: 'PAGEDOWN', bgColor: '#202020', textColor: '#ffffff', text: '' })
				return
			}

			const label = HOME_LABELS[index % HOME_LABELS.length] ?? ''
			context.draw(controlId, {
				type: 'BUTTON',
				bgColor: '#1b1b22',
				textColor: '#e0e0e0',
				text: label,
			})
		})
	},

	onPress(context, controlId, pressed) {
		// Latching, so a press leaves visible state rather than flickering.
		const key = `latched:${controlId}`
		if (pressed) {
			const latched = !(context.state.get(key) as boolean)
			context.state.set(key, latched)
			context.draw(controlId, { bgColor: latched ? '#b00000' : '#1b1b22', pressed: true })
		} else {
			context.draw(controlId, { pressed: false })
		}
	},

	onChangePage(context, forward) {
		const page = Math.max(1, ((context.state.get('page') as number) ?? 1) + (forward ? 1 : -1))
		context.state.set('page', page)
		for (const controlId of context.controlIds) {
			context.draw(controlId, {})
		}
		context.log(`page changed to ${page}`)
	},
}

// ---------------------------------------------------------------------------------------------
// 4. Colour and text matrix.
// ---------------------------------------------------------------------------------------------

const TEXT_SAMPLES = [
	'plain',
	'MiXeD CaSe',
	'a really quite long label that will not fit',
	'two\nlines',
	'four\nshort\nlines\nhere',
	'héllo àccents',
	'日本語',
	'مرحبا',
	'🎛️ 🔴 ✅',
	'123456789',
	'!@#$%^&*()',
	'',
]

export const colourTextScenario: Scenario = {
	id: 'colour-text',
	name: 'Colour & text matrix',
	description:
		'Every button a different colour, with text designed to break naive rendering: long strings, ' +
		'multiple lines, accents, RTL, CJK and emoji.',
	wants: ['colors', 'text'],

	init(context) {
		context.controlIds.forEach((controlId, index) => {
			context.draw(controlId, {
				bgColor: PALETTE[index % PALETTE.length] ?? '#000000',
				textColor: index % 2 === 0 ? '#ffffff' : '#000000',
				text: TEXT_SAMPLES[index % TEXT_SAMPLES.length] ?? '',
				fontSize: index % 5 === 0 ? 10 : 'auto',
			})
		})
	},
}

// ---------------------------------------------------------------------------------------------
// 5. Bitmap torture.
// ---------------------------------------------------------------------------------------------

export const bitmapTortureScenario: Scenario = {
	id: 'bitmap-torture',
	name: 'Bitmap torture',
	description:
		'Alignment markers, high-contrast edges and per-button numbering, to catch scaling, ' +
		'orientation and stride bugs in a client decoder.',
	wants: ['bitmaps'],

	init(context) {
		const { columns } = context.gridSize
		context.controlIds.forEach((controlId, index) => {
			const row = columns > 0 ? Math.floor(index / columns) : 0
			const column = columns > 0 ? index % columns : index
			// Corner-numbered, alternating background: a transposed or mirrored image is then obvious
			// at a glance rather than something you have to squint at.
			context.draw(controlId, {
				bgColor: (row + column) % 2 === 0 ? '#ffffff' : '#000000',
				textColor: (row + column) % 2 === 0 ? '#000000' : '#ffffff',
				text: `${row},${column}`,
			})
		})
	},
}

// ---------------------------------------------------------------------------------------------
// 6. Encoder lab.
// ---------------------------------------------------------------------------------------------

export const encoderLabScenario: Scenario = {
	id: 'encoder-lab',
	name: 'Encoder lab',
	description:
		'Rotation with a value gauge and LED output. Shows the raw DIRECTION received, so multi-step ' +
		'rotation (API 1.14) can be told apart from a client sending repeated single steps.',
	wants: ['colors', 'text', 'leds'],

	init(context) {
		context.drawAll({ bgColor: '#101820', textColor: '#88ccff', text: 'TURN', gauge: 0.5 })
	},

	onRotate(context, controlId, delta) {
		const key = `value:${controlId}`
		const current = (context.state.get(key) as number) ?? 0.5
		const next = Math.min(1, Math.max(0, current + delta * 0.05))
		context.state.set(key, next)

		context.draw(controlId, {
			bgColor: '#101820',
			textColor: '#88ccff',
			text: `${Math.round(next * 100)}%\nd=${delta > 0 ? '+' : ''}${delta}`,
			gauge: next,
		})
	},

	onPress(context, controlId, pressed) {
		if (!pressed) return
		context.state.set(`value:${controlId}`, 0.5)
		context.draw(controlId, { text: 'RESET', gauge: 0.5 })
	},
}

// ---------------------------------------------------------------------------------------------
// 7. Pincode lock.
// ---------------------------------------------------------------------------------------------

const PIN = '1234'

export const pincodeScenario: Scenario = {
	id: 'pincode',
	name: 'Pincode lock',
	description: `Drives LOCKED-STATE. The PIN is ${PIN}. Also checks the rule that no drawing happens while locked.`,
	wants: ['pincode'],

	init(context) {
		context.state.set('entered', '')
		if (!context.available.has('pincode')) {
			// The client did not ask to handle the locked state, so Companion would draw lock graphics
			// onto the keys itself. Do the same rather than silently doing nothing.
			context.drawAll({ bgColor: '#301010', textColor: '#ff8080', text: 'LOCKED' })
			return
		}
		context.setLocked(true, 0)
	},

	onPincodeKey(context, digit) {
		const entered = `${(context.state.get('entered') as string) ?? ''}${digit}`

		if (entered === PIN) {
			context.state.set('entered', '')
			context.setLocked(false, 0)
			context.drawAll({ bgColor: '#103010', textColor: '#80ff80', text: 'UN-\nLOCKED' })
			return
		}

		if (entered.length >= PIN.length) {
			context.state.set('entered', '')
			context.setLocked(true, 0)
			return
		}

		context.state.set('entered', entered)
		context.setLocked(true, entered.length)
	},

	onPress(context, _controlId, pressed) {
		// Re-lock on any press once unlocked, so the flow can be exercised repeatedly.
		if (!pressed) return
		context.state.set('entered', '')
		context.setLocked(true, 0)
	},
}

// ---------------------------------------------------------------------------------------------
// 8. Brightness.
// ---------------------------------------------------------------------------------------------

export const brightnessScenario: Scenario = {
	id: 'brightness',
	name: 'Brightness ramp',
	description: 'Ramps BRIGHTNESS 0-100 and back. A client that opted out with BRIGHTNESS=0 gets nothing.',
	tickMs: 200,

	init(context) {
		context.state.set('value', 0)
		context.state.set('direction', 1)
		context.drawAll({ bgColor: '#202020', textColor: '#ffffff', text: 'BRIGHT' })
	},

	tick(context) {
		const direction = (context.state.get('direction') as number) ?? 1
		let value = ((context.state.get('value') as number) ?? 0) + direction * 5

		if (value >= 100) {
			value = 100
			context.state.set('direction', -1)
		} else if (value <= 0) {
			value = 0
			context.state.set('direction', 1)
		}

		context.state.set('value', value)
		context.setBrightness(value)
		paint(context, 0, { text: `${value}%`, bgColor: '#202020' })
	},
}

// ---------------------------------------------------------------------------------------------
// 9. Variables.
// ---------------------------------------------------------------------------------------------

export const variablesScenario: Scenario = {
	id: 'variables',
	name: 'Variables',
	description:
		'Streams VARIABLE-VALUE for every output variable the client declared, and displays whatever ' +
		'it sends back through SET-VARIABLE-VALUE.',
	wants: ['variables'],
	tickMs: 1000,

	init(context) {
		context.state.set('counter', 0)
		context.drawAll({ bgColor: '#181828', textColor: '#c0c0ff', text: 'VARS' })

		if (!context.available.has('variables')) {
			paint(context, 0, { text: 'NO\nVARS', bgColor: '#402020' })
		}
	},

	tick(context) {
		const counter = ((context.state.get('counter') as number) ?? 0) + 1
		context.state.set('counter', counter)

		for (const variable of context.device.variables) {
			if (variable.type !== 'output') continue
			// A different shape per variable, so a client showing the wrong one is obvious.
			const value = variable.id.includes('time')
				? new Date(counter * 1000).toISOString().slice(11, 19)
				: `${variable.name}: ${counter}`
			context.sendVariable(variable.id, value)
		}

		paint(context, 0, { text: `TICK\n${counter}`, bgColor: '#181828' })
	},

	onVariable(context, id, value) {
		paint(context, 1, { text: `${id}\n${value.slice(0, 10)}`, bgColor: '#204020' })
	},
}

// ---------------------------------------------------------------------------------------------
// 10. Attract — the slow pretty one, for an unattended demo.
// ---------------------------------------------------------------------------------------------

export const attractScenario: Scenario = {
	id: 'attract',
	name: 'Attract loop',
	description: 'A slow colour sweep for an unattended demo or a screen recording. Rate-capped by design.',
	wants: ['colors'],
	tickMs: 200,

	init(context) {
		context.state.set('frame', 0)
		context.drawAll({ bgColor: '#000000', text: '' })
	},

	tick(context) {
		const frame = ((context.state.get('frame') as number) ?? 0) + 1
		context.state.set('frame', frame)

		const { columns } = context.gridSize
		context.controlIds.forEach((controlId, index) => {
			const row = columns > 0 ? Math.floor(index / columns) : 0
			const column = columns > 0 ? index % columns : index
			const hue = (frame * 4 + (row + column) * 24) % 360
			context.draw(controlId, { bgColor: hslToHex(hue, 70, 45), textColor: '#ffffff', text: '' })
		})
	},
}

/** hsl to #rrggbb, so scenarios can sweep hues without pulling in a colour library. */
export function hslToHex(h: number, s: number, l: number): string {
	const saturation = s / 100
	const lightness = l / 100
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
	const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
	const m = lightness - chroma / 2

	const [r, g, b] =
		h < 60
			? [chroma, x, 0]
			: h < 120
				? [x, chroma, 0]
				: h < 180
					? [0, chroma, x]
					: h < 240
						? [0, x, chroma]
						: h < 300
							? [x, 0, chroma]
							: [chroma, 0, x]

	const toHex = (value: number) =>
		Math.round((value + m) * 255)
			.toString(16)
			.padStart(2, '0')
	return `#${toHex(r ?? 0)}${toHex(g ?? 0)}${toHex(b ?? 0)}`
}

/** Every scenario that does not need construction. The Unclaimed one takes a claim code. */
export const BUILTIN_SCENARIOS: readonly Scenario[] = [
	inputEchoScenario,
	companionHomeScenario,
	colourTextScenario,
	bitmapTortureScenario,
	encoderLabScenario,
	pincodeScenario,
	brightnessScenario,
	variablesScenario,
	attractScenario,
]

export function findScenario(id: string): Scenario | undefined {
	return BUILTIN_SCENARIOS.find((scenario) => scenario.id === id)
}
