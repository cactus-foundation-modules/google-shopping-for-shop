// Where the change log's undo handlers get loaded.
//
// A handler registers itself when its own module is first imported
// (registerUndoHandler in lib/change-log.ts), which means nothing registers at
// all unless something has imported it. Anything that undoes imports THIS file,
// and this file side-effect imports every area that has a handler, so the list
// lives in one place rather than depending on whichever route loaded first.
//
// Static imports on purpose: a dynamic import() is an edge the bundler follows
// too, and a server-only area pulled in through one has a habit of turning up
// in a client chunk.
//
// Adding an area is a single import line here.
import '@/modules/google-shopping-for-shop/lib/feed-rules/undo'
import '@/modules/google-shopping-for-shop/lib/feed-choice'
import '@/modules/google-shopping-for-shop/lib/delivery/push'
import '@/modules/google-shopping-for-shop/lib/push/setup'

/** Importing this module is what loads the handlers; calling this is how a
 *  route says so out loud, and stops the import being tidied away as unused. */
export function loadChangeLogHandlers(): void {
  // Deliberately empty. The imports above are the work.
}
