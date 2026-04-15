#!/usr/bin/env node
/**
 * SecondNature partner scraper — with integrated portal detection.
 *
 * Phase 1: Discovers all property management partners on secondnature.com by
 *   querying the HubSpot CMS search endpoint (a–z, aa–zz, 0–9) + sitemap.
 *
 * Phase 2: For each newly discovered partner, and for any existing rows still
 *   marked Unknown / None / Confirmed None / Error, runs full portal detection:
 *   - Visits the PM's website (extracted from their SecondNature page)
 *   - Expands dropdown menus, checks all links/buttons/CTAs
 *   - Follows portal links and classifies by final URL domain
 *   - Falls back to page-source scan and direct path probing (/residents, /login…)
 *   - Detects AppFolio, Rentvine, Buildium, Propertyware, Yardi, Entrata, RealPage,
 *     ResMan, Rent Manager, TenantCloud, DoorLoop, TurboTenant, Avail, Hemlane,
 *     MRI Software, PayLease/Zego, Rentec Direct, PayProp, ShowMojo, ClickPay, …
 *
 * CSV columns written each week:
 *   partner_name, url_slug, full_url, date_scraped,
 *   partner_website, portal_detected, portal_type, portal_url,
 *   owner_portal_type, owner_portal_url, detection_method, date_portal_detected
 *
 * Usage:
 *   node scraper.js           — full weekly run
 *   node scraper.js --test    — skip SecondNature crawl, test portal detection
 *                               on up to 5 Error/None rows and exit
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  REPROCESS_TYPES,
  launchBrowser,
  processRow,
  getPartnerWebsite,
  detectPortals,
} from "./portal-lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SEARCH_URL  = "https://www.secondnature.com/_hcms/search";
const SITEMAP_URL = "https://www.secondnature.com/sitemap.xml";
const PM_PATH     = "/property-management/";
const OUTPUT_CSV  = path.join(__dirname, "partners.csv");
const RATE_LIMIT_MS = 400;
const CONCURRENCY   = 3;

const CSV_COLUMNS = [
  "partner_name", "url_slug", "full_url", "date_scraped",
  "partner_website", "portal_detected", "portal_type", "portal_url",
  "owner_portal_type", "owner_portal_url", "detection_method", "date_portal_detected",
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function today() { return new Date().toISOString().slice(0, 10); }

function stripHtml(str) { return str.replace(/<[^>]+>/g, "").trim(); }

function urlToSlug(url) { return url.replace(/\/$/, "").split(PM_PATH)[1] ?? ""; }

// ── CSV helpers ────────────────────────────────────────────────────────────

function splitCsvLine(line) {
  const fields = []; let cur = ""; let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === "," && !inQ) { fields.push(cur); cur = ""; }
    else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(content) {
  const lines = content.trimEnd().split(/\r?\n/);
  const header = lines[0].split(",").map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const fields = splitCsvLine(line);
    const obj = {};
    header.forEach((h, i) => (obj[h] = (fields[i] ?? "").trim()));
    return obj;
  });
  return { header, rows };
}

function escapeCsvField(val) {
  if (val.includes('"')) val = val.replace(/"/g, '""');
  if (val.includes(",") || val.includes('"') || val.includes("\n")) return `"${val}"`;
  return val;
}

function serializeCsv(header, rows) {
  const lines = [header.join(",")];
  for (const row of rows) lines.push(header.map(h => escapeCsvField(row[h] ?? "")).join(","));
  return lines.join("\n") + "\n";
}

function loadCsv(csvPath) {
  if (!fs.existsSync(csvPath)) return { header: [...CSV_COLUMNS], rows: [] };
  const { header, rows } = parseCsv(fs.readFileSync(csvPath, "utf8"));
  // Ensure all expected columns exist
  for (const col of CSV_COLUMNS) { if (!header.includes(col)) header.push(col); }
  return { header, rows };
}

// ── SecondNature scrape ────────────────────────────────────────────────────

async function collectFromSearch(term) {
  const found = new Map();
  let offset = 0;
  const limit = 100;
  const pmBase = `https://www.secondnature.com${PM_PATH}`.replace(/\/$/, "");

  while (true) {
    const params = new URLSearchParams({ term, limit, type: "SITE_PAGE", offset });
    const res = await fetch(`${SEARCH_URL}?${params}`);
    if (!res.ok) throw new Error(`Search failed for "${term}": ${res.status}`);
    const data = await res.json();
    const results = data.results ?? [];
    const total = data.total ?? 0;

    for (const r of results) {
      const url = (r.url ?? "").replace(/\/$/, "");
      if (url.includes(PM_PATH) && url !== pmBase) found.set(url, stripHtml(r.title ?? ""));
    }

    offset += limit;
    if (offset >= total || results.length === 0) break;
    await sleep(RATE_LIMIT_MS);
  }
  return found;
}

async function collectFromSitemap() {
  const found = new Map();
  const pmBase = `https://www.secondnature.com${PM_PATH}`.replace(/\/$/, "");
  const res = await fetch(SITEMAP_URL);
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();
  for (const match of xml.matchAll(/<loc>(.*?)<\/loc>/g)) {
    const url = match[1].replace(/\/$/, "");
    if (url.includes(PM_PATH) && url !== pmBase) found.set(url, "");
  }
  return found;
}

function mergeInto(dest, src) {
  for (const [url, title] of src) {
    if (!dest.has(url) || (title && !dest.get(url))) dest.set(url, title);
  }
}

function* twoLetterCombos() {
  for (let i = 97; i <= 122; i++)
    for (let j = 97; j <= 122; j++)
      yield String.fromCharCode(i) + String.fromCharCode(j);
}

async function runScrape() {
  const all = new Map();

  process.stdout.write("Blank search... ");
  mergeInto(all, await collectFromSearch(""));
  console.log(`${all.size} found`);

  console.log("Single letters (a-z)...");
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    mergeInto(all, await collectFromSearch(letter));
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`  ${all.size} unique partners so far`);

  console.log("Two-letter combinations (aa-zz) — this takes a few minutes...");
  let comboCount = 0;
  for (const combo of twoLetterCombos()) {
    mergeInto(all, await collectFromSearch(combo));
    await sleep(RATE_LIMIT_MS);
    if (++comboCount % 100 === 0) console.log(`  ${comboCount}/676 done, ${all.size} unique so far`);
  }
  console.log(`  ${all.size} unique partners so far`);

  console.log("Numbers (0-9)...");
  for (const digit of "0123456789") {
    mergeInto(all, await collectFromSearch(digit));
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`  ${all.size} unique partners so far`);

  process.stdout.write("Sitemap... ");
  mergeInto(all, await collectFromSitemap());
  console.log(`${all.size} total after sitemap merge`);

  return all;
}

// ── Portal detection integration ───────────────────────────────────────────

/**
 * Process a brand-new partner: get their website and run full portal detection.
 * Returns a complete CSV row object.
 */
