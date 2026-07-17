# peter-widgets

Custom widgets for my Notion dashboard.

- `/tube/` — live TfL status
- `/fitness/` — responsive weekly health and fitness overview

The fitness widget ships with clearly labelled preview data. Its optional live sync reads only exercise fields from the Gym Sessions and Daily Health data sources, creates a weekly aggregate, and encrypts it with AES-256-GCM before committing it to this public repository. Body weight, sleep, mood, energy, notes, and the Measurements database are never included.

## Secure fitness sync

The scheduled workflow requires two repository Actions secrets:

- `NOTION_TOKEN` — a read-only Notion internal integration token with access only to the Health Dashboard page.
- `FITNESS_DASHBOARD_KEY` — a random 32-byte key encoded as base64url.

After adding both secrets, run **Actions → Sync encrypted fitness dashboard → Run workflow** once. Embed this URL in the private Notion page, replacing the placeholder with the same dashboard key:

`https://chompet.github.io/peter-widgets/fitness/#key=YOUR_BASE64URL_KEY`

The URL fragment is not sent to GitHub. The browser uses it locally to decrypt `fitness/data.enc.json`. Anyone who can see the complete embed URL can decrypt the aggregate, so keep the Notion page private and rotate the key if it is exposed.
