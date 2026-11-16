# Storage setup: Cloudflare (Pages now, R2 later) and Supabase Storage

A step-by-step guide for the account owner. It covers the two storage homes ReoNet uses:

| Data | Home now | Permanent home | Why |
|---|---|---|---|
| Curated media (this repo: map photos, social demo photos, profile preset SVGs; about 2.6 MB) | jsDelivr from this public GitHub repo (`@main`), with `fastly.jsdelivr.net` as the same-network fallback | **Cloudflare R2** behind `media.<domain>`, filled from this repo by a GitHub Action; **Cloudflare Pages** on this repo is the independent fallback until then | Free at every scale we planned (10 GB free, no egress fees), no jsDelivr 50 MB package limit or acceptable-use risk, removals under our control |
| User uploads (avatars, covers, post photos, message attachments, files) | Supabase Storage bucket `media` (public-read, avatars and covers only) | **Supabase Storage** in the production project (Canada, `ca-central-1`): private buckets, signed upload and download URLs | Same vendor, data-processing agreement and region as the database that already holds this data; signed uploads go straight to storage, past Vercel's 4.5 MB body limit |

Every key goes into an env file or a secret store (section 5). **Never paste a key, token or password into a chat, an issue, a commit or a screenshot.** If one leaks, revoke it first (section 7), then make a new one.

Placeholders: `<domain>` is the app's domain on Cloudflare DNS (for example `reonet.app` if that is the one you own), `<account-id>` is the Cloudflare account id, `<project-ref>` is the Supabase project reference, `<sha>` is a full commit SHA of this repo.

## 1. Before you start

- A password manager entry for each account, and two-factor authentication on GitHub, Cloudflare and Supabase.
- Admin rights on the GitHub repos `ReoJefton/reonet-media-storage` (secrets, environments, Actions) and on the Vercel project of the backend.
- The domain's registrar login, if the domain is not on Cloudflare DNS yet (section 3.1).
- About 30 minutes for section 2, 60 to 90 minutes for section 3 (DNS can take longer to propagate), 30 minutes for section 4.

## 2. Cloudflare account and Pages fallback (do this first)

Cloudflare Pages serves this repo's `main` from Cloudflare's network, independent of jsDelivr and GitHub's CDN. It is free (20,000 files per site, 25 MiB per file, 500 builds per month) and needs no keys in our repos.

### 2.1 Create the account

1. Sign up at https://dash.cloudflare.com/sign-up with the team's shared admin e-mail (not a personal one).
2. Turn on two-factor authentication: **My Profile > Authentication > Two-Factor Authentication** (an authenticator app or a security key). Save the recovery codes in the password manager.
3. Note the **Account ID**: it is shown on the account home page (right column) and in the URL `dash.cloudflare.com/<account-id>/...`. It is an identifier, not a secret.
4. Never create or use the **Global API Key**. Every key in this guide is a scoped token.

### 2.2 Create the Pages project on this repo

1. **Workers & Pages > Create > Pages > Connect to Git.**
2. Choose GitHub and install the Cloudflare Pages GitHub app with **Only select repositories: `ReoJefton/reonet-media-storage`**. Do not grant it all repositories.
3. Select the repo and set:
   - Project name: `reonet-media` (gives `https://reonet-media.pages.dev`; if the name is taken, pick another and use it everywhere below).
   - Production branch: `main`.
   - Framework preset: **None**. Build command: empty. Build output directory: empty (the repository root; if the form requires a value, enter `/`).
4. **Save and Deploy.** The first deployment uploads the tree (about 2.6 MB) in a minute or two.
5. **Settings > Builds & deployments > Branch control:** Production branch `main`, automatic deployments on; **Preview branches: None**. Only reviewed `main` is ever published.
6. Leave **Settings > Access policy** off: the files are public by design.

### 2.3 Response headers for Pages

Pages reads a `_headers` file at the repo root. The media-cdn lane (item MC-01) adds it; if it is not in the repo yet when you create the project, the defaults still work for images. Its content:

```text
/*
  Access-Control-Allow-Origin: *
  Cross-Origin-Resource-Policy: cross-origin
  X-Content-Type-Options: nosniff
  Cache-Control: public, max-age=86400

/*.svg
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
```

### 2.4 Check Pages