async function processNewPartner(browser, secondNatureUrl, rawTitle) {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  try {
    const slug = urlToSlug(secondNatureUrl);
    const name = rawTitle || slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const website = await getPartnerWebsite(page, secondNatureUrl);

    let portalResult = {
      portal_detected: "false", portal_type: "Confirmed None", portal_url: "",
      owner_portal_type: "", owner_portal_url: "", detection_method: "no website found",
    };

    if (website) {
      portalResult = await detectPortals(page, website);
    }

    const datePortalDetected = portalResult.portal_detected === "true" ? today() : "";

    return {
      partner_name:        name,
      url_slug:            slug,
      full_url:            secondNatureUrl,
      date_scraped:        today(),
      partner_website:     website || "",
      ...portalResult,
      date_portal_detected: datePortalDetected,
    };
  } catch (err) {
    const slug = urlToSlug(secondNatureUrl);
    return {
      partner_name:        slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      url_slug:            slug,
      full_url:            secondNatureUrl,
      date_scraped:        today(),
      partner_website:     "",
      portal_detected:     "false",
      portal_type:         "Error",
      portal_url:          "",
      owner_portal_type:   "",
      owner_portal_url:    "",
      detection_method:    err.message.slice(0, 100),
      date_portal_detected: "",
    };
  } finally {
    await page.close();
  }
}

/**
 * Process an existing row that needs a portal detection retry.
 * Preserves date_portal_detected if it was already set.
 */
async function processRetryRow(browser, row) {
  const updated = await processRow(browser, row);
  const wasPreviouslyDetected = row.portal_detected === "true";
  const nowDetected = updated.portal_detected === "true";

  // Set date_portal_detected when first successfully identified
  if (nowDetected && !row.date_portal_detected) {
    updated.date_portal_detected = today();
  } else {
    updated.date_portal_detected = row.date_portal_detected || "";
  }

  return updated;
}

/**
 * Run portal detection on new partners and retry candidates, then write CSV.
 */
