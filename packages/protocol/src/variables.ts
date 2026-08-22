import { z } from 'zod'

/**
 * The `VARIABLES` parameter of `ADD-DEVICE`: base64 of a JSON array.
 *
 * Upstream validates this by hand and throws on anything malformed, which the caller turns into
 * `Invalid VARIABLES`. Expressed as a schema here so the failure is describable, but the accepted
 * shape is deliberately identical — including that `description` is optional and that any other
 * property is ignored rather than rejected.
 */
export const TransferableValueSchema = z.object({
	id: z.string(),
	type: z.enum(['input', 'output']),
	name: z.string(),
	description: z.string().optional(),
})
export type TransferableValue = z.infer<typeof TransferableValueSchema>

export const TransferableValuesSchema = z.array(TransferableValueSchema)

/**
 * Parse the decoded `VARIABLES` JSON.
 *
 * Returns `undefined` for anything invalid — every caller answers with a protocol error rather than
 * propagating an exception. A null or absent payload is an empty list, matching upstream, which
 * returns `[]` for a falsey decoded value rather than treating it as malformed.
 */
export function parseTransferableValues(decoded: unknown): TransferableValue[] | undefined {
	if (!decoded) return []
	const parsed = TransferableValuesSchema.safeParse(decoded)
	return parsed.success ? parsed.data : undefined
}