```bash
curl -sI https://reonet-media.pages.dev/maps/central-park-0-9e885c394b53.jpg | grep -iE '^(HTTP|content-type|content-length|cache-control)'
curl -sI https://reonet-media.pages.dev/profile-presets/avatars/avatar_star_amber.svg | grep -iE '^(HTTP|content-type)'
curl -sI https://reonet-media.pages.dev/news/does-not-exist.jpg | head -1      # 404
```

Expect `HTTP/2 200`, `content-type: image/jpeg` and `image/svg+xml`, and the byte size of the file in git (`git ls-tree -l main <path>`). Then tell the coordinator the Pages host name, so the media-cdn lane adds it as the third host (section 6).

## 3. Cloudflare R2: permanent storage for curated media

R2 holds the curated files under versioned keys `<sha>/<path>`: every published commit of this repo gets its own immutable prefix, so a changed file gets a new URL and nothing ever needs a cache purge. This repo stays the reviewed source of truth; a GitHub Action copies each push to `main` into the bucket after `scripts/check-media.mjs` passes.

### 3.1 Put the domain on Cloudflare DNS

R2 custom domains need the domain (the zone) on Cloudflare.

1. **Account home > Add a domain** > enter `<domain>` > **Free** plan.
2. Cloudflare imports the existing DNS records. Compare them with the records at your current DNS provider (web app, API, e-mail MX, SPF, DKIM, DMARC, verification TXT records) and add any that are missing **before** switching nameservers. Keep the app's existing records exactly as they are; in particular keep records that point at Vercel as **DNS only** (grey cloud) unless the coordinator says otherwise.
3. At the registrar, replace the nameservers with the two Cloudflare gives you. Wait until the zone shows **Active** (minutes to 24 hours).
4. **SSL/TLS > Overview:** mode **Full (strict)**. **SSL/TLS > Edge Certificates:** Always Use HTTPS on, Minimum TLS 1.2.

If you cannot move the whole domain yet, use a separate domain you own only for media (for example `reonet-media.com`) as the Cloudflare zone; the steps are the same with that host name.

### 3.2 Enable R2 and create the bucket

1. **R2 Object Storage > Overview:** enable R2. Cloudflare asks for a payment method even though our use stays inside the free tier (10 GB-month storage, 1 million Class A and 10 million Class B operations per month). Set a billing notification in **Manage Account > Billing > Billing notifications** (for example at $5).
2. **Create bucket:**
   - Name: `reonet-media`.
   - Location: **Automatic** with the location hint **Eastern North America (ENAM)**. (R2 has no Canadian residency option; only public curated media goes here, never user data.)
   - Default storage class: **Standard**.
3. In the bucket's **Settings**:
   - **Public access > R2.dev subdomain:** leave **disabled**. The `r2.dev` URL is rate limited and not for production.
   - **Object lifecycle rules:** none. Old versions are kept on purpose (rows may pin an older `<sha>`); at 2.6 MB per version the free 10 GB holds thousands of versions.

### 3.3 Connect the custom domain

1. Bucket **Settings > Custom Domains > Connect Domain** > enter `media.<domain>` > **Continue** > **Connect domain**. Cloudflare creates the DNS record (proxied, orange cloud) and the certificate. Status goes from Initializing to **Active** in a few minutes.
2. Under **Minimum TLS version** for that custom domain choose **1.2**.
3. Do not add a second custom domain or enable public access any other way.

### 3.4 CORS policy on the bucket

Images in `<img>` tags need no CORS, but the web app also fetches some media with `fetch()` (blob previews, cache warmers), and the files are public anyway. Bucket **Settings > CORS policy > Add CORS policy**:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Type", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

If you prefer a closed list, replace `"*"` with the app's web origins (production, preview and `http://localhost:8081`) and give the coordinator the list; a missing origin then breaks those fetches on that origin only.

### 3.5 Cache and header rules for `media.<domain>`

In the `<domain>` zone:

1. **Caching > Cache Rules > Create rule**, name `media immutable`:
   - When: Hostname equals `media.<domain>`.
   - Then: **Eligible for cache**; Edge TTL **Use cache-control header if present, bypass cache if not**; Browser TTL **Respect origin**; Cache key: if your plan offers it, set the query string to **Ignore query string**, since every file is addressed by its path (otherwise leave the default).
2. **Caching > Tiered Cache:** turn on **Smart Tiered Caching** (free).
3. **Rules > Transform Rules > Modify Response Header > Create rule**, name `media headers`:
   - When: Hostname equals `media.<domain>`.
   - Set static: `X-Content-Type-Options` = `nosniff`; `Cross-Origin-Resource-Policy` = `cross-origin`.
