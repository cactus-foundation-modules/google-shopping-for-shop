// The script that runs on the visitor's page.
//
// It is tiny, and it has to be: it goes out with every public page on the site,
// ahead of the header, on a site whose whole speed story is that the page is
// cached and cheap. So it does four things and nothing else - look at the
// address, say so if Google sent the visitor, pass on a sale the shop
// announces, and say when somebody withdraws their consent - and it does the
// first of them in a few string tests before it decides whether to exist at
// all.
//
// Why inline rather than a component: the beacon has to be on every product
// page of every install that switches it on, with nobody having to place
// anything. Core already has exactly that seam - modules/<name>/lib/head.ts,
// collected by app/(public)/layout.tsx - so this rides it instead of adding a
// block an owner would have to find and drop into a layout, or, far worse,
// module code in core's proxy.
//
// What it does NOT do, on purpose:
//   - it never reports a product id. The server resolves the address itself,
//     because a browser is not a source of truth about what it is looking at.
//   - it never reads or writes a cookie. The attribution cookie is httpOnly
//     and set by the server, so no script on the page - ours or anybody
//     else's - can read it or hand a different visitor's id to the conversion
//     route.
//   - it never blocks. Both calls are scheduled after load, and both are
//     wrapped so that a browser without fetch, or with it blocked, loses the
//     figure rather than the page.
//
// Written as a plain string, in the same old-fashioned JavaScript the theme and
// tax-view boot scripts use: this runs before anything has hydrated, on
// whatever the visitor is using, and there is no build step between here and
// their browser.

import type { ProductUrlStyle } from '@/modules/shop/lib/product-url'

/** Where the two public routes live. One constant, because a typo here is a
 *  feature that silently records nothing. */
const PUBLIC_BASE = '/api/m/google-shopping-for-shop/public'

/** The longest query string the beacon will report. Long enough for every
 *  option parameter a listing has plus Google's own tags, short enough that a
 *  crafted address cannot post a novel. The server caps it again.
 *
 *  Applied AFTER the address has been tested, never before. A listing with a
 *  long option query plus Google's own tags can run past this, and Google
 *  appends its parameters at the END - so truncating first would cut off the
 *  very thing being looked for and the beacon would silently never fire on
 *  exactly the busiest listings. */
const SEARCH_MAX = 1000

/** The path shapes a product page can have, by the shop's own URL style. The
 *  SAME rule the server applies in lib/click-tracking/resolve.ts - derived from
 *  the same setting, so the two cannot disagree about what a product address
 *  looks like.
 *
 *  It exists to save a round trip: without it the beacon posts from any tagged
 *  address, including a category page somebody is running a search ad to, and
 *  the server works out there is no product and records nothing. With it the
 *  request is never made. It can only ever suppress a post the server would
 *  have refused anyway. */
export const PRODUCT_PATH_PATTERN: Record<'ROOT' | 'SHOP', string> = {
  ROOT: '^/[^/]+/?$',
  SHOP: '^/shop/products/[^/]+/?$',
}

/**
 * The beacon, as one self-contained expression.
 *
 * Deliberately returns the same string every time it is called with the same
 * arguments: the page it goes onto is cached and shared, so anything
 * per-visitor in here would be served to the wrong visitor.
 *
 * `style` is the shop's own product URL setting, turned into an address shape
 * by PRODUCT_PATH_PATTERN above. Only the LANDING half is gated on it - a sale
 * is announced on the confirmation page, which is not a product address, and a
 * withdrawal can happen anywhere at all.
 */
export function beaconScript(style: ProductUrlStyle): string {
  const productPathPattern = PRODUCT_PATH_PATTERN[style]
  return `(function(){try{
var B=${JSON.stringify(PUBLIC_BASE)};
var q=String(window.location.search||'');
function post(p,b){try{if(!window.fetch)return;fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),credentials:'same-origin',keepalive:true})['catch'](function(){});}catch(e){}}
function has(n){return new RegExp('[?&]'+n+'=[^&]').test(q)}
var tagged=/[?&]utm_source=google(&|$)/i.test(q)&&/[?&]utm_campaign=shopping(&|$)/i.test(q);
var path=String(window.location.pathname||'');
if((tagged||has('gclid')||has('gbraid')||has('wbraid')||has('srsltid'))&&new RegExp(${JSON.stringify(productPathPattern)}).test(path)){
var land=function(){post('/landing',{path:path.slice(0,512),search:q.slice(0,${SEARCH_MAX})});};
if(document.readyState==='complete'){setTimeout(land,0);}else{window.addEventListener('load',function(){setTimeout(land,0);});}
}
var done={};
function sale(c){try{if(!c||c.type!=='purchase'||!c.transactionId)return;var id=String(c.transactionId).slice(0,64);if(done[id])return;done[id]=1;post('/conversion',{orderNumber:id});}catch(e){}}
window.addEventListener('cactus:conversion',function(e){sale(e&&e.detail);});
var buffered=window.__cactusConversions;
if(buffered&&buffered.length){for(var i=0;i<buffered.length;i++){sale(buffered[i]);}}
window.addEventListener('cactus:consent-change',function(e){try{var d=e&&e.detail;if(d&&d.marketing===true)return;post('/forget',{});}catch(err){}});
}catch(e){}})();`
}

/** The id the script carries in the document, so two copies can never be
 *  rendered and a person reading the page source can see whose it is. */
export const BEACON_SCRIPT_ID = 'google-shopping-landing'
