# System Requirements

## Minimum Requirements
- **CPU**: 2 CPU cores
- **RAM**: **4 GB minimum** for a normal photo-upload workload — sharp/libvips
  decodes the full uncompressed frame before resize, and the default two
  worker loops at sharp-concurrency 2 can push peak RSS past 1.5 GB on a
  batch of 20-MP+ photos. On a 2 GB VPS that's enough to OOM-kill the
  backend mid-batch (surfaces as 503s on thumbnails — see [Low-memory
  hosts](#low-memory-hosts) below for the recipe to run on 2 GB).
- **Storage**: 20GB minimum (plus photo storage needs)
- **OS**: Linux (Ubuntu 20.04+), macOS, or Windows with WSL2
- **Node.js**: v18.0.0 or higher
- **Database**: SQLite (included) or PostgreSQL 12+

## Docker Requirements (Recommended)
- **Docker**: v20.10.0+
- **Docker Compose**: v2.0.0+

## Low-memory hosts

Running on 2 GB RAM (e.g. an entry-level VPS) is workable but requires
tuning the upload-processor concurrency down. The backend auto-detects
total RAM at startup via `os.totalmem()` — on a host that reports < 3 GB,
it defaults `UPLOAD_PROCESSOR_CONCURRENCY` to **1** instead of 2 and logs
a one-shot warning. You can pin the value explicitly in `.env`:

```env
# Single worker loop — slower batch processing, lower peak RSS
UPLOAD_PROCESSOR_CONCURRENCY=1
```

The trade-off is throughput: a single worker processes one photo at a
time, so a 100-photo batch takes ~2× as long but won't OOM. **Health-check
note**: if the backend dies under memory pressure, the gallery serves
`503 Service Unavailable` on thumbnails until Docker's
`restart: unless-stopped` brings the container back. Persistent 503s
during/after an upload batch on a low-memory host are almost always this.

## Video Support Requirements
When enabling video uploads, consider these additional resources:

| Resource | Recommendation | Notes |
|----------|----------------|-------|
| **RAM** | 4GB+ recommended | FFmpeg processing requires more memory |
| **Storage** | Plan for 10-100x more | Videos are significantly larger than images |
| **CPU** | Additional cores help | Video thumbnail extraction is CPU-intensive |
| **Bandwidth** | Higher throughput | Video streaming requires more bandwidth |

**Technical Notes:**
- FFmpeg is bundled via npm (`@ffmpeg-installer/ffmpeg`) - no system installation required
- Maximum upload size: **10GB per video file**
- Chunked upload support for files >100MB (resumable uploads)
- Supported formats: MP4, WebM, MOV, AVI
- Video thumbnails are automatically generated from the first few seconds

**For Nginx/Reverse Proxy:**
If using Nginx, increase the client max body size:
```nginx
client_max_body_size 10G;
proxy_read_timeout 3600;
proxy_send_timeout 3600;
```