4. A second response-header rule, name `media svg sandbox`:
   - When: Hostname equals `media.<domain>` **and** URI Path ends with `.svg`.
   - Set static: `Content-Security-Policy` = `default-src 'none'; style-src 'unsafe-inline'; sandbox`.
5. **Security > WAF > Rate limiting rules** (optional, Free plan allows one rule): Hostname equals `media.<domain>`, 600 requests per 10 seconds per IP, action Block for 10 seconds. It stops a single client from hammering the bucket; normal app use stays far below it.

The objects themselves carry `Cache-Control: public, max-age=31536000, immutable` (set by the sync job, section 3.7), so browsers and the edge keep them for a year.

### 3.6 API token limited to the bucket

1. **R2 Object Storage > Manage R2 API Tokens > Create API token** (an R2 token, not a general API token).
2. Name: `github-media-sync`.
3. Permissions: **Object Read & Write**.
4. Specify bucket(s): **Apply to specific buckets only > `reonet-media`**.
5. TTL: **Forever** is acceptable for a bucket-scoped CI token; if you prefer, set one year and put a renewal reminder in the calendar.
6. Client IP filtering: none (GitHub-hosted runners have changing IPs).
7. **Create.** The page shows the **Access Key ID**, the **Secret Access Key** and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com` **once**. Copy the two keys straight into GitHub (next step) and into the password manager; do not paste them anywhere else.

### 3.7 GitHub environment, secrets and the sync job

1. In `ReoJefton/reonet-media-storage`: **Settings > Environments > New environment** `r2`.
   - **Deployment branches and tags:** Selected branches > `main` only.
   - Optional: **Required reviewers** = you, if you want to approve each publish.
2. In environment `r2` add:
   - **Secrets:** `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (from 3.6).
   - **Variables:** `R2_ACCOUNT_ID` = `<account-id>`, `R2_BUCKET` = `reonet-media`, `MEDIA_PUBLIC_BASE` = `https://media.<domain>`.
3. **Settings > Actions > General:** Workflow permissions **Read repository contents**; **Fork pull request workflows**: do not send secrets (the default).
4. The coordinator (media-cdn lane, item MC-06) adds `.github/workflows/sync-r2.yml`. For reference, it does this and nothing more:

```yaml
name: sync-r2
on:
  push:
    branches: [main]          # never pull_request or pull_request_target: secrets stay on reviewed main
permissions:
  contents: read
concurrency:
  group: sync-r2
  cancel-in-progress: false
jobs:
  sync:
    runs-on: ubuntu-24.04
    environment: r2
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Check media (sizes, metadata, orientation, sRGB)
        run: node scripts/check-media.mjs
      - name: Copy this commit to R2 under <sha>/
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: auto
          AWS_REQUEST_CHECKSUM_CALCULATION: when_required
          AWS_RESPONSE_CHECKSUM_VALIDATION: when_required
        run: |
          aws s3 sync . "s3://${{ vars.R2_BUCKET }}/${GITHUB_SHA}/" \
            --endpoint-url "https://${{ vars.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com" \
            --exclude ".git/*" --exclude ".github/*" --exclude "docs/*" --exclude "scripts/*" --exclude "*.md" \
            --cache-control "public, max-age=31536000, immutable" \
            --no-progress
      - name: Check a file on the custom domain
        run: |
          curl -fsSI "${{ vars.MEDIA_PUBLIC_BASE }}/${GITHUB_SHA}/profile-presets/avatars/avatar_star_amber.svg" | grep -i '^content-type: image/svg+xml'
```

The AWS CLI is preinstalled on GitHub's Ubuntu runners, so the job installs nothing from third parties. The two `*_CHECKSUM_*` variables keep newer AWS CLI versions from sending checksum headers that S3-compatible stores may reject.

### 3.8 Check R2

After the first push to `main` with the job in place (or a manual **Run workflow** if the coordinator adds `workflow_dispatch`):

```bash
SHA=$(git rev-parse origin/main)
curl -sI "https://media.<domain>/$SHA/maps/central-park-0-9e885c394b53.jpg" | grep -iE '^(HTTP|content-type|cache-control|cf-cache-status)'
curl -sI "https://media.<domain>/$SHA/maps/central-park-0-9e885c394b53.jpg" | grep -i '^cf-cache-status'   # HIT on the second request
curl -sI "https://media.<domain>/$SHA/profile-presets/avatars/avatar_star_amber.svg" | grep -iE '^(content-type|content-security-policy)'
curl -sI "https://media.<domain>/" | head -1                    # 404: no listing
curl -sI "https://reonet-media.<account-id>.r2.dev/" | head -1  # fails: r2.dev stays disabled
```

