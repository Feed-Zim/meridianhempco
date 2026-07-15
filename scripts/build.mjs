#!/usr/bin/env node
/**
 * build.mjs — minimal static assembler for meridianhempco.com
 *
 * Wraps each page fragment (src/pages/<route>.html) with the shared partials
 * (head/header/footer), injects per-route meta from page-meta.json, sets the
 * active-nav flag, and emits folder-style pages into dist/. Copies styles and
 * assets (font + image renditions), skipping source originals.
 *
 * Any route whose fragment exists is built. Also emits sitemap.xml (indexable
 * routes only), copies robots.txt/CNAME, and ships 404.html at the dist root
 * (GitHub Pages serves it automatically).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const meta = JSON.parse(readFileSync(join(ROOT, 'page-meta.json'), 'utf8'));
const head = readFileSync(join(SRC, 'partials/head.html'), 'utf8');
const header = readFileSync(join(SRC, 'partials/header.html'), 'utf8');
const footer = readFileSync(join(SRC, 'partials/footer.html'), 'utf8');

const NAV_KEYS = Object.values(meta.routes).map((r) => r.nav);

function applyMeta(html, route) {
  const map = {
    TITLE: route.title,
    DESCRIPTION: route.description,
    CANONICAL: route.canonical,
    OG_TITLE: route.ogTitle || route.title,
    OG_DESCRIPTION: route.ogDescription || route.description,
    OG_URL: route.canonical,
    OG_IMAGE: meta.site.ogImage,
    ROBOTS: route.robots || 'index,follow',
  };
  for (const [k, v] of Object.entries(map)) {
    html = html.replaceAll(`{{${k}}}`, v ?? '');
  }
  return html;
}

function applyNav(html, activeNav) {
  for (const key of NAV_KEYS) {
    const token = `{{NAV_${key}}}`;
    html = html.replaceAll(token, key === activeNav ? 'aria-current="page"' : '');
  }
  return html;
}

function buildRoute(name, route) {
  const fragmentPath = join(SRC, 'pages', `${name}.html`);
  if (!existsSync(fragmentPath)) return false;
  const fragment = readFileSync(fragmentPath, 'utf8');

  let page = applyMeta(head, route) + applyNav(header, route.nav) + fragment + applyNav(footer, route.nav);

  const outPath = join(DIST, route.output);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, page, 'utf8');
  return true;
}

function copyAssets() {
  // styles
  cpSync(join(SRC, 'styles'), join(DIST, 'styles'), { recursive: true });
  // assets, skipping image source originals + credits notes
  cpSync(join(SRC, 'assets'), join(DIST, 'assets'), {
    recursive: true,
    filter: (src) => {
      const norm = src.replace(/\\/g, '/');
      const base = norm.split('/').pop();
      if (base.endsWith('-src.jpg')) return false;
      if (base === 'CREDITS.md') return false;
      if (norm.endsWith('/assets/favicon')) return false; // unreferenced (favicon is inline in head.html)
      return true;
    },
  });
  // CNAME (custom domain) — preserved if present in source root
  const cname = join(ROOT, 'CNAME');
  if (existsSync(cname)) cpSync(cname, join(DIST, 'CNAME'));
  // robots.txt — disallows /admin/ from crawling
  const robots = join(SRC, 'robots.txt');
  if (existsSync(robots)) cpSync(robots, join(DIST, 'robots.txt'));
}

function writeSitemap(routes) {
  // only indexable, actually-built routes belong in the sitemap
  const urls = routes
    .filter((r) => !(r.robots || 'index,follow').includes('noindex'))
    .map((r) => `  <url><loc>${r.canonical}</loc></url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  writeFileSync(join(DIST, 'sitemap.xml'), xml, 'utf8');
}

// ---- run ----
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const builtRoutes = [];
for (const [name, route] of Object.entries(meta.routes)) {
  if (buildRoute(name, route)) {
    builtRoutes.push(route);
    console.log(`✓ ${route.path}  ->  dist/${route.output}`);
  } else {
    console.log(`· ${route.path}  (no fragment yet — skipped)`);
  }
}
copyAssets();
writeSitemap(builtRoutes);
console.log(`\nBuilt ${builtRoutes.length} page(s) + assets + sitemap.xml into dist/`);
