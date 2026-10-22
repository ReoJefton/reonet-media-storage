# ReoNet Media Storage

Source of truth for ReoNet scraped/curated media assets (images, posters, artwork, map photos).
The backend (`reotech-expressjs`) neither stores nor serves media itself: `/media-files/<category>/<file>`
redirects here through a CDN (see `docs/MEDIA_STORAGE_CDN.md` in the backend repo).

Public CDN URL (jsDelivr, GitHub-backed):

    https://cdn.jsdelivr.net/gh/ReoJefton/reonet-media-storage@main/<category>/<file>

Rules:
- Keep every file under 20 MB (jsDelivr will not serve larger GitHub files).
- User-generated content (profile photos, cover images, attachments) never goes here; it needs per-user object storage.
- Backend scrapers write here locally (sibling folder or `REONET_MEDIA_STORAGE_DIR`); commit and push to publish.

## Directory Structure
- `news/` - News article thumbnails, covers, and publisher icons
- `radio/` - Radio station logos, stream banners, and stream audio backups
- `podcasts/` - Podcast cover art, episode banners, and episode clips
- `music/` - Album artwork, artist photos, and preview tracks
- `movies/` - Movie posters, backdrop images, and trailers
- `tv/` - TV show posters, season art, and episode stills
- `games/` - Game box art, screenshots, and trailers
- `maps/` - Map place photos, cover images, and satellite snapshots
- `covers/` - Generic genre/category cover images
