// The "See it on Google" block at the top of a product's Google Shopping tab:
// one link per listing this product puts in the feed, straight into Merchant
// Center's own page for it. Server-rendered - these are links and nothing else,
// so there is no state to hand a client component.
import type { GsfMerchantLinksView } from '@/modules/google-shopping-for-shop/lib/merchant-centre'

const box = {
  border: '1px solid var(--color-border)',
  borderRadius: 12,
  padding: '0.875rem 1rem',
  background: 'var(--color-surface)',
  marginBottom: '1.25rem',
  maxWidth: 640,
} as const

const heading = { fontSize: '0.9375rem', fontWeight: 600, margin: '0 0 0.25rem', color: 'var(--color-text)' } as const
const note = { fontSize: '0.8125rem', color: 'var(--color-text-muted)', margin: 0 } as const

export function MerchantCentreLinks({ view }: { view: GsfMerchantLinksView }) {
  return (
    <section style={box}>
      <h3 style={heading}>On Google Shopping</h3>
      {view.excluded ? (
        <p style={note}>This product sits the feed out, so Google has no listing for it.</p>
      ) : !view.merchantId ? (
        <p style={note}>
          Add your Merchant Center account number under Settings → Shop → Google Shopping and each variation below gains a link
          straight to its listing.
        </p>
      ) : view.links.length === 0 ? (
        <p style={note}>Nothing here goes to Google yet - every variation is either switched off or not on sale.</p>
      ) : (
        <>
          <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {view.links.map((link) => (
              <li key={link.offerId} style={{ fontSize: '0.875rem' }}>
                <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary, var(--color-text))' }}>
                  {link.label || 'View in Merchant Center'}
                </a>
                {link.label && <span style={{ color: 'var(--color-text-muted)' }}> - view in Merchant Center</span>}
              </li>
            ))}
          </ul>
          <p style={{ ...note, marginTop: '0.6rem' }}>
            {view.feedOff
              ? 'The feed is switched off at the moment, so these will only lead anywhere once it is back on and Google has read it.'
              : 'A brand new product takes a day or so to appear - Google reads the feed on its own schedule, so a link can be early rather than wrong.'}
          </p>
        </>
      )}
    </section>
  )
}
