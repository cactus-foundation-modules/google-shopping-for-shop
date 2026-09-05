// GET /api/m/google-shopping-for-shop/public/customer-reviews?orderNumber=&t=
//
// What the order confirmation page needs to draw Google's survey opt-in. The
// customer's own email is in the answer, so the request has to prove it is
// about their order: the `t` parameter is the shop's signed receipt token, the
// same proof the confirmation page uses to fetch the order itself, and an order
// number on its own gets nothing (they are a prefix and a sequence).
//
// Every refusal is the same empty answer rather than a status code that says
// which test failed. Somebody probing this with guessed order numbers should
// not be able to tell "no such order" from "not paid yet" from "the module is
// switched off".
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { buildCustomerReviewsOptIn } from '@/modules/google-shopping-for-shop/lib/customer-reviews'

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const orderNumber = params.get('orderNumber')
  const token = params.get('t')
  if (!orderNumber || !token) return NextResponse.json({ optIn: null })

  const optIn = await buildCustomerReviewsOptIn(orderNumber, token)
  // Never cached, anywhere: the answer carries one customer's email address.
  return NextResponse.json({ optIn }, { headers: { 'Cache-Control': 'no-store, private' } })
}
