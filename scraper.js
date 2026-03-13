#!/usr/bin/env node
/**
 * SecondNature partner scraper.
 *
 * Finds all property management partners on secondnature.com by querying the
 * HubSpot CMS search endpoint with every letter (a-z), every two-letter
 * combination (aa-zz), and every digit (0-9), then merges with the sitemap.
 *
 * Results are appended to partners.csv — never overwritten — so partner counts
 * can be tracked week over week.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SEARCH_URL = "https://www.secondnature.com/_hcms/search";
const SITEMAP_URL = "https://www.secondnature.com/sitemap.xml";
const PM_PATH = "/property-management/";
const OUTPUT_CSV = path.join(__dirname, "partners.csv");
const RATE_LIMIT_MS = 400; // delay between search queries

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, "").trim();
}

function urlToSlug(url) {
  return url.replace(/\/$/, "").split(PM_PATH)[1] ?? "";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Query the HubSpot search endpoint for a single term, paginating through all
 * results. Returns a Map of { url -> partnerName }.
 */
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
      if (url.includes(PM_PATH) && url !== pmBase) {
        found.set(url, stripHtml(r.title ?? ""));
      }
    }

    offset += limit;
    if (offset >= total || results.length === 0) break;
    await sleep(RATE_LIMIT_MS);
  }

  return found;
}

/**
 * Fetch the sitemap and return a Map of { url -> "" } for all
 * /property-management/ URLs.
 */
async function collectFromSitemap() {
  const found = new Map();
  const pmBase = `https://www.secondnature.com${PM_PATH}`.replace(/\/$/, "");

  const res = await fetch(SITEMAP_URL);
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();

  for (const match of xml.matchAll(/<loc>(.*?)<\/loc>/g)) {
    const url = match[1].replace(/\/$/, "");
    if (url.includes(PM_PATH) && url !== pmBase) {
      found.set(url, "");
    }
  }

  return found;
}

/** Merge src into dest, preferring non-empty titles. */
function mergeInto(dest, src) {
  for (const [url, title] of src) {
    if (!dest.has(url) || (title && !dest.get(url))) {
      dest.set(url, title);
    }
  }
}

/** Generate all two-letter combinations aa through zz. */
function* twoLetterCombos() {
  for (let i = 97; i <= 122; i++) {
    for (let j = 97; j <= 122; j++) {
      yield String.fromCharCode(i) + String.fromCharCode(j);
    }
  }
}

async function runScrape() {
  const all = new Map();

  // 1. Blank search (returns 0 on this site, but worth trying)
  process.stdout.write("Blank search... ");
  mergeInto(all, await collectFromSearch(""));
  console.log(`${all.size} found`);

  // 2. Single letters a-z
  console.log("Single letters (a-z)...");
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    mergeInto(all, await collectFromSearch(letter));
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`  ${all.size} unique partners so far`);

  // 3. Two-letter combinations aa-zz (676 queries)
  console.log("Two-letter combinations (aa-zz) — this takes a few minutes...");
  let comboCount = 0;
  for (const combo of twoLetterCombos()) {
    mergeInto(all, await collectFromSearch(combo));
    await sleep(RATE_LIMIT_MS);
    comboCount++;
    if (comboCount % 100 === 0) {
      console.log(`  ${comboCount}/676 done, ${all.size} unique so far`);
    }
  }
  console.log(`  ${all.size} unique partners so far`);

  // 4. Numbers 0-9
  console.log("Numbers (0-9)...");
  for (const digit of "0123456789") {
    mergeInto(all, await collectFromSearch(digit));
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`  ${all.size} unique partners so far`);

  // 5. Sitemap
  process.stdout.write("Sitemap... ");
  mergeInto(all, await collectFromSitemap());
  console.log(`${all.size} total after sitemap merge`);

  return all;
}

/** Load existing URL slugs from CSV so we only append new ones.
 *  Extracts slugs from the full_url column (always unambiguous) rather than
 *  splitting by comma, which breaks when partner names contain commas. */
function loadExistingSlugs(csvPath) {
  if (!fs.existsSync(csvPath)) return new Set();
  const content = fs.readFileSync(csvPath, "utf8");
  const slugs = new Set();
  for (const match of content.matchAll(
    /https:\/\/www\.secondnature\.com\/property-management\/([^,\s]+)/g
  )) {
    slugs.add(match[1].replace(/\/$/, ""));
  }
  return slugs;
}

function saveResults(partners, csvPath) {
  const existing = loadExistingSlugs(csvPath);
  const date = today();
  const newRows = [];

  for (const [url, rawTitle] of [...partners.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const slug = urlToSlug(url);
    if (existing.has(slug)) continue;
    const name = rawTitle || slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    // Escape any commas in name
    const safeName = name.includes(",") ? `"${name}"` : name;
    newRows.push(`${safeName},${slug},${url},${date}`);
  }

  const writeHeader = !fs.existsSync(csvPath);
  const content = (writeHeader ? "partner_name,url_slug,full_url,date_scraped\n" : "") + newRows.join("\n") + (newRows.length ? "\n" : "");
  fs.appendFileSync(csvPath, content, "utf8");

  return newRows.length;
}

const partners = await runScrape();
const newCount = saveResults(partners, OUTPUT_CSV);
const total = partners.size;

console.log();
console.log("=".repeat(40));
console.log(`Total unique partners found:  ${total}`);
console.log(`New partners added to CSV:    ${newCount}`);
console.log(`Previously known partners:    ${total - newCount}`);
console.log(`Output: ${OUTPUT_CSV}`);
