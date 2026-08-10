# First run — create your admin account

On first start with no `ADMIN_PASSWORD` set, PicPeak has **no admin account yet** and greets you with an in-browser setup screen — no credentials in `.env`:

1. Open **http://localhost:3000/admin** — you'll be redirected to `/setup`.
2. Read the **one-time setup token** from the 0600 file the backend writes it to
   (it is deliberately *not* printed to the logs — that would leave a live
   bootstrap credential in `docker logs`):
   ```bash
   docker compose exec backend cat /app/data/SETUP_TOKEN
   ```
   It is bind-mounted, so `sudo cat data/SETUP_TOKEN` on the host works too. Only
   if that file could not be written does the backend fall back to logging the
   token (`docker compose logs backend | grep -i "setup token"`).
3. Paste the token, set your admin **email + password**, and you're in. The token is single-use, and the setup screen closes permanently once an admin exists.

> Prefer the old behaviour? Set `ADMIN_PASSWORD` in `.env` and PicPeak auto-creates the admin on first boot instead (credentials written to `data/ADMIN_CREDENTIALS.txt`).

## Docker file permissions

- The backend container starts as root, chowns bind-mounted host directories (`./storage`, `./data`, `./logs`) to UID 1001 (`nodejs`), then drops privileges via `su-exec` before running the app. No host-side setup needed for fresh installs.
- If you pin `user:` in a compose override (e.g. to map a specific host UID), the self-chown is skipped and you must pre-chown the host directories to that UID — see [docs.picpeak.app/deployment/docker#permissions](https://docs.picpeak.app/deployment/docker#permissions).

## ARM64 (aarch64) systems

Pre-built images include native `linux/arm64`, no platform flags or emulation needed. If you're on an older image tag that's still amd64-only, see [docker-compose.amd64.override.yml](../../docker-compose.amd64.override.yml) for a transitional fallback.
