# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Track the growth of SecondNature's property management partner network over time. SecondNature (secondnature.com) is an AppFolio partner that offers resident benefit packages. This scraper counts how many property management companies have signed up to their platform each week.

Partner pages follow this URL pattern:
```
https://www.secondnature.com/property-management/{slug}
```

## Running the Scraper

```bash
node scraper.js
```

No dependencies to install — uses Node.js built-in `fetch` (requires Node 18+). Results are appended to `partners.csv`.

## How the Scraper Works

### The Problem with the Sitemap

The sitemap at `https://www.secondnature.com/sitemap.xml` only lists ~45 partners. The true number is 700+. The sitemap is incomplete by design or oversight.

### The Solution: HubSpot CMS Search Endpoint

SecondNature's site is built on HubSpot CMS. HubSpot exposes a search endpoint at:

```
GET https://www.secondnature.com/_hcms/search
```

**Parameters:**
| Param | Value |
|-------|-------|
| `term` | Search keyword |
| `type` | `SITE_PAGE` |
| `limit` | Up to 100 |
| `offset` | For pagination |

**Response shape:**
```json
{
  "total": 128,
  "offset": 0,
  "limit": 100,
  "results": [
    {
      "url": "https://www.secondnature.com/property-management/apex",
      "title": "<span class=\"hs-search-highlight\">Apex</span> Property Management",
      ...
    }
  ]
}
```

Note: titles contain HubSpot highlight `<span>` tags that must be stripped.

### The Alphabetical Crawl Strategy

A blank search (`term=`) returns 0 results. Instead we exploit the fact that every company name contains at least one letter:

1. **Single letters (a–z):** 26 queries. "Apex" is caught by `a`. "Zest" by `z`.
2. **Two-letter combinations (aa–zz):** 676 queries. Catches names that the single-letter search might miss due to HubSpot's result cap per query.
3. **Numbers (0–9):** 10 queries. Catches "1st Choice Property Management", "4D Property Solutions", etc.
4. **Sitemap:** Merged last as a safety net.

All results are filtered to only keep URLs containing `/property-management/` and deduplicated by slug.

**Verified count:** 715+ unique partners as of March 2025 (vs 45 from sitemap alone).

### CSV Output (`partners.csv`)

Columns: `partner_name`, `url_slug`, `full_url`, `date_scraped`

The CSV is **append-only**. Each run compares discovered slugs against existing rows and only writes new partners with the current date. This lets us track exactly when each partner joined SecondNature's platform.

## Automated Schedule

GitHub Actions runs the scraper every **Monday at 9:00 AM UTC** via `.github/workflows/weekly-scrape.yml`. After each run, any new rows are committed back to the repo automatically.

To trigger a manual run: go to Actions → Weekly Partner Scrape → Run workflow.

## Architecture

```
scraper.js              — single-file scraper, no external dependencies
partners.csv            — append-only results (committed to repo)
package.json            — sets "type": "module" for ES module syntax
.github/workflows/
  weekly-scrape.yml     — Monday 9am UTC cron + manual trigger
```

## Quarterly PMS Recheck (churn tracking)

The weekly job only detects portals for new partners and unresolved rows, so a partner tagged AppFolio is never re-examined. `quarterly-recheck.js` re-runs portal detection on every partner with a confirmed PMS and records switches.

```bash
node quarterly-recheck.js              # full panel (~770 rows, 2-4 hours)
node quarterly-recheck.js --limit 10   # test on 10 rows
node quarterly-recheck.js --slug 1rm   # one partner
```

Schedule: `.github/workflows/quarterly-recheck.yml`, 10:00 UTC on the 21st of Jan / Apr / Jul / Oct. Shares a concurrency group with the weekly scrape so the two never write `partners.csv` at the same time.

### Files

| File | Role | Excel use |
|------|------|-----------|
| `partners.csv` | Current state, one row per partner. Unchanged layout plus `date_last_verified`. A confirmed switch overwrites `portal_type` / `portal_url` / `detection_method`. | Main table (existing Power Query) |
| `portal_history.csv` | Long format: one row per partner per quarterly check, with `status` = confirmed / changed / ambiguous / unverified. | Pivot by check_date x detected_portal_type for share over time |
| `portal_changes.csv` | One row per confirmed switch: from, to, evidence URL. This is the churn log. | Filter `from_portal_type = AppFolio` |

### Rules that prevent false churn

- Error / Confirmed None / `Likely: ...` results never overwrite a confirmed PMS (logged as `unverified`).
- Add-ons (Zego, ClickPay, Paymentus, ShowMojo, Rently, Funnel, Livly, SmartRent) are not a PMS; detecting one where a PMS was confirmed is logged as `ambiguous`, not a switch.
- A switch is re-detected once and only counts if both runs agree.
- The partner list is never pruned: a PM that leaves SecondNature stays in the panel so SN churn is not confused with PMS churn.

### Resuming

Every row is stamped `date_last_verified` as it is processed and the CSVs are saved after each batch. If the GitHub job hits its time limit, the commit step still runs; re-run the workflow manually and it skips rows already verified this quarter.

## AppFolio Customer Census (`census/`)

Separate from the SecondNature panel. Every AppFolio customer gets `[slug].appfolio.com` with a public, server-rendered `/listings` page. The census enumerates slugs from public indexes and polls each one monthly. No Playwright, Node built-ins only.

```bash
node census/enumerate.js          # Common Crawl (last 12 indexes) + Wayback + census/seed/*.csv
node census/poll.js               # poll every known slug
node census/poll.js --limit 50    # test
```

Schedule: `.github/workflows/monthly-census.yml`, 11:00 UTC on the 2nd of each month. Manual run supports `cc_indexes` and `skip_enumerate` inputs.

### Files

| File | Role |
|------|------|
| `census/customers.csv` | One row per slug (append-only): first_seen, sources, status, last_alive, last_checked, consecutive_dead, last_listing_count |
| `census/listings_monthly.csv` | One row per slug per month: status, http_status, listing_count. Re-running in the same month replaces that month's rows. |
| `census/seed/` | Optional seed lists (any CSV with appfolio.com hosts or bare slugs) |

### Status values

- `alive` — 200 on the customer host with listings markup; `listing_count` = distinct `/listings/detail/` links
- `alive_nolistings` — 200 but no listings markup (public listings disabled)
- `dead` — redirected to `www.appfolio.com/page-not-found-sub`: slug no longer belongs to a customer. Treat **2+ consecutive dead polls** as churn.
- `http_<code>`, `redirect:<host>`, `error` — kept separate; only `dead`/404/410 increment `consecutive_dead`

### Interpretation

- Customer count and churn come from `alive` vs `consecutive_dead >= 2`. New slugs per month (first_seen) is a gross-adds proxy, bounded by how quickly public indexes pick new customers up.
- `listing_count` is vacancies, not units. Use it cross-sectionally (size buckets from trailing averages) or same-store year over year, not as a raw unit-growth series.
- Enumeration is append-only and depends on Common Crawl / Wayback coverage, so the panel undercounts the true base. Add seed lists to `census/seed/` to widen it.
