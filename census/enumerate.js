#!/usr/bin/env node
/**
 * census/enumerate.js — discover AppFolio customer subdomains.
 *
 * Every AppFolio customer gets [slug].appfolio.com. This script unions several
 * public sources and appends any new slug to census/customers.csv:
 *
 *   1. Common Crawl index (CDX API) for the N most recent monthly crawls
 *   2. Wayback Machine CDX API (domain match on appfolio.com)
 *   3. Seed CSVs dropped in census/seed/ (any column; anything that looks like
 *      a *.appfolio.com host or URL is picked up)
 *
 * The list is append-only. A slug that stops appearing in any source is NOT
 * removed; poll.js decides whether it is still alive.
 *
 * Usage:
 *   node census/enumerate.js                 # all sources, 12 Common Crawl indexes
 *   node census/enumerate.js --cc 4          # fewer Common Crawl indexes (faster)
 *   node census/enumerate.js --no-wayback    # skip Wayback
 *   node census/enumerate.js --seed-only     # only ingest census/seed/*.csv
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  CUSTOMERS_COLUMNS, extractSubdomain, loadCsv, serializeCsv, parseCsv,
  today, sleep, fetchRetry, log, resetRunLog,
} from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CUSTOMERS_CSV = path.join(__dirname, "customers.csv");
const SEED_DIR = path.join(__dirname, "seed");

const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const CC_INDEXES = parseInt(argVal("--cc") || "30", 10);
const NO_WAYBACK = args.includes("--no-wayback");
const SEED_ONLY = args.includes("--seed-only");

const found = new Map(); // subdomain -> Set(sources)
const add = (sub, source) => {
  if (!sub) return;
  if (!found.has(sub)) found.set(sub, new Set());
  found.get(sub).add(source);
};

// ── 1. Common Crawl ────────────────────────────────────────────────────────

async function commonCrawl() {
  log(`\n[Common Crawl] fetching index list`);
  const res = await fetchRetry("https://index.commoncrawl.org/collinfo.json");
  const indexes = (await res.json()).slice(0, CC_INDEXES);
  let total = 0;

  for (const idx of indexes) {
    const base = `${idx["cdx-api"]}?url=*.appfolio.com&output=json&fl=url`;
    let pages = 1;
    try {
      const r = await fetchRetry(`${base}&showNumPages=true`, { tries: 8, backoff: 5000, timeout: 60_000 });
      const j = await r.json();
      pages = j.pages ?? 1;
    } catch (err) {
      log(`  ${idx.id}: could not read page count (${err.message}), skipping`);
      continue;
    }

    let before = found.size;
    for (let p = 0; p < pages; p++) {
      try {
        const r = await fetchRetry(`${base}&page=${p}`, { tries: 8, backoff: 5000, timeout: 120_000 });
        if (r.status === 404) break; // no results for this index
        const text = await r.text();
        for (const line of text.split("\n")) {
          if (!line) continue;
          try { add(extractSubdomain(JSON.parse(line).url), "cc"); } catch {}
        }
        total++;
      } catch (err) {
        log(`  ${idx.id} page ${p}: ${err.message}`);
      }
      await sleep(1500); // be polite to the CC index servers
    }
    log(`  ${idx.id}: ${pages} page(s), +${found.size - before} new subdomains (running total ${found.size})`);
  }
  log(`[Common Crawl] done, ${total} index pages read`);
}

// ── 2. Wayback Machine ─────────────────────────────────────────────────────

async function wayback() {
  log(`\n[Wayback] querying CDX`);
  // Domain match, collapse to one row per host so the result set stays small.
  // Negated filter (leading !) drops www.* rows; collapse keeps one row per URL key.
  const base = "https://web.archive.org/cdx/search/cdx?url=appfolio.com&matchType=domain" +
               "&fl=original&collapse=urlkey&output=json&filter=!original:.*www\\.appfolio\\.com.*";
  let pages = 1;
  try {
    const r = await fetchRetry(`${base}&showNumPages=true`, { tries: 3, timeout: 60_000 });
    pages = parseInt((await r.text()).trim(), 10) || 1;
  } catch (err) {
    log(`  could not read page count (${err.message}); trying single query`);
  }
  log(`  ${pages} page(s)`);
  const before = found.size;
  for (let p = 0; p < pages; p++) {
    try {
      const r = await fetchRetry(`${base}&page=${p}`, { tries: 3, timeout: 180_000 });
      const text = await r.text();
      log(`  page ${p}: HTTP ${r.status}, ${text.length} bytes, starts: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
      let rows = [];
      try { rows = JSON.parse(text); } catch { rows = []; }
      let n = 0;
      for (const row of rows.slice(1)) { if (extractSubdomain(row[0])) n++; add(extractSubdomain(row[0]), "wb"); }
      log(`  page ${p}: ${rows.length} rows, ${n} customer hosts`);
    } catch (err) {
      log(`  page ${p}: ${err.message}`);
    }
    await sleep(1500);
  }
  log(`[Wayback] +${found.size - before} new subdomains (running total ${found.size})`);
}

// ── 3. Seed CSVs ───────────────────────────────────────────────────────────

function seeds() {
  if (!fs.existsSync(SEED_DIR)) return;
  const files = fs.readdirSync(SEED_DIR).filter(f => /\.(csv|txt)$/i.test(f));
  if (!files.length) return;
  log(`\n[Seed] ${files.length} file(s)`);
  for (const f of files) {
    const before = found.size;
    const content = fs.readFileSync(path.join(SEED_DIR, f), "utf8");
    const { rows } = parseCsv(content);
    const cells = rows.length ? rows.flatMap(r => Object.values(r)) : content.split(/\r?\n/);
    for (const cell of cells) {
      const m = String(cell).match(/([a-z0-9-]+)\.appfolio\.com/i);
      if (m) add(extractSubdomain(`${m[1].toLowerCase()}.appfolio.com`), `seed:${f}`);
      else if (/^[a-z0-9-]{2,63}$/i.test(String(cell).trim())) add(extractSubdomain(`${cell.trim().toLowerCase()}.appfolio.com`), `seed:${f}`);
    }
    log(`  ${f}: +${found.size - before}`);
  }
}

// ── Merge into customers.csv ───────────────────────────────────────────────

async function main() {
  resetRunLog(`Census run ${today()}`);
  if (!SEED_ONLY) {
    await commonCrawl();
    if (!NO_WAYBACK) await wayback();
  }
  seeds();

  const { header, rows } = loadCsv(CUSTOMERS_CSV, CUSTOMERS_COLUMNS);
  const existing = new Map(rows.map(r => [r.subdomain, r]));
  let added = 0;
  const d = today();

  for (const [sub, sources] of [...found.entries()].sort()) {
    const srcStr = [...sources].sort().join(";");
    if (existing.has(sub)) {
      const row = existing.get(sub);
      const merged = new Set((row.sources || "").split(";").filter(Boolean));
      for (const s of sources) merged.add(s);
      row.sources = [...merged].sort().join(";");
    } else {
      rows.push({
        subdomain: sub, first_seen: d, sources: srcStr, status: "new",
        last_alive: "", last_checked: "", consecutive_dead: "0", last_listing_count: "",
      });
      added++;
    }
  }

  rows.sort((a, b) => a.subdomain.localeCompare(b.subdomain));
  fs.writeFileSync(CUSTOMERS_CSV, serializeCsv(header, rows), "utf8");

  const summary = `Enumeration ${d}: ${found.size} subdomains seen this run, ${added} new, ${rows.length} total in customers.csv\n`;
  log("\n" + summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "## " + summary);
}

main().catch(err => { console.error(err); process.exit(1); });
