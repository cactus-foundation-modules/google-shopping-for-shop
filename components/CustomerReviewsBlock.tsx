// GoogleCustomerReviews Puck block - editor-safe half. The real work happens in
// CustomerReviewsBlock.rsc.tsx, which reads the module's settings and the
// site's cookie banner and so cannot be imported from the editor bundle.
//
// The block carries no props. Which Merchant Center account, where the dialog
// sits and how long delivery takes are all site-wide settings, not layout
// decisions. This is a placement marker: it says "offer Google's survey on this
// page" and nothing more.

function EditorPreview() {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
      padding: '0.5rem 0.9rem', borderRadius: '0.5rem', margin: '0.5rem',
      background: 'var(--color-surface-subtle, #f4f1ea)',
      border: '1px dashed var(--color-border, #e5e0d8)',
      color: 'var(--color-text-secondary, #6b6355)',
      fontSize: '0.8125rem', fontWeight: 600,
    }}>
      ⭐ Google review survey (the shopper sees Google&apos;s own dialog)
    </div>
  )
}

export const googleCustomerReviewsBlockComponent = {
  label: 'Google Review Survey',
  fields: {},
  defaultProps: {},
  render: EditorPreview,
}
