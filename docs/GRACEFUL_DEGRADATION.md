# Graceful degradation

When something PicPeak depends on has a problem, only the features that need it pause. Guests keep viewing and downloading wherever possible, and security checks are never weakened.

Find it under **Settings → Health**. A banner appears across the admin area while a feature is actually paused.

## What is checked

Every 15 seconds PicPeak checks:

| Dependency | What it checks |
| --- | --- |
| Database | A simple query answers in time |
| Storage | The storage location or S3 bucket answers, and a local location can be written to |
| Disk space | Free space under `STORAGE_PATH`, relative to its size. On S3 this is the local disk used for staging |
| Email sending | The mail queue's last pass, and whether the mail server or webhook is currently unreachable |
| Face recognition service | Only while the feature is on |
| Photo processing queue | The oldest photo has not waited more than 30 minutes |
| Server load | CPU, memory and event loop delay of the container |

Each dependency is **healthy**, **degraded** or **down**. One failed check changes nothing. Two failures in a row mean degraded and four mean down. A check that succeeds but takes over 3 seconds needs four in a row to count as degraded, because a burst of uploads can slow one on a healthy disk. Coming back takes about two minutes of better readings, so a flapping network share does not reopen uploads every few seconds.

The public `/health` endpoint does not use these states, on purpose: Docker restarting the app cannot repair a share or a mail server.

## What pauses

| Situation | New uploads | Running uploads | Viewing, single downloads | New ZIP builds | Finished ZIPs |
| --- | --- | --- | --- | --- | --- |
| Storage slow or failing at times | Paused | Finish | On | On | On |
| Disk nearly full | Paused | Finish if space allows | On | Paused | On |
| Storage down | Paused | Fail, and the file can be uploaded again | Unavailable until it returns | Paused | Unavailable until it returns |
| Critical memory | On | Finish | On | Paused | On |

"Disk nearly full" means less than 10% free, or less than 20 GB on large disks. Below 3% or 5 GB it counts as down.

"New uploads" covers gallery, admin, API and transfer uploads, external folder imports and watched folders, and the S3 auto-importer. A watched folder catches up after the pause; an initial import skipped during a pause needs **Rescan**. "New ZIP builds" covers gallery and transfer downloads, the API, and background rebuilds of a gallery's cached ZIP. A ZIP that is finished or already building stays available. Admin exports and scheduled archiving are not paused.

Visitors see a short message that the feature is paused for a moment, and the admin uploader waits about four minutes for the pause to end, then stops the rest of the batch. A plain download link shows a short paused page. The refused request answers `503` with `code: CAPABILITY_UNAVAILABLE` and `Retry-After`, and does not name the dependency. A direct **Download all** link that needs a new build fails as a browser download.

This mail handling is always on, in observe mode too. While the mail server or webhook is unreachable, email waits and retries every 5 minutes without using up its attempts, and **Email sending** shows as degraded. After 3 days of continuous outage it goes back to the normal limit of three attempts, so it shows up under failed emails. A restart starts that count again. A temporary answer about one recipient, such as greylisting, uses an attempt and waits 5 minutes. A failure after the server may have received the message uses an attempt straight away, so it is not sent repeatedly. A delayed email can go out outside business hours.

## Observe mode and enforcement

A new installation **observes**. PicPeak works out what it would pause and shows it as **Would pause**, and logs `Would pause ...` when a request would have been refused, but pauses nothing. Background work keeps its full speed. Tick **Pause features automatically** once those logs look right for your setup.

An admin can also pause **New uploads** or **ZIP downloads** by hand, in either mode, for example before maintenance on a share. **Check again now** runs the checks immediately, and a dependency that answers well recovers at once on the server that handled the click.

Changing these settings, and checking again, needs the `system.manage` permission and is written to the activity log.

## Slowing background work

Previews, face recognition, tagging and video work slow down when the server is busy, so galleries stay fast. In observe mode the status page only says this would happen.

- **Slow background work above** (default 70% CPU): when the average of two readings, 15 seconds apart, is above this, or the event loop stays delayed, work steps down one level.
- **Speed up again below** (default 50% CPU): when that average is below this and the event loop is calm, it steps back up one level. Each step needs two new readings.

| Level | Photo workers | Bulk work (faces, tags, video, rendition refresh, regeneration) |
| --- | --- | --- |
| Normal | All | Full speed |
| Reduced | Half | Short pause between items |
| Minimum | One | Longer pause between items |
| Paused (critical memory only) | None | Long pause between items |

High CPU alone never stops photo processing, because on a small server previews are often the load itself. Previews a guest is waiting for are not slowed, and they go ahead of queued background work. Admin regeneration pauses at most 2 seconds per photo.

`UPLOAD_PROCESSOR_CONCURRENCY` stays the upper limit. The governor can lower the number of workers and never raises it.

CPU and memory come from the container's cgroup limits when there are any. Without a memory reading, such as on a Mac outside Docker, memory limits simply do not apply. `PICPEAK_CGROUP_ROOT` overrides where the cgroup files are read, for tests.

## What never degrades

These are not on the list of things that can pause, and nothing in this feature can skip them:

- Login, permissions, CSRF and rate limits
- Gallery passwords, expiry and revoked access
- Invoices, contracts and signing
- Document scanning: a file nobody could scan stays unavailable
- Watermarks: a missing preview either fails or goes through the normal watermark checks, and is never replaced by an unprotected file

If one of these cannot do its job, the request is refused. There is no "force on" for a paused feature.

## Several replicas

Each process keeps its own view and its own load level. Replicas check the same dependencies, so they agree within a few checks, and a load level reflects the replica that measured it. After **Check again now**, other replicas recover on their own within about two minutes.
