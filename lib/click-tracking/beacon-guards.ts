// Two small refusals the public routes share.
//
// Their own file, and unit tested, because both are the kind of thing that
// looks obviously right and is quietly wrong: a size cap applied a moment too
// late caps nothing, and an error logger that is nearly careful enough writes a
// visitor's click identifier into a server log for ever.

/**
 * Whether a request's DECLARED body size is already over the limit.
 *
 * Checked before the body is read, which is the whole point: `await
 * request.text()` has allocated the thing by the time its length can be
 * measured, so a cap applied afterwards protects nothing.
 *
 * A missing, malformed or negative Content-Length reads as "not known", NOT as
 * "too large": the header is absent on a chunked request, and refusing those
 * would refuse ordinary browsers. The caller keeps its check on what actually
 * arrived as the backstop for exactly that case.
 */
export function tooLarge(contentLength: string | null | undefined, limit: number): boolean {
  if (!contentLength) return false
  const declared = Number(contentLength.trim())
  if (!Number.isFinite(declared) || declared < 0) return false
  return declared > limit
}

/**
 * All that is ever logged about a failure on a public route.
 *
 * Not the error object, and not its message. Prisma's raw-query errors can
 * echo the parameters the query was given, and the parameters on these routes
 * include the click identifier and the attribution id - the two fields in this
 * whole feature that exist only because a visitor said yes to them. A server
 * log is not somewhere they agreed to be.
 *
 * A name is enough to tell a database being down from a bug in a parser, which
 * is all anybody reads these lines for.
 */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error'
  return typeof error
}
