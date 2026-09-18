// Display formatting for the workbench. British English throughout.

export function formatCount(value: number): string {
  return value.toLocaleString('en-GB')
}

/** "1 item", "3,214 items". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`
}

export function formatMoney(amount: number, currency: string): string {
  return amount.toLocaleString('en-GB', { style: 'currency', currency: currency || 'GBP' })
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

/** "just now", "4 minutes ago", "2 hours ago", "3 days ago". */
export function agoFromSeconds(seconds: number): string {
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${plural(hours, 'hour')} ago`
  return `${plural(Math.round(hours / 24), 'day')} ago`
}
