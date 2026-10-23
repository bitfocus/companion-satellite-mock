import { useCallback, useState } from 'react'

/** Run a mutation and keep a one-line outcome to show beside the control that triggered it. */
export function useAction(): [(fn: () => Promise<unknown>, ok: string) => Promise<void>, string | null] {
	const [message, setMessage] = useState<string | null>(null)

	const act = useCallback(async (fn: () => Promise<unknown>, ok: string) => {
		try {
			await fn()
			setMessage(ok)
		} catch (caught) {
			setMessage(caught instanceof Error ? caught.message : 'Failed')
		}
	}, [])

	return [act, message]
}
