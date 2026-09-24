// The six things worth interrupting a site owner about.
//
//   disapproval spike   a lot of products stopped being shown at once
//   feed fetch failed   Google could not read the feed
//   delivery out of sync  what Merchant Center charges is not what we charge
//   figures not fetched   the daily report import is failing
//   live updates stuck  price and stock changes are not reaching Google
//   ads upload stuck    sales from paid clicks are not reaching Google Ads
//
// All six go through core's upsertAlert/clearAlert, keyed so that each one
// only ever holds a single rolling notification in the bell: raised while the
// thing is true, cleared the moment it stops being true. Nothing here creates
// a second notification for the same concern on the next cron run.
//
// The email is an extra, off by default, to an address the owner typed in. It
// is never the only signal - the bell is always raised first - so a bounced or
// switched-off email loses nothing.
import { clearAlert, upsertAlert } from '@/lib/notifications/alerts'
import { prisma } from '@/lib/db/prisma'
import { sendTemplateEmail } from '@/lib/email'
import { getGsfSettings } from '@/modules/google-shopping-for-shop/lib/settings'
import { isDisapprovalSpike, type SpikeCheck } from '@/modules/google-shopping-for-shop/lib/health/spike'
import { FETCH_STATE_LABELS, type FeedFetchStatus, type FetchUnavailableReason } from '@/modules/google-shopping-for-shop/lib/health/types'

/** Admin-relative; core's bell puts the site's own admin prefix in front. */
export const HEALTH_LINK = '/m/shop/products?tab=google-shopping-workbench&sub=health'
const DELIVERY_LINK = '/m/shop/products?tab=google-shopping-workbench&sub=shipping'
const REPORTS_LINK = '/m/shop/products?tab=google-shopping-workbench&sub=reports'

export const ALERT_KEYS = {
  disapprovalSpike: 'google-shopping:disapproval-spike',
  feedFetch: 'google-shopping:feed-fetch',
  /** Raised by the delivery sync in stage 3 through setDeliverySyncAlert
   *  below. Named here so both halves agree on one string. */
  deliverySync: 'google-shopping:delivery-out-of-sync',
  /** Raised when the daily import of Google's own figures fails. Quiet by
   *  nature - it is a report, not the shop - but it has to be said somewhere
   *  a person will see it, because the alternative is a console line on a
   *  server nobody reads and a Reports tab that looks fine. */
  performanceImport: 'google-shopping:performance-import',
  /** Raised when the live price and stock updates are not getting through -
   *  a refusal from Google, a send whose outcome was never learned, or the
   *  supplemental data source having gone missing. The loudest of the five by
   *  nature: everything else here is about reporting, and this one means the
   *  price being advertised is not the price being charged. */
  pricePush: 'google-shopping:price-push',
  /** Raised when the sales this site credits to a paid Google click are not
   *  reaching Google Ads - a refusal from Google, or the conversion action
   *  turning out to be a primary one. Quieter than the price push by nature:
   *  nothing a shopper sees depends on it, but an owner bidding on figures
   *  that are missing half their sales is spending real money on a wrong
   *  number. */
  adsUpload: 'google-shopping:ads-upload',
} as const

