// What the Reports tab's refresh button gets back.
//
// In a file of its own because both ends need it: the route that does the work
// and the browser code that reads the answer. A type declared in a route file
// would have a client component importing a server route to name a shape,
// which is the sort of edge that builds locally and falls over on a real one.
//
// `failed` is a normal member of each union, not an exception: the two imports
// are attempted independently, and one Google will not answer must not hide
// the other one's answer.
import type { ImportOutcome } from '@/modules/google-shopping-for-shop/lib/performance/import'
import type { BestSellersOutcome } from '@/modules/google-shopping-for-shop/lib/best-sellers/import'

export type RefreshFailure = { status: 'failed'; message: string }

export type RefreshReportsResult = {
  performance: ImportOutcome | RefreshFailure
  bestSellers: BestSellersOutcome | RefreshFailure
}
