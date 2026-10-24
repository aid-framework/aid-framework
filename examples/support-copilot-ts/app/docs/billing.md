# Billing

## Duplicate charges

A customer who was charged twice for the same invoice should be refunded the duplicate
amount. Confirm both charges carry the same invoice id before refunding, and refund only
the later of the two: charging twice is usually a retried payment, not a second purchase.

Refunds settle against the original payment method and take up to five business days to
appear on the customer's statement. Do not promise a faster window.

## Failed payments

A failed payment leaves the invoice open rather than void. The customer can retry it from
the billing portal, and the retry reuses the same invoice id.

## Plan changes

A plan change takes effect at the next billing period. The current period is already
invoiced, so the customer is not charged twice for it.
