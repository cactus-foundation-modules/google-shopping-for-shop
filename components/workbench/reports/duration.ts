// "How long did they take to buy?" in words.
//
// Its own file so it can be tested without a browser: the whole point of the
// figure is that it is often days rather than minutes - a desk is not an
// impulse buy - and a formatter that rounded three days to "72 hours" would
// make that the reader's problem.
import { plural } from '@/modules/google-shopping-for-shop/components/workbench/format'

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'not known'
  if (seconds < 60) return 'under a minute'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes - hours * 60
    return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours - days * 24
  return restHours === 0 ? plural(days, 'day') : `${plural(days, 'day')} ${plural(restHours, 'hour')}`
}
