# Webhooks

PicPeak POSTs event/photo lifecycle notifications to URLs you configure under **Settings → Webhooks**. Each delivery is signed `HMAC-SHA256` with a per-webhook secret in the `X-PicPeak-Signature` header so receivers can verify the request really came from your PicPeak instance.

## Event types

| Event | Fires when |
|---|---|
| `event.created` | Gallery created (admin or API) |
| `event.published` | Draft becomes live (`is_draft: true → false`) — also fires when an event is created with `is_draft=false` |
| `event.archived` | Bulk-archive, manual archive, or auto-archive on expiry |
| `event.expired` | Expiration checker marks the gallery inactive (fires before `event.archived` in the cascade) |
| `photo.uploaded` | Admin upload, API upload, guest upload, or auto-import |
| `photo.deleted` | Single delete, bulk delete (NOT fired per-photo when an event is archived — receivers infer from `event.archived` to avoid flooding) |

## Payload shape

```json
{
  "id": "delivery-uuid",
  "type": "event.published",
  "created_at": "2026-04-28T05:25:00.000Z",
  "data": {
    "event": { "id": 123, "slug": "wedding-smith", "share_url": "https://..." }
  }
}
```

Also sent on every request:
- `X-PicPeak-Signature` — `HMAC-SHA256(secret, raw_body)` as hex
- `X-PicPeak-Event` — the event type (handy for routing without parsing the body)
- `X-PicPeak-Delivery` — UUID for idempotency on the receiver side
- `User-Agent: PicPeak-Webhooks/1.0`

## Verifying signatures

**Node.js**
```js
const crypto = require('crypto');
function verify(secret, rawBody, signature) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

**Python**
```python
import hmac, hashlib
def verify(secret: str, raw_body: bytes, signature: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

**curl + openssl** (one-liner for a quick replay)
```sh
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
[ "$SIG" = "$RECEIVED_SIG" ] && echo OK || echo MISMATCH
```

## Retries + observability

- `2xx` → success, recorded with latency
- Non-`2xx` or network error → exponential backoff: `1m → 5m → 30m → 2h → 12h`, max 5 attempts
- After max attempts: status `failed`, surfaces in **Settings → Webhooks → Deliveries** with a "Replay" button
- Up to 5 deliveries in flight at once; one slow consumer can't block others (configurable via `WEBHOOK_DELIVERY_CONCURRENCY`)
- Response body truncated to 1KB before storage so chatty receivers don't bloat the audit log

The deliveries page (`/admin/webhooks/:id/deliveries`) shows every attempt with timestamp, status, HTTP code, latency, payload sent, signature, and response. Click "Send test event" to fire a synthetic delivery for any event type.

## SSRF protection

Webhook URLs are validated against the same private-IP blocklist used elsewhere in the app — loopback, private RFC1918 ranges, link-local, `.local`/`.internal` hostnames, cloud metadata endpoints. The check runs both at create time and per-delivery (DNS-rebinding mitigation).

For local development with a receiver on the same machine or docker network, set `WEBHOOK_ALLOW_PRIVATE_URLS=true`. Production deployments must leave this OFF.
