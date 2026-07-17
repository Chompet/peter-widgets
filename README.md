# peter-widgets

Custom widgets for my Notion dashboard.

- `/tube/` — live TfL status
- `/fitness/` — responsive weekly health and fitness overview
- `/urbanus/` — encrypted Urbanus Fabulae album-production dashboard
- `/jobs/` — encrypted job-search command centre

The fitness widget ships with clearly labelled preview data. Its optional live sync reads only exercise fields from the Gym Sessions and Daily Health data sources, creates a weekly aggregate, and encrypts it with AES-256-GCM before committing it to this public repository. Body weight, sleep, mood, energy, notes, and the Measurements database are never included.

## Secure fitness sync

The scheduled workflow requires two repository Actions secrets:

- `NOTION_TOKEN` — a read-only Notion internal integration token shared directly with only the Gym Sessions and Daily Health databases. Do not share the parent Health Dashboard page.
- `FITNESS_DASHBOARD_KEY` — a random 32-byte key encoded as base64url.

After adding both secrets, run **Actions → Sync encrypted fitness dashboard → Run workflow** once. Embed this URL in the private Notion page, replacing the placeholder with the same dashboard key:

`https://chompet.github.io/peter-widgets/fitness/#key=YOUR_BASE64URL_KEY`

The URL fragment is not sent to GitHub and the key is never stored in browser storage. The browser uses the fragment locally to decrypt `fitness/data.enc.json`. Anyone who can see the complete embed URL can decrypt the aggregate, so keep the Notion page private and rotate the key if it is exposed.

The Urbanus dashboard uses a separate read-only Notion connection shared only with the Songs Database, plus separate `URBANUS_NOTION_TOKEN` and `URBANUS_DASHBOARD_KEY` Actions secrets. Its public output is encrypted and excludes notes, mix-file locations, folder links, and song content.

The job-search dashboard uses a separate read-only Notion connection shared only with Job Applications and Potential Jobs, plus separate `JOBS_NOTION_TOKEN` and `JOBS_DASHBOARD_KEY` Actions secrets. It exports only dashboard fields such as role/company labels, broad location, status, dates, salary, CV version and Fit Score. Notes, Fit Rationale, recruiter/contact relations, email links, job links, Notion page URLs, exact addresses and email subjects are excluded. Embed `https://chompet.github.io/peter-widgets/jobs/#key=YOUR_BASE64URL_KEY` only on a private Notion page.
