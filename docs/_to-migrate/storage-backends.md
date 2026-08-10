# Storage Backends

PicPeak supports two storage backends for photos, thumbnails, hero images, watermarks, and archive zips. Both are configured via environment variables; no code change is required to switch.

| Capability | `STORAGE_BACKEND=local` (default) | `STORAGE_BACKEND=s3` |
|---|---|---|
| Photo / thumbnail / hero storage | Local filesystem under `STORAGE_PATH` | Bucket on any S3-compatible service |
| Admin UI upload | ✅ | ✅ |
| Filesystem auto-import (chokidar watcher) | ✅ | ❌ — disabled (use the upload API) |
| Watermarks, fingerprinting, fragmentation | ✅ | ✅ (materialized to a tmp file just-in-time) |
| Bulk download zips (cached + on-the-fly) | ✅ | ✅ |
| Backups | ✅ | ✅ |
| External media reference mode (`EXTERNAL_MEDIA_ROOT`) | ✅ (always local) | ✅ (still local — not migrated) |

## Switching to an S3-compatible backend

1. Provision a bucket and credentials. The minimum IAM policy is documented in `.env.example`.
2. Set `STORAGE_BACKEND=s3` plus `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY`, `STORAGE_S3_SECRET_KEY`. For non-AWS providers (MinIO, R2, B2, …) also set `STORAGE_S3_ENDPOINT`.
3. If you have existing local content, copy it first: `node backend/scripts/migrate-storage.js --dry-run` then `node backend/scripts/migrate-storage.js`. The script is idempotent and writes a failures CSV.
4. Restart the backend. The startup check pings the bucket and refuses to boot on misconfig.

Note: presigned-URL serving (zero-bandwidth direct downloads from S3) is intentionally **not** in v1 — every request still streams through the backend so watermarks, devtools-detection, and access logging keep working.