Expect `200`, the right `content-type`, `cache-control: public, max-age=31536000, immutable`, `cf-cache-status: HIT` on repeat, and the SVG sandbox header. The coordinator then runs `cdn-check.mjs` against the R2 host for every file.

## 4. Supabase Storage: user uploads

### 4.1 Check the plan

1. https://supabase.com/dashboard > the organization that owns the production project > **Billing**.
2. The plan must be **Pro** or higher. The Free plan pauses idle projects, caps files at 50 MB and storage at 1 GB, and must not run production.
3. Pro includes 100 GB of storage and 250 GB each of cached and uncached egress per month, shared with the database.

### 4.2 Check the project region (Canada)

1. Open the production project > **Project Settings > General**. The **Region** field must read **Canada (Central), `ca-central-1`**.
2. Storage objects live in the project's region, so this one setting keeps uploads in Canada.
3. If the project is in another region: a region cannot be changed. Tell the coordinator before the 1.0 data reset; the fix is a new project in `ca-central-1` and a move of the database (the coordinator plans it; the old project is deleted afterwards). Do not create it on your own while a release is in progress.

### 4.3 Buckets

The backend release step creates the private buckets after its database backup; if you create them yourself, use exactly these settings (**Storage > New bucket**):

| Bucket | Public | File size limit | Allowed MIME types | Holds |
|---|---|---|---|---|
| `incoming` | **off** (private) | 8 MiB in 1.0 (25 MiB once the files worker runs) | `image/jpeg, image/png, image/webp, image/gif, image/heic, image/heif` | Raw uploads, short-lived; the backend sanitizes each one and deletes it |
| `media-private` | **off** (private) | 25 MiB | leave empty (the backend checks types itself) | Sanitized photos and attachments of posts, stories and messages |
| `media` (exists) | on (public-read) | leave as it is (the backend caps these uploads at 5 MB) | leave as it is | Avatars and profile covers until the profile rebuild moves them; whether they stay public is the open question 5 |

Then:

- **Storage > Policies:** add **no** policies for `anon` or `authenticated` on `incoming` and `media-private`. Only the backend's service role reads and writes them; clients only ever get signed URLs.
- **Project Settings > Storage** (or **Storage > Settings**): **Image Transformations off** (they cost $5 per 1,000 origin images over 100 a month; our own pipeline makes the variants). Global file size limit: 50 MiB.

### 4.4 Signed upload and download URLs (what the backend does)

No key reaches the app. The flow:

1. The app asks the backend for an upload slot. The backend checks the user, the size and the type, then calls `POST /storage/v1/object/upload/sign/incoming/<userId>/<uuid>` with the service-role key (`createSignedUploadUrl` in supabase-js) and returns the signed URL. It is valid for 2 hours and only for that one object path.
2. The app uploads the bytes straight to that URL (`PUT` with the token; TUS resumable uploads for files over 6 MB). Nothing passes through Vercel's 4.5 MB limit.
3. The app tells the backend the upload is done. The backend reads the object, sanitizes it (type from the magic bytes, limits, orientation, metadata strip), writes the result to `media-private/...` and deletes the `incoming/` object.
4. For each view the backend runs its access checks (visibility, blocks, organization membership) and returns a signed download URL from `POST /storage/v1/object/sign/media-private/<path>` (`createSignedUrl`) with `expiresIn: 300`. Objects in `media-private` are written with a cache time of at most 300 seconds.

For the web app, the browser talks to `https://<project-ref>.supabase.co` directly in step 2, so that origin must be in the web Content-Security-Policy `connect-src` (the coordinator adds it in `vercel.json` with the upload lane).

### 4.5 Spend cap and alerts

1. **Organization > Billing > Cost Control:** keep **Spend Cap** **on**. With the cap on, the project is limited instead of billed when it passes the Pro quotas; turn it off only after a deliberate decision about the monthly ceiling (open question 6).
2. **Organization > Usage:** check storage, egress (cached and uncached) and image transformations (must stay 0). Supabase e-mails the organization owners when usage approaches a quota; make sure the owner address is a monitored inbox.
3. Add a monthly calendar reminder to read **Usage** until real traffic patterns are known.

