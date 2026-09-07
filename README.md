# Annulus Poster Site

Static GitHub Pages site with a four-button menu opening Chat, Contingent Knowledge Eval, Handlabeled Viewer, and Data Viewer SFT. The eval model selector generates downloadable PNG comparisons in the browser. Chat uses the public API endpoint in `site.json`; the data views work independently of the inference server. `data.html` redirects to the SFT viewer so existing links and QR codes still work.

Run `python3 scripts/export_data.py --source ../mwdf` to refresh the public snapshots. The exporter validates the original comparison, aggregates all configured eval models on the same question bank, samples 100 synthetic conversations deterministically, and copies the hand-label data and full-corpus normalization statistics. `src/viewer` reuses the source viewer's calculations; only its corpus URL and presentation are adapted for the public snapshot. No private chat conversations are exported.

Local preview: `python3 -m http.server 8770 --bind 127.0.0.1`, then open `http://127.0.0.1:8770/`.

Checks: `python3 -m unittest discover -s scripts -p 'test_*.py'`; with Playwright installed and the preview running, `node scripts/test_site.cjs`. The browser checks mock inference and write screenshots to `/tmp/poster-chat-screenshots`. Optional environment variables: `SITE_URL`, `CHROMIUM_PATH`, `SCREENSHOTS`.
