Hey @gianlieberum-creator — thanks for the detailed write-up.

Quick context on where we are right now: we're building out the CRM side of picpeak on the `feat/crm` branch — admin-side quotes, invoices with a manual cancel-and-reissue flow, a payment-check email workflow (admin gets an email with three buttons after the due date: paid in full / partial / not paid), and a tax / Steuer report for exporting to your accountant. All payment is traditional invoice → bank transfer; there's no payment processor, no automated checkout, no fulfilment integration.

Your print-on-demand idea is **out of scope for this iteration** — it's a different shape of feature (customer-facing storefront + fulfilment provider integration + variable-quality serving) than what we're shipping now. That said, I'd like to understand what you'd actually want, so when someone (you, me, anyone) picks it up it isn't designed in a vacuum.

A few specific things that would help:

1. **Print partner** — do you have a specific service in mind (WHCC for the US, Saal Digital / CEWE / Whitewall / Pictrs for Europe, something else)? Different providers have very different integration shapes: REST API, manual order export, or a white-label iframe storefront.
2. **Workflow trust level** — would a **manual admin workflow** be acceptable for a v1? E.g. the customer places the order in the gallery, the admin gets an email with the order details, the admin manually forwards it to the print service. Or do you specifically need an automated handoff (order pushed to the print provider via API, status syncs back to the gallery)?
3. **Payment** — would payment via **invoice** (admin sends the invoice through the existing CRM flow once the order is placed) work, or do you need in-gallery checkout (cards / PayPal / Twint / SEPA)?
4. **Image-quality tiers** — how would you want the boundary drawn? Resolution-based (1080p preview free, full-res paid), watermarked vs un-watermarked, or per-photo curator-set (admin marks specific photos as premium)?
5. **Customer journey** — could you walk through your ideal end-to-end flow from the customer's point of view? Even a rough numbered list helps a lot.

No pressure to fully scope it — partial answers move things forward. If you want to sketch the workflow as a markdown doc and PR it into `docs/` that's a great first step too.
