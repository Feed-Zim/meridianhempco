# meridianhempco.com

Static site + CRM front end for Meridian Hemp Co. Built from source on every
push to `main` by GitHub Actions and deployed to GitHub Pages (no built files
are committed).

## Layout

- `src/pages/` — per-route HTML fragments (wrapped with `src/partials/`)
- `src/partials/` — shared head/header/footer
- `src/assets/`, `src/styles/` — copied verbatim into the build
- `page-meta.json` — per-route titles/meta/robots; drives the build
- `scripts/build.mjs` — assembler; emits `dist/` (pages, sitemap.xml,
  robots.txt, 404.html, CNAME)
- `supabase/migrations/` — backend schema/RLS/seed/views (see
  `supabase/config-notes.md` for the setup runbook)
- `.github/workflows/deploy.yml` — build + Pages deploy

## Local build

```
node scripts/build.mjs   # or: npm run build
npx http-server dist -c-1
```

## Notes

- `src/assets/js/supabase-config.js` ships only the public anon key
  (placeholders until Phase 0 runs); row-level security is the security model.
- No secrets belong anywhere in this repo.
