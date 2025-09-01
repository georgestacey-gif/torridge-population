# Torridge population (ONS) – GitHub Pages widget

This repo serves a static page that displays the latest population for **Torridge (GSS: E07000046)**.

## How it works

- A GitHub Actions workflow (`.github/workflows/update-data.yml`) runs on a schedule (or manually).
- It executes `scripts/fetch.mjs`, which calls the **ONS Beta API** to find the latest Population Estimates dataset, selects **All persons, All ages**, and **Torridge**.
- The script writes `data/data.json` (same-origin), avoiding CORS.
- `index.html` fetches `data/data.json` and renders the number.

## Setup (quick)

1. Create repository and push these files.
2. In **Settings → Pages**, publish from **Branch: `main` / Root**.
3. Manually run **Actions → Update ONS Torridge population → Run workflow** to generate the first `data/data.json`.
4. Embed the site URL in SharePoint using the **Embed** web part.

## Notes

- Schedule is weekly (Mon 06:00 UTC). Adjust in the workflow as needed.
- No external secrets or premium connectors required.
