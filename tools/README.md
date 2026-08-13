# CV tooling

## Regenerating the PDFs

The two download files at the repo root — `Michele-Panarotto-CV-EN.pdf` and
`Michele-Panarotto-CV-IT.pdf` — are generated from `index.html` itself, so they
always match the live page with the print CSS applied.

```bash
cd tools
npm install        # installs playwright-core
npm run pdf        # regenerates both PDFs at the repo root
```

The generator (`generate-pdfs.mjs`) serves the site locally, renders it in
headless Chromium, switches language, emulates print media, and writes each
PDF. React/ReactDOM/Babel and the Barlow fonts are fetched once and served to
the browser via request interception, so the run is self-contained.

**Re-run this whenever you edit the CV content** — the committed PDFs do not
update themselves.

### Requirements

- Node 18+ and a Chromium that Playwright can find. If you already have
  Playwright browsers installed, they're auto-detected via
  `PLAYWRIGHT_BROWSERS_PATH`; otherwise set `CHROME_PATH=/path/to/chrome`.

## Testing the print / PDF rendering

- **On screen:** open `index.html`, pick a language, and use the browser's
  Print preview (Ctrl/Cmd-P). Only the active language should appear; the
  language toggle and both buttons are hidden; it should fit on 2 A4 pages.
- **The download button** (`Scarica PDF` / `Download PDF`) points to the
  pre-generated file for the active language.
