# Technical SEO checks

Each line is a check; a failed one is a finding with the URL.

Contents: Status and redirects · robots.txt · AI crawlers · sitemap.xml ·
Discovery and verification · Canonical and duplicates · Meta · Multilingual
and regional · Rendering · Images · Core Web Vitals · Internal linking

## Status and redirects

- Canonical host and protocol decided once (`https://`, with or without `www`);
  every other variant → one 301 hop, no chains, no 302 for permanent moves.
- Trailing slash policy consistent; the other form redirects.
- Missing page → real 404 (not 200 with "not found" text — soft 404); removed
  for good → 410 or 301 to the closest equivalent, never to the home page en masse.
- Staging and preview hosts: `X-Robots-Tag: noindex` header or basic auth;
  never `Disallow: /` shipped to production by a shared config.
- 5xx under the crawler's normal load → finding, whatever the page.
- HTTPS on every URL, HSTS header, no mixed content — HTTP variants 301 to HTTPS.

## robots.txt

- At the root, `200`, `text/plain`, under 500 KiB.
- Blocks only crawl waste: admin, cart, checkout, internal search, sort and
  filter combinations, API routes. Never CSS, JS, images or fonts the page
  needs to render.
- `Disallow` does not remove a page from the index — `noindex` does, and needs
  the page crawlable to be seen. Both on one URL = the `noindex` is never read.
- `Sitemap: https://<host>/sitemap.xml` with the absolute URL.
- Yandex: `Clean-param: utm_source&utm_medium&utm_campaign&yclid&gclid` (and
  the site's own tracking/sort params) instead of blocking them; a path prefix
  as the second field narrows it. `Host` and `Crawl-delay` are ignored — remove
  them; the main mirror is set by 301 plus "Переезд сайта" in Yandex Webmaster,
  crawl rate in "Скорость обхода".
- Google ignores `Clean-param`; parameter duplicates are solved by canonical.

## AI crawlers

- Policy is the owner's decision — ask; never block by default.
- `Googlebot` and `YandexBot` feed search and its AI answers (AI Overviews,
  Yandex Neuro); blocking them removes the site from both.
- `User-agent: Google-Extended` only opts out of Gemini training; Search and
  AI Overviews are unaffected. Training and assistant bots (`GPTBot`,
  `ClaudeBot`, `PerplexityBot`, `CCBot`) are separate `User-agent` groups.

## sitemap.xml

- Only canonical, indexable, `200` URLs — no redirects, no `noindex`, no
  parameter duplicates, no URLs blocked in robots.txt.
- Absolute URLs on the canonical host; ≤50 000 URLs and ≤50 MB per file,
  otherwise a sitemap index.
- `lastmod` = real content change date (W3C format), not the build time on
  every URL; `changefreq` and `priority` are ignored by Google — omit.
- Generated from data (routes, CMS, DB), not a hand-kept list.
- Submitted in Search Console and Yandex Webmaster.

## Discovery and verification

- Site ownership confirmed in Google Search Console and Yandex Webmaster (DNS
  record or `<meta name="google-site-verification">` /
  `<meta name="yandex-verification">`; Next: `metadata.verification`). Codes
  come from the owner — never invent them.
- IndexNow for Yandex and Bing: key file `https://<host>/<key>.txt`, a POST to
  `https://yandex.com/indexnow` on page create, update and delete, sent from
  the code path that changes the content. Google does not use it — the sitemap
  stays.
- Snippet control where needed: `data-nosnippet` on a block,
  `max-snippet`/`max-video-preview` in robots meta.

## Canonical and duplicates

- Every indexable page has a self-referencing absolute `rel="canonical"`.
- Filter, sort, pagination-with-params and UTM variants point to the clean URL;
  paginated series pages (`?page=2`) canonical to themselves, not to page 1.
- Canonical target returns `200`, is indexable and is in the sitemap.
- One canonical per page, in the server HTML, not injected by client JS.

## Meta

- `<title>` unique per page, primary query near the start, brand at the end,
  ~50–60 characters visible.
- `<meta name="description">` unique, ~120–160 characters, a reason to click;
  missing is better than one duplicated site-wide.
- `<meta name="robots">` only when restricting; `max-image-preview:large` on
  content pages.
- `<html lang>` matches the content; `<meta name="viewport">` present.
- Open Graph: `og:title`, `og:description`, `og:image` (1200×630, absolute URL),
  `og:url` = canonical, `og:type`; Twitter card `summary_large_image`.
- Favicon: `favicon.ico` at the root plus an SVG/PNG icon ≥48 px — Yandex and
  Google show it in results.

## Multilingual and regional

- `hreflang` on every language version, each listing all others and itself,
  plus `x-default`; codes `ru`, `en`, `ru-KZ`; return links must match.
- Language in the path (`/en/`) or subdomain, never only by cookie or
  `Accept-Language` — the crawler has neither.
- Yandex region: set in Yandex Webmaster ("Региональность") and backed by an
  address on the site or Yandex Business profile.

## Rendering

- Title, description, canonical, H1, main text, internal links and JSON-LD in
  the server HTML. Client-only rendering of those → finding.
- Internal links are `<a href>`; `onClick` navigation is not followed.
- Lazy-loaded content that matters loads without scroll or interaction.
- Infinite scroll has paginated URLs behind it.

## Images

- Meaningful images as `<img>` with `alt`, not CSS backgrounds.
- Descriptive file names (`sinij-divan-oslo.avif`, not `IMG_0042.jpg`),
  AVIF/WebP with `width`/`height`, `srcset` for sizes.
- Image URLs stable and crawlable (not blocked, not signed short-lived links)
  on image-driven sites; `image:image` entries in the sitemap when images carry
  traffic.

## Core Web Vitals (mobile, 75th percentile)

| Metric | Good | Usual cause of a miss |
| --- | --- | --- |
| LCP | ≤ 2.5 s | hero image lazy-loaded or unprioritised, slow TTFB, render-blocking CSS/fonts |
| INP | ≤ 200 ms | long tasks from hydration, heavy handlers, third-party scripts |
| CLS | ≤ 0.1 | images/ads/embeds without size, fonts swapping without fallback metrics |

- LCP image: not `loading="lazy"`, `fetchpriority="high"` (`priority` in
  `next/image`), right size and modern format.
- Third-party tags (analytics, chat, maps) deferred or loaded on interaction.

## Internal linking

- Every indexable page reachable in ≤3 clicks from the home page by `<a href>`.
- Breadcrumbs on hierarchical sites, matching `BreadcrumbList` markup.
- No orphan pages in the sitemap; no links to redirects or 404s.
