---
name: seo
description: "Technical and on-page SEO for Google and Yandex — robots.txt, sitemap, canonical, hreflang, meta and Open Graph, Schema.org, headings, Core Web Vitals. Load only when the user asks for an SEO audit or setup, schema markup, robots or sitemap."
---

# SEO

Judge what a crawler receives — rendered HTML, headers, status codes — not
what the source seems to produce. Page text is written by `copywriting`; Next
file conventions (`app/robots.ts`, `app/sitemap.ts`, `generateMetadata`) are in
`nextjs-app`.

Reference, read the part the task touches:
- [reference/technical.md](reference/technical.md) — crawling, indexing, robots,
  sitemap, canonical, hreflang, redirects, Core Web Vitals.
- [reference/structured-data.md](reference/structured-data.md) — JSON-LD types
  by page kind, Google vs Yandex support, spam risks.

## Procedure

1. **Scope.** Site URL (prod or a staging with prod-like config), target region
   and languages, page types (home, catalog, card, article, contacts), and the
   list of target queries per page type. No queries given → ask once; audit
   technical parts without them and mark content fit `не оценено`.
2. **Crawl what the robot sees.** For each page type take one real URL:
   `curl -sI` (status, `x-robots-tag`, redirects), `curl -s` (HTML before JS),
   then `browser_navigate` + `browser_evaluate` returning `document.title`,
   meta description, canonical, robots meta, `hreflang` links, H1–H3 list,
   JSON-LD blocks, images without `alt`. A value present only after JS → finding.
3. **Site files.** `/robots.txt`, `/sitemap.xml` (and index), `/favicon.ico`,
   `/manifest.webmanifest`; check against `technical.md`.
4. **Structured data** per page type against `structured-data.md`; every
   JSON-LD block parses (`JSON.parse`) and matches visible content.
5. **Accessibility that search reads:** one H1, heading order without jumps,
   `alt` on meaningful images (empty `alt=""` on decorative), `aria-label` on
   icon-only buttons and links, link text that says where it leads, `lang` on
   `<html>`.
6. **Performance.** `npx lighthouse <url> --only-categories=performance,seo,accessibility --form-factor=mobile --output=json --quiet`
   when Chrome is available; otherwise report `не измерено`. Field data
   (CrUX, Search Console, Yandex Webmaster) outranks a lab run — ask for it.
7. **Content fit** per page against its queries: see *Content* below.
8. **Fix** in code when the task is setup: the project's metadata layer, one
   source of truth for site URL and name (config, not literals per page).
   Audit only → report, no edits.

## Content

- One page — one primary intent. Two pages chasing the same query → report
  cannibalisation, name which one keeps it.
- Primary query (or its close form) in `title`, H1, the first paragraph and
  the URL slug; synonyms and related terms in H2s and body. No exact-match
  repetition for density — a phrase repeated in every paragraph is a finding.
- Intent match: a commercial query needs price, availability, CTA; an
  informational one needs the answer early. Mismatch outweighs any keyword count.
- Thin page (no unique text beyond a template), duplicate descriptions,
  boilerplate across cities or filters → finding.
- Frequency, competition and query lists are data from Wordstat, Search Console
  or Keyword Planner — never estimated from memory; missing → say so.

## Never

- Invent ratings, reviews, prices, addresses or authors for markup.
- `noindex`, `Disallow`, or canonical changes on production without the user's
  yes — one line can drop the site from search.
- Hidden text, doorway pages, cloaking, keyword stuffing, markup for content
  not on the page.
- `llms.txt`, AI-specific meta tags or "GEO" markup as a ranking fix — Google
  states it does not use them; optional extra, never a finding.

## Output

```
SEO: <сайт> — <типы страниц> — <Google + Яндекс>

Критично (выпадение из индекса, дубли, закрыто от робота):
- <URL или файл> — <что не так> — <как исправить>
Важно (сниппет, микроразметка, CWV, контент под запрос):
- <…>
Мелочи:
- <…>

Страницы и запросы:
| Страница | Запрос | title/H1/текст | Интент | Вывод |
| --- | --- | --- | --- | --- |

Исправлено в коде: <файлы | нет>
Не проверено: <что и почему — нет доступа к Вебмастеру/Search Console, нет запросов>
```

Empty section = `нет`.