### 4.6 What the backend needs in its env

| Key | Where | Notes |
|---|---|---|
| `SUPABASE_URL` | backend `.env.production` (gitignored) and Vercel backend project > Settings > Environment Variables > Production | `https://<project-ref>.supabase.co` (Project Settings > API) |
| `SUPABASE_SERVICE_ROLE_KEY` | same two places, **Sensitive** in Vercel | Project Settings > API > `service_role` (or a new secret key). Server only; never in the app, never in an `EXPO_PUBLIC_*` variable |
| `SUPABASE_MEDIA_BUCKET` | same two places | `media` (the default) |
| bucket names for `incoming` and `media-private` | same two places | added by the upload lane through `scripts/env-files.js`; the lane names the keys and the coordinator tells you |

The app (frontend) needs no Supabase key at all.

## 5. Where every key goes

| Key or value | Secret? | Goes into | Never into |
|---|---|---|---|
| Cloudflare account password, 2FA recovery codes | yes | password manager | anywhere else |
| Cloudflare Account ID | no (identifier) | GitHub environment `r2` variable `R2_ACCOUNT_ID` | |
| R2 Access Key ID, R2 Secret Access Key | yes | GitHub environment `r2` secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; password manager | chat, repos, `.env` files of the app, Vercel |
| Cloudflare zone cache-purge token (only once public upload variants live on R2) | yes | backend `.env.production` and Vercel backend Production env | the app |
| Supabase service-role key | yes | backend `.env.production` and Vercel backend Production env (Sensitive) | the app, `EXPO_PUBLIC_*`, GitHub of the app repos, chat |
| Supabase project URL | no | backend env (same places) | |
| Media host names (`media.<domain>`, `reonet-media.pages.dev`) | no | given to the coordinator; they land in config and the CSP | |

Rules: env files are created and named through `scripts/env-files.js` in each repo (`npm run env:format`), and they are gitignored. Vercel and GitHub store the deployed values. If a key appears anywhere else, treat it as leaked (section 7).

## 6. How the app switches hosts

**Today (release 1.0):**

- The backend builds new curated-media URLs from `MEDIA_CDN_BASE_URL` (`src/utils/media-cdn.ts`; default `https://cdn.jsdelivr.net/gh/ReoJefton/reonet-media-storage@main`). Seeds store absolute URLs (map place photos, preset avatars, covers, course thumbnails, community covers, website documents).
- The app's preset picker builds its URLs from `PROFILE_PRESET_CDN_BASE` (`constants/profilePresets.ts`).
- So a host switch today means: set `MEDIA_CDN_BASE_URL` (for R2: `https://media.<domain>/<sha>`), change the app constant, add the host to the web CSP `connect-src`, then reseed `reonet_dev` (`demo:seed`) so the stored URLs follow. Production rows that already hold jsDelivr URLs keep them until the next allowed production reset, and jsDelivr keeps serving them while this repo is public.

**After the media-cdn lane (items MC-02 to MC-06):**

- Rows store `media://curated/<path>` references instead of URLs; the shared resolver in `@reoorg/types` turns a reference into an ordered list of https candidates from a host list.
- Config, per deployment: backend `MEDIA_HOSTS` and `MEDIA_CURATED_REF` (they replace `MEDIA_CDN_BASE_URL`), app `EXPO_PUBLIC_MEDIA_HOSTS` and `EXPO_PUBLIC_MEDIA_CURATED_REF`. Each host is a template with `{ref}` and `{path}`.
- Host order until R2 exists: `https://cdn.jsdelivr.net/gh/ReoJefton/reonet-media-storage@{ref}/{path}`, then `https://fastly.jsdelivr.net/gh/ReoJefton/reonet-media-storage@{ref}/{path}`, then `https://reonet-media.pages.dev/{path}` (once section 2 is done). After R2: `https://media.<domain>/{ref}/{path}` first, the jsDelivr hosts after it.
- The app's `Image` and `Avatar` try each candidate once on error, then show their fallback. Moving to R2 (or away from it) is a change of the host list; no row changes.

## 7. Rollback and incidents