export const EMAIL_TEMPLATE_KEY = 'google-shopping-for-shop.health-alert'

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`
}

/**
 * Raises or clears an alert and, when the owner has asked for it, emails.
 *
 * The email only goes out on the way UP - the transition from fine to not
 * fine. An hourly cron that found the same problem still there would otherwise
 * send the same email every hour, which is how an alert address becomes a
 * filter rule.
 */
async function raise(options: {
  key: string
  title: string
  link: string
  actionLabel: string
  /** Carried on the notification for the next run to read back. */
  reasons?: unknown
  /** For the email. Left out means "bell only". */
  email?: { heading: string; detail: string }
  /** True when the alert was already up, so no email is sent again. */
  alreadyUp: boolean
}): Promise<void> {
  await upsertAlert({
    type: 'alert',
    dedupeKey: options.key,
    title: options.title,
    link: options.link,
    actionLabel: options.actionLabel,
    ...(options.reasons === undefined ? {} : { reasons: options.reasons }),
  })
  if (options.alreadyUp || !options.email) return
  await sendAlertEmail(options.email.heading, options.email.detail)
}

// No link in the email on purpose. The only page worth linking to is inside
// the admin, and this site's admin lives behind a path the owner chose to keep
// to themselves - putting it in an email to an address typed into a settings
// box is how that stops being a secret. The bell has the button; the email
// says where to look.
async function sendAlertEmail(heading: string, detail: string): Promise<void> {
  const settings = await getGsfSettings()
  if (!settings.alertEmailEnabled || !settings.alertEmail) return
  try {
    await sendTemplateEmail(settings.alertEmail, EMAIL_TEMPLATE_KEY, { heading, detail })
  } catch (error) {
    // An alert whose email bounces is still an alert. The bell has it.
    console.error('[google-shopping] could not email the health alert:', error)
  }
}

export type SpikeInput = SpikeCheck & {
  /**
   * The figure the open spike alert was raised FROM, or null when no spike
   * alert is up. Read with readSpikeBaseline().
   *
   * It lives on the notification rather than in settings on purpose: it is a
   * property of the open alert, not of the shop, so clearing the alert throws
   * it away at exactly the right moment and no column has to be reset.
   */
  openBaseline: number | null
}

export { isDisapprovalSpike } from '@/modules/google-shopping-for-shop/lib/health/spike'

/** What the open spike alert is measuring against, or null when none is up. */
export async function readSpikeBaseline(): Promise<number | null> {
  const held = await prisma.notification.findFirst({ where: { dedupeKey: ALERT_KEYS.disapprovalSpike } })
  if (!held) return null
  const reasons = held.reasons as { baseline?: unknown } | null
  // An alert raised by an older build carries no baseline. Treat that as zero
  // rather than as "no alert": the notice is up, and a zero baseline means it
  // clears only when the count is back to nothing, which is the behaviour it
  // had when it was raised.
  return typeof reasons?.baseline === 'number' ? reasons.baseline : 0
}

/**
 * Raises the spike alert, keeps its wording current, and clears it when the
 * count comes back down to where it started.
 *
 * Four states, not two:
 *   switched off     threshold 0 means no alert, and takes down any that is up
 *   no alert up      raise one if disapprovals have JUMPED (lib/health/spike.ts)
 *   alert up, worse  rewrite the title so it is not quoting last week's figure
 *   alert up, better clear it once the count is back at or below the figure it
 *                    was raised from
 *
 * The old rule cleared only at exactly zero, which meant a shop that went from
 * 3 to 200 and back to 3 kept "197 more products" in the bell for ever. A
 * notice that never goes away is a notice nobody reads.
 */
export async function syncDisapprovalAlert(input: SpikeInput): Promise<boolean> {
  // Off means off, and that has to be tested FIRST.
  //
  // The threshold used to be consulted only by isDisapprovalSpike, which is
  // reached only when no alert is up - so an owner with a notice already in
  // the bell could set the threshold to 0 to make it stop, and watch it go on
  // re-titling itself and re-lighting the bell every time the count moved.
  // The settings hint and migration 018 both promise that 0 switches it off,
  // so 0 also takes down whatever is already showing.
  if (input.threshold <= 0) {
    await clearAlert(ALERT_KEYS.disapprovalSpike)
    return false
  }

  const baseline = input.openBaseline

  if (baseline !== null) {
    // Back to where it started, or better. The thing the alert was about is
    // over, whether or not anything is still disapproved: a shop with three
    // permanently awkward products is not in the middle of an incident.
    if (input.disapproved <= baseline) {
      await clearAlert(ALERT_KEYS.disapprovalSpike)
      return false
    }
    // Still elevated. Rewrite it against the SAME baseline, so the number in
    // the bell is the size of the thing that is still wrong. alreadyUp stops
    // it emailing again.
    await raiseSpike(input.disapproved, baseline, true)
    return true
  }

  if (!isDisapprovalSpike(input)) return false
  // The figure it spiked from is the one the next run measures against.
  await raiseSpike(input.disapproved, input.previous ?? 0, false)
  return true
}

async function raiseSpike(disapproved: number, baseline: number, alreadyUp: boolean): Promise<void> {
  const jump = disapproved - baseline
  await raise({
    key: ALERT_KEYS.disapprovalSpike,
    title: `Google has stopped showing ${plural(jump, 'more product')} - ${plural(disapproved, 'product')} in total`,
    link: HEALTH_LINK,
    actionLabel: 'See what Google is unhappy about',
    // Carried on the notification so the next run knows what this one was
    // measuring against. upsertAlert stores it as jsonb and leaves it alone
    // unless we pass a different one.
    reasons: { baseline },
    email: {
      heading: 'Google has stopped showing a lot of your products',
      detail: `${plural(jump, 'product')} stopped being shown since the last check, and ${plural(disapproved, 'product')} `
        + 'are now being turned down in total. The Health tab lists them with Google\'s own reason against each one.',
    },
    alreadyUp,
  })
}

export type FetchAlertInput =
  | { status: 'ok'; fetch: FeedFetchStatus; alreadyUp: boolean }
  | { status: 'unavailable'; reason: FetchUnavailableReason; alreadyUp: boolean }

/** Raises the feed fetch alert when Google could not read the feed, and clears
 *  it when it could. */
export async function syncFeedFetchAlert(input: FetchAlertInput): Promise<boolean> {
  if (input.status === 'unavailable') {
    // NONE of these is worth an alert, 'not-found' included.
    //
    // "No key saved", "no account number" and "we could not reach Google" are
    // setup or weather. 'not-found' looks more alarming but covers the same
    // ground: a shop that has not made the data source yet, and one Google has
    // never got round to fetching. Both are standing states that would sit in
    // the bell from the day the module was installed until the day somebody
    // finished setting it up - which is exactly the permanent furniture the
    // spike rule goes out of its way to avoid.
    //
    // The Health tab says all of it in words, with what to do about it
    // (FETCH_UNAVAILABLE_COPY). A real failure - Google fetched and could not
    // read what it got - is handled below, and that one does alert.
    await clearAlert(ALERT_KEYS.feedFetch)
    return false
  }

  if (input.fetch.state !== 'failed') {
    await clearAlert(ALERT_KEYS.feedFetch)
    return false
  }
  const worst = input.fetch.issues.find((issue) => issue.severity === 'error') ?? input.fetch.issues[0]
  await raise({
    key: ALERT_KEYS.feedFetch,
    title: `Google could not read your product feed${worst ? ` - ${worst.title}` : ''}`,
    link: HEALTH_LINK,
    actionLabel: 'See the feed check',
    email: {
      heading: 'Google could not read your product feed',
      detail: worst
        ? `Google says: ${worst.title}. ${worst.description}`.trim()
        : `Google marked its last read of the feed as "${FETCH_STATE_LABELS.failed}" without saying why.`,
    },
    alreadyUp: input.alreadyUp,
  })
  return true
}

/**
 * The delivery sync's way in, for stage 3.
 *
 * Kept here, with the other two, so there is one file that knows every alert
 * this module can raise and one place the keys are spelled. The delivery work
 * itself owns the comparison; this owns the notification.
 *
 * `differences` is how many delivery services disagree with Merchant Center;
 * zero clears the alert.
 */
export async function setDeliverySyncAlert(options: {
  differences: number
  /** One short line naming what disagrees, for the email. */
  detail?: string
  alreadyUp?: boolean
}): Promise<boolean> {
  if (options.differences <= 0) {
    await clearAlert(ALERT_KEYS.deliverySync)
    return false
  }
  await raise({
    key: ALERT_KEYS.deliverySync,
    title: `Your delivery charges and Google's do not match (${plural(options.differences, 'difference')})`,
    link: DELIVERY_LINK,
    actionLabel: 'Compare them',
    email: {
      heading: 'Your delivery charges and Google\'s do not match',
      detail: options.detail
        ?? `${plural(options.differences, 'delivery service')} charge something different at Merchant Center from what this site charges.`,
    },
    alreadyUp: options.alreadyUp ?? false,
  })
  return true
}

