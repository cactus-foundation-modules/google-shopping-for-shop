import type { EmailTemplateDef } from '@/lib/email/registry'

// The one email this module can send: a health alert, off unless the owner
// switches it on and gives an address.
//
// Non-transactional on purpose. It is a courtesy notice about a shop's own
// marketing feed, not an account or security email, so it gets the on/off
// toggle in Settings > Emails like everything else of its kind - and an owner
// who decides the bell is enough can turn it off there without coming back to
// the Google Shopping tab.
//
// There is deliberately no link in it. The only page worth linking to is
// inside the admin, which lives behind a path the owner chose to keep private;
// an email to an address typed into a settings box is not the place to put it.
export const googleShoppingEmailTemplates: EmailTemplateDef[] = [
  {
    key: 'google-shopping-for-shop.health-alert',
    label: 'Google Shopping health alert',
    subject: '{{heading}} - {{siteName}}',
    bodyHtml:
      '<p><strong>{{heading}}</strong></p>'
      + '<p>{{detail}}</p>'
      + '<p>Open your shop\'s admin, go to Products and then the Google Shopping tab, and look under Health. '
      + 'Everything Google has told us is on that one screen.</p>'
      + '<p>You are getting this because health alerts are switched on for {{siteName}}. '
      + 'Turn them off on the Google Shopping settings tab whenever you like.</p>',
    mergeTags: ['heading', 'detail', 'siteName'],
    requiredTags: ['heading'],
    transactional: false,
  },
]