| Situation | What to do |
|---|---|
| Pages misbehaves | Remove its host from the host list (or never add it); the project can stay or be deleted (**Workers & Pages > reonet-media > Settings > Delete**). Nothing else depends on it. |
| R2 or `media.<domain>` misbehaves | Put the jsDelivr hosts first again in the host list (or set `MEDIA_CDN_BASE_URL` back to the jsDelivr base and reseed, before the media-cdn lane). This repo stays the source, so nothing is lost. Disable the `sync-r2` workflow (**Actions > sync-r2 > Disable workflow**) while you investigate. |
| A bad file was published to R2 | Fix it in this repo (it publishes under a new `<sha>/`), move `MEDIA_CURATED_REF` to the new SHA; delete the bad object under the old prefix with the dashboard (**R2 > reonet-media > Objects**) if it must disappear. |
| R2 key leaked | **R2 > Manage R2 API Tokens > Revoke** the token at once, create a new one (3.6), replace the two GitHub secrets, re-run the workflow. Check **R2 > reonet-media > Metrics** for unexpected writes. |
| Supabase service-role key leaked | Rotate it in **Project Settings > API** (or roll the JWT secret / secret keys as Supabase documents), update the backend env in both places, redeploy the backend. Review **Storage** and **Logs** for unexpected access. |
| Supabase costs climb | Spend cap stays on; read **Usage**; serve public variants with long caching; if the private share of egress is small, move public variants to R2 (a copy plus a host change). |
| Domain moved to Cloudflare broke something | Compare the DNS records with the old provider's export and fix the record; as a last resort, switch the nameservers back at the registrar (the R2 custom domain stops working until they return). |

## 8. Costs

All USD per month, list prices checked 2026-11-15 (sources: the program's storage research `STORAGE-OPTIONS.md` and the image-pipeline plan, section 2.2). Supabase Pro's $25 base is not counted: the database needs it already.

| Item | Demo / early access | 10k monthly users | 100k monthly users |
|---|---|---|---|
| Curated media on R2 (about 2.6 MB per version; tiny egress) | $0 | $0 | $0 |
| Cloudflare Pages fallback | $0 | $0 | $0 |
| Cloudflare zone (Free plan), cache and transform rules | $0 | $0 | $0 |
| User uploads on Supabase, 0 % private egress | $0 | about $20 | about $349 |
| same, 50 % private | $0 | about $33 | about $619 |
| same, 80 % private | $0 | about $51 | about $781 |
| same, 100 % private (release 1.0: Social is signed-in only, Messages is private) | $0 | about $68 | about $897 |
| For comparison: everything on R2 | $0 | about $1.35 | about $24-35 |
| For comparison: AWS S3 + CloudFront flat-rate | $0 | $15 | about $215 |

Assumptions: 5 GB / 50 GB egress (demo), 100 GB / 1 TB (10k users), 1 TB / 10 TB (100k users); variants made once by our own pipeline; public views hit the CDN 90 % of the time; Supabase Image Transformations off (on, they would add about $500 a month at 10k users). R2 free tier: 10 GB-month storage, 1 million Class A and 10 million Class B operations; beyond that $0.015 per GB-month, $4.50 per million Class A, $0.36 per million Class B, egress always free.

When the Supabase line passes the monthly ceiling you set (at $50: about 21k users at 0 % private, 12.5k at 50 %, 10k at 80 %), the coordinator compares moving public variants to R2 with CloudFront signed delivery.

## 9. Checklist

- [ ] Cloudflare account with 2FA; Account ID noted.
- [ ] Pages project `reonet-media` on this repo, `main` only, previews off; section 2.4 checks pass; host name sent to the coordinator.
- [ ] `<domain>` active on Cloudflare DNS, all records checked, SSL Full (strict).
- [ ] R2 enabled, bucket `reonet-media` (ENAM hint), r2.dev disabled, billing notification set.
- [ ] Custom domain `media.<domain>` active; CORS policy; cache rule, tiered cache, header rules.
- [ ] R2 token `github-media-sync` (Object Read & Write, `reonet-media` only) stored only as GitHub environment `r2` secrets.
- [ ] Environment `r2` limited to `main`; variables `R2_ACCOUNT_ID`, `R2_BUCKET`, `MEDIA_PUBLIC_BASE` set; coordinator told.
- [ ] Supabase: Pro plan; region `ca-central-1` confirmed (or the coordinator told it is not).
- [ ] Buckets `incoming` and `media-private` private with the limits above (or left to the backend release step); no client policies; Image Transformations off.
- [ ] Spend cap on; owner e-mail monitored; monthly usage reminder.
- [ ] Backend env keys in `.env.production` and Vercel Production env only.