/**
 * The daily figures import failed, or stopped failing.
 *
 * Same shape as setDeliverySyncAlert: this file owns the notification, the
 * import owns the attempt. Called on BOTH paths of every run, so a run that
 * succeeds takes yesterday's notice down rather than leaving it to rot.
 *
 * `message` is Google's own sentence where there is one. It reaches an email
 * and a bell, so it is trimmed to a line; no credential ever passes through
 * here (lib/google/errors.ts is explicit about that).
 */
export async function setPerformanceImportAlert(options: {
  failed: boolean
  message?: string
  alreadyUp?: boolean
}): Promise<boolean> {
  if (!options.failed) {
    await clearAlert(ALERT_KEYS.performanceImport)
    return false
  }
  await raise({
    key: ALERT_KEYS.performanceImport,
    title: 'Google\u2019s figures could not be fetched',
    link: REPORTS_LINK,
    actionLabel: 'Open Reports',
    email: {
      heading: 'Google\u2019s figures could not be fetched',
      detail: options.message?.trim()
        ? `The daily fetch of Google\u2019s own click and sales figures did not finish. Google said: ${options.message.trim().slice(0, 300)}`
        : 'The daily fetch of Google\u2019s own click and sales figures did not finish. Nothing else about your feed is affected.',
    },
    alreadyUp: options.alreadyUp ?? false,
  })
  return true
}

