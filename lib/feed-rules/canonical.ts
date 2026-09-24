// One spelling of a JSON value, whatever order its keys arrived in. Pure, so
// the rule builder in the browser and the undo on the server compare drafts
// the same way.

/** JSON with every object's keys sorted. jsonb hands keys back in its own
 *  order, so two snapshots of the same rule only compare equal this way. */
export function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort)
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sort(v)]))
    }
    return input
  }
  return JSON.stringify(sort(value))
}
