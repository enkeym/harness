# Structured data

JSON-LD in the server HTML, one `<script type="application/ld+json">` per
entity or one `@graph`. Markup describes what is visible on the page — nothing
more. Validate with Google Rich Results Test, the Schema.org validator
(`validator.schema.org`) and the Yandex Webmaster markup validator.

## By page type

| Page | Types | Required in practice |
| --- | --- | --- |
| Every page (once, site-wide) | `Organization` (or `LocalBusiness` subtype), `WebSite` | `name`, `url`, `logo`, `sameAs`, `contactPoint`; `WebSite.name` = the brand shown in results |
| Hierarchical page | `BreadcrumbList` | `itemListElement` with `position`, `name`, `item` matching visible crumbs |
| Product card | `Product` + `Offer` (+ `AggregateRating`, `Review` only when shown) | `name`, `image`, `description`, `sku`/`gtin`, `offers.price`, `priceCurrency`, `availability`, `url` |
| Catalog / category | `ItemList` of product URLs, or nothing | never a `Product` for the list page itself |
| Article, blog, news | `Article` / `BlogPosting` / `NewsArticle` | `headline`, `image`, `datePublished`, `dateModified`, `author` (`Person` with `url`) |
| Local business, contacts | `LocalBusiness` subtype | `address`, `telephone`, `openingHoursSpecification`, `geo` — identical to Yandex Business / Google Business profile |
| Event | `Event` | `startDate`, `location`, `eventStatus`, `offers` when ticketed |
| Video page | `VideoObject` | `name`, `thumbnailUrl`, `uploadDate`, `duration`, `contentUrl` or `embedUrl` |
| Recipe | `Recipe` | `recipeIngredient`, `recipeInstructions`, `image`, `totalTime` |
| Job | `JobPosting` | `title`, `datePosted`, `validThrough`, `hiringOrganization`, `jobLocation`, `baseSalary` |
| Questions and answers on the page | `FAQPage` | only for real Q&A visible on the page |
| Forum, user Q&A | `DiscussionForumPosting`, `QAPage` | user-generated content only |
| Software / app | `SoftwareApplication` | `name`, `operatingSystem`, `applicationCategory`, `offers` |

## Google vs Yandex

- Google: no FAQ or HowTo rich results in any surface; `FAQPage` and `HowTo`
  stay valid Schema.org and cause no harm, but bring no snippet — don't add
  them for Google alone. Current feature list: Search Central "search gallery".
- Yandex: `FAQPage` Q&A can still appear in snippets (mostly mobile) per
  current practice — confirm in Yandex Webmaster's validator on the real page
  before promising it. Yandex reads JSON-LD for products and breadcrumbs;
  Open Graph feeds its link previews.
- `Organization`/`LocalBusiness` details must match the Yandex Business and
  Google Business profiles exactly — mismatched address or phone is a trust
  finding.
- AI answers (AI Overviews, Yandex Neuro) use the same index: correct markup
  and clear text, no special AI schema.

## Rules

- Values from the same data that renders the page (one mapper from the entity
  to JSON-LD), never hand-typed literals that drift from the UI.
- Absolute URLs; ISO 8601 dates with timezone; `priceCurrency` as `RUB`;
  `availability` as `https://schema.org/InStock`.
- `@id` per entity (`https://<host>/#organization`) and references by `@id`
  instead of repeating the organisation on every page.
- Escape `<` in serialized JSON (`JSON.stringify(data).replace(/</g, '\\u003c')`)
  — user text inside JSON-LD is an XSS path.
- One entity described once per page: no microdata and JSON-LD duplicates of
  the same product.

## Spam — manual action risk

- `AggregateRating` or `Review` with no reviews visible on the page, or
  self-written reviews of your own organisation on the home page.
- Markup for content hidden, behind a click to another page, or absent.
- `Product` markup on a category page, `Event` for a coupon, `JobPosting` for
  a closed vacancy.
- A penalty removes rich results site-wide, not only on the offending page.
