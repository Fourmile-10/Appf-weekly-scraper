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

// ── Browser-context fetch (bypasses Cloudflare challenges) ────────────────

async function ensureSession(page) {
  if (!page.url().includes("secondnature.com")) {
    await page.goto("https://www.secondnature.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  }
}

async function fetchViaBrowser(page, url) {
  await ensureSession(page);
  const result = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: "include" });
      return {
        ok: r.ok,
        status: r.status,
        contentType: r.headers.get("content-type") || "",
        body: await r.text(),
      };
    } catch (e) {
      return { ok: false, status: 0, contentType: "", body: "", error: e.message };
    }
  }, url);
  if (result.error) throw new Error(`network error: ${result.error}`);
  if (!result.ok) throw new Error(`HTTP ${result.status}`);
  return result;
}

async function fetchJsonViaBrowser(page, url) {
  const r = await fetchViaBrowser(page, url);
  if (!r.contentType.toLowerCase().includes("json")) {
    const preview = r.body.slice(0, 160).replace(/\s+/g, " ");
    throw new Error(
      `non-JSON response (content-type: ${r.contentType || "<none>"}). ` +
      `Likely Cloudflare challenge. Preview: ${preview}`
    );
  }
  return JSON.parse(r.body);
}

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

async function collectFromSearch(page, term) {
  const found = new Map();
  let offset = 0;
  const limit = 100;
  const pmBase = `https://www.secondnature.com${PM_PATH}`.replace(/\/$/, "");

  while (true) {
    const params = new URLSearchParams({ term, limit, type: "SITE_PAGE", offset });
    const data = await fetchJsonViaBrowser(page, `${SEARCH_URL}?${params}`);
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

async function collectFromSitemap(page) {
  const found = new Map();
  const pmBase = `https://www.secondnature.com${PM_PATH}`.replace(/\/$/, "");
  const r = await fetchViaBrowser(page, SITEMAP_URL);
  for (const match of r.body.matchAll(/<loc>(.*?)<\/loc>/g)) {
    const url = match[1].replace(/\/$/, "");
    if (url.includes(PM_PATH) && url !== pmBase) found.set(url, "");
  }
  return found;
}

async function safeCollect(page, term, all, failures) {
  try {
    mergeInto(all, await collectFromSearch(page, term));
  } catch (err) {
    failures.push({ term, error: err.message.slice(0, 160) });
  }
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

async function runScrape(browser) {
  const all = new Map();
  const failures = [];
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);

  try {
    process.stdout.write("Blank search... ");
    await safeCollect(page, "", all, failures);
    console.log(`${all.size} found`);

    console.log("Single letters (a-z)...");
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      await safeCollect(page, letter, all, failures);
      await sleep(RATE_LIMIT_MS);
    }
    console.log(`  ${all.size} unique partners so far`);

    console.log("Two-letter combinations (aa-zz) — this takes a few minutes...");
    let comboCount = 0;
    for (const combo of twoLetterCombos()) {
      await safeCollect(page, combo, all, failures);
      await sleep(RATE_LIMIT_MS);
      if (++comboCount % 100 === 0) console.log(`  ${comboCount}/676 done, ${all.size} unique so far`);
    }
    console.log(`  ${all.size} unique partners so far`);

    console.log("Numbers (0-9)...");
    for (const digit of "0123456789") {
      await safeCollect(page, digit, all, failures);
      await sleep(RATE_LIMIT_MS);
    }
    console.log(`  ${all.size} unique partners so far`);

    process.stdout.write("Sitemap... ");
    try {
      mergeInto(all, await collectFromSitemap(page));
      console.log(`${all.size} total after sitemap merge`);
    } catch (err) {
      console.log(`failed (${err.message.slice(0, 120)}) — continuing without sitemap`);
      failures.push({ term: "<sitemap>", error: err.message.slice(0, 160) });
    }
  } finally {
    await page.close();
  }

  if (failures.length > 0) {
    console.warn(`\n⚠️  ${failures.length} search term(s) failed:`);
    for (const f of failures.slice(0, 10)) console.warn(`   "${f.term}": ${f.error}`);
    if (failures.length > 10) console.warn(`   …and ${failures.length - 10} more`);
    // Hard fail if we got nothing back at all — likely full Cloudflare block
    if (all.size === 0) {
      throw new Error(`Scrape collected 0 partners across ${failures.length} failed terms — aborting.`);
    }
  }

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
async function runPortalDetection(browser, allPartners, csvPath, testMode = false) {
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
    const testRows = retryRows.slice(0, 5);
    console.log(`\n[TEST MODE] Processing ${testRows.length} retry rows — results will be saved.\n`);
    if (testRows.length === 0) { console.log("No retry rows found — test passed (nothing to do)."); return { newCount: 0, retryCount: 0, rows }; }

    for (const row of testRows) {
      console.log(`  Testing: ${row.partner_name} (${row.partner_website || row.full_url})`);
      const updated = await processRetryRow(browser, row);
      console.log(`    → portal_type: ${updated.portal_type}  portal_url: ${updated.portal_url || "(none)"}`);
      const idx = rows.findIndex(r => r.url_slug === updated.url_slug);
      if (idx !== -1) rows[idx] = updated;
    }
    fs.writeFileSync(csvPath, serializeCsv(header, rows), "utf8");
    return { newCount: 0, retryCount: testRows.length, rows };
  }

  if (newPartnerEntries.length === 0 && retryRows.length === 0) {
    console.log("No portal detection needed.");
    fs.writeFileSync(csvPath, serializeCsv(header, rows), "utf8");
    return { newCount: 0, retryCount: 0, rows };
  }

  let newDone = 0;
  let retryDone = 0;

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

  return { newCount: newPartnerEntries.length, retryCount: retryRows.length, rows };
}

// ── Entry point ────────────────────────────────────────────────────────────

const testMode = process.argv.includes("--test");

let allPartners = new Map();
const browser = await launchBrowser();
let newCount, retryCount, rows;

try {
  if (testMode) {
    console.log("=== TEST MODE — skipping SecondNature crawl ===\n");
  } else {
    allPartners = await runScrape(browser);
  }

  ({ newCount, retryCount, rows } = await runPortalDetection(browser, allPartners, OUTPUT_CSV, testMode));
} finally {
  await browser.close();
}

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