async function runPortalDetection(allPartners, csvPath, testMode = false) {
  const { header, rows } = loadCsv(csvPath);
  const existingSlugs = new Set(rows.map(r => r.url_slug));

  // New partners: discovered this run but not yet in CSV
  const newPartnerEntries = [...allPartners.entries()]
    .filter(([url]) => !existingSlugs.has(urlToSlug(url)))
    .sort((a, b) => a[0].localeCompare(b[0]));

  // Retry rows: existing rows without a confirmed portal
  const retryRows = rows.filter(r => REPROCESS_TYPES.has(r.portal_type ?? ""));

  console.log(`New partners to add:    ${newPartnerEntries.length}`);
  console.log(`Retry rows (no portal): ${retryRows.length}`);

  if (testMode) {
    // In test mode: skip the scrape-derived new partners, process up to 5 retry rows
    const testRows = retryRows.slice(0, 5);
    console.log(`\n[TEST MODE] Processing ${testRows.length} retry rows — results will be saved.\n`);
    if (testRows.length === 0) { console.log("No retry rows found — test passed (nothing to do)."); return { newCount: 0, retryCount: 0, rows }; }

    const browser = await launchBrowser();
    try {
      for (const row of testRows) {
        console.log(`  Testing: ${row.partner_name} (${row.partner_website || row.full_url})`);
        const updated = await processRetryRow(browser, row);
        console.log(`    → portal_type: ${updated.portal_type}  portal_url: ${updated.portal_url || "(none)"}`);
        const idx = rows.findIndex(r => r.url_slug === updated.url_slug);
        if (idx !== -1) rows[idx] = updated;
      }
    } finally {
      await browser.close();
    }
    fs.writeFileSync(csvPath, serializeCsv(header, rows), "utf8");
    return { newCount: 0, retryCount: testRows.length, rows };
  }

  if (newPartnerEntries.length === 0 && retryRows.length === 0) {
    console.log("No portal detection needed.");
    // Still write CSV in case header columns were added
    fs.writeFileSync(csvPath, serializeCsv(header, rows), "utf8");
    return { newCount: 0, retryCount: 0, rows };
  }

  const browser = await launchBrowser();
  let newDone = 0;
  let retryDone = 0;

  try {
    // ── Process new partners ────────────────────────────────────────────────
    if (newPartnerEntries.length > 0) {
      console.log(`\nDetecting portals for ${newPartnerEntries.length} new partners...`);
      for (let i = 0; i < newPartnerEntries.length; i += CONCURRENCY) {
        const batch = newPartnerEntries.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(([url, title]) => processNewPartner(browser, url, title))
        );
        rows.push(...results);
        fs.writeFileSync(csvPath, serializeCsv(header, rows), "utf8");
        newDone += results.length;
        process.stdout.write(`\r  ${newDone}/${newPartnerEntries.length} new partners processed`);
      }
      console.log();
    }

    // ── Retry Unknown/None/Error rows ───────────────────────────────────────
    if (retryRows.length > 0) {
      console.log(`\nRetrying portal detection for ${retryRows.length} unresolved rows...`);
      for (let i = 0; i < retryRows.length; i += CONCURRENCY) {
        const batch = retryRows.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(r => processRetryRow(browser, r)));
        for (const updated of results) {
          const idx = rows.findIndex(r => r.url_slug === updated.url_slug);
          if (idx !== -1) rows[idx] = updated;
        }
        fs.writeFileSync(csvPath, serializeCsv(header, rows), "utf8");
        retryDone += results.length;
        process.stdout.write(`\r  ${retryDone}/${retryRows.length} retries processed`);
      }
      console.log();
    }
  } finally {
    await browser.close();
  }

  return { newCount: newPartnerEntries.length, retryCount: retryRows.length, rows };
}

// ── Entry point ────────────────────────────────────────────────────────────

const testMode = process.argv.includes("--test");

let allPartners = new Map();

if (testMode) {
  console.log("=== TEST MODE — skipping SecondNature crawl ===\n");
} else {
  allPartners = await runScrape();
}

const { newCount, retryCount, rows } = await runPortalDetection(allPartners, OUTPUT_CSV, testMode);

// ── Summary ────────────────────────────────────────────────────────────────
const tenantCounts = {};
for (const row of rows) {
  const pt = row.portal_type || "";
  tenantCounts[pt] = (tenantCounts[pt] ?? 0) + 1;
}
const detected = rows.filter(r => r.portal_detected === "true").length;

console.log();
console.log("=".repeat(45));
if (!testMode) {
  console.log(`Total unique partners found:   ${allPartners.size}`);
  console.log(`New partners added:            ${newCount}`);
  console.log(`Existing rows retried:         ${retryCount}`);
}
console.log(`Total in CSV:                  ${rows.length}`);
console.log(`Portal detected:               ${detected} (${Math.round(detected / rows.length * 100)}%)`);
console.log();
console.log("Breakdown by PMS:");
for (const [type, count] of Object.entries(tenantCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(26)} ${count}`);
}
console.log(`\nOutput: ${OUTPUT_CSV}`);