/**
 * The live price and stock updates are, or are no longer, in trouble.
 *
 * Called on EVERY path out of the worker, including the ones that do nothing at
 * all - switched off, not set up, nothing queued. That is not tidiness: an
 * alert raised by yesterday's failure and then never cleared because the owner
 * turned the feature off is a notice about a thing that is no longer happening,
 * and the bell has no way to know that.
 *
 * `message` is Google's own sentence where there is one, trimmed to a line.
 * lib/google/errors.ts is explicit that no credential ever reaches one.
 */
export async function setPricePushAlert(options: {
  failed: boolean
  /** How many items are currently refused, for the title. */
  items?: number
  message?: string
  alreadyUp?: boolean
}): Promise<boolean> {
  if (!options.failed) {
    await clearAlert(ALERT_KEYS.pricePush)
    return false
  }
  const items = options.items ?? 0
  await raise({
    key: ALERT_KEYS.pricePush,
    title: items > 0
      ? `Your latest prices are not reaching Google (${plural(items, 'product')})`
      : 'Your latest prices are not reaching Google',
    link: HEALTH_LINK,
    actionLabel: 'Open Health',
    email: {
      heading: 'Your latest prices are not reaching Google',
      detail: options.message?.trim()
        ? `Price and stock changes are not getting through to Merchant Center, so Google may still be showing the old ones. ${options.message.trim().slice(0, 300)}`
        : 'Price and stock changes are not getting through to Merchant Center, so Google may still be showing the old ones.',
    },
    alreadyUp: options.alreadyUp ?? false,
  })
  return true
}

/**
 * The Google Ads conversion upload is, or is no longer, in trouble.
 *
 * Called on EVERY path out of the upload run, including the ones that do
 * nothing at all - switched off, not connected, nothing to send. That is the
 * lesson stage 4 paid for twice: an alert raised by yesterday's failure and
 * never cleared because the owner switched the feature off is a notice about
 * something that is no longer happening, and the bell has no way to know.
 *
 * `message` is Google's own sentence where there is one, trimmed to a line.
 * lib/google/errors.ts is explicit that no credential ever reaches one.
 */
export async function setAdsUploadAlert(options: {
  failed: boolean
  /** How many sales are currently not getting through, for the title. */
  items?: number
  message?: string
  alreadyUp?: boolean
}): Promise<boolean> {
  if (!options.failed) {
    await clearAlert(ALERT_KEYS.adsUpload)
    return false
  }
  const items = options.items ?? 0
  await raise({
    key: ALERT_KEYS.adsUpload,
    title: items > 0
      ? `Google Ads is not being told about your sales (${plural(items, 'order')})`
      : 'Google Ads is not being told about your sales',
    link: HEALTH_LINK,
    actionLabel: 'Open Health',
    email: {
      heading: 'Google Ads is not being told about your sales',
      detail: options.message?.trim()
        ? `Sales that came from a paid Google click are not reaching Google Ads, so the figures you are bidding on are missing some of them. ${options.message.trim().slice(0, 300)}`
        : 'Sales that came from a paid Google click are not reaching Google Ads, so the figures you are bidding on are missing some of them.',
    },
    alreadyUp: options.alreadyUp ?? false,
  })
  return true
}

/** Whether one of our alerts is currently showing, so a repeat run does not
 *  re-send its email. Cheap: one indexed lookup per key. */
export async function isAlertUp(key: string): Promise<boolean> {
  return (await prisma.notification.count({ where: { dedupeKey: key } })) > 0
}
