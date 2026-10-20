#!/usr/bin/env node
/**
 * census/poll.js — monthly liveness and listing-count poll of every known
 * AppFolio customer subdomain.
 *
 * For each row in census/customers.csv it fetches
 *   https://[subdomain].appfolio.com/listings
 * (plain HTTP, no browser) and records:
 *
 *   status:
 *     alive            200 on the customer's own host, listings page present
 *     alive_nolistings 200 on the customer's own host but no listings markup
 *                      (public listings disabled); listing_count left blank
 *     dead             redirected to www.appfolio.com (page-not-found-sub):
 *                      the subdomain no longer belongs to a customer
 *     http_<code>      an unexpected status on the customer's host (404, 403, 5xx)
 *     error            network error / timeout; counts as nothing
 *   listing_count:     distinct /listings/detail/ links on the page
 *
 * Writes one row per subdomain per month to census/listings_monthly.csv
 * (re-running within the same month replaces that month's row) and updates
 * status / last_alive / last_checked / consecutive_dead on customers.csv.
 *
 * Usage:
 *   node census/poll.js                 # everything
 *   node census/poll.js --limit 50      # first 50 rows (testing)
 *   node census/poll.js --only-new      # rows never polled before
 *   node census/poll.js --skip-dead 3   # skip rows dead for >= 3 consecutive polls
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  CUSTOMERS_COLUMNS, MONTHLY_COLUMNS, loadCsv, serializeCsv, today, thisMonth,
  pool, UA, log, resetRunLog,
} from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CUSTOMERS_CSV = path.join(__dirname, "customers.csv");
const MONTHLY_CSV   = path.join(__dirname, "listings_monthly.csv");

const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const LIMIT = argVal("--limit") ? parseInt(argVal("--limit"), 10) : Infinity;
const ONLY_NEW = args.includes("--only-new");
const SKIP_DEAD = argVal("--skip-dead") ? parseInt(argVal("--skip-dead"), 10) : Infinity;
const CONCURRENCY = parseInt(process.env.POLL_CONCURRENCY || "15", 10);
const TIMEOUT = 20_000;

const DETAIL_RE = /\/listings\/detail\/([A-Za-z0-9-]+)/g;
const LISTINGS_MARKERS = /Showing all available listings|No vacancies found|\/listings\/detail\/|Current Listings/i;

async function fetchManual(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { redirect: "manual", signal: ctrl.signal, headers: { "user-agent": UA, "accept": "text/html" } });
  } finally {
    clearTimeout(t);
  }
}

async function pollOne(row) {
  // CENSUS_BASE is a test hook: point it at a local mock server.
  let url = process.env.CENSUS_BASE
    ? `${process.env.CENSUS_BASE}/${row.subdomain}/listings`
    : `https://${row.subdomain}.appfolio.com/listings`;
  const host = new URL(url).hostname.toLowerCase();
  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetchManual(url);
      const code = res.status;

      if (code >= 300 && code < 400) {
        const loc = res.headers.get("location") || "";
        let target;
        try { target = new URL(loc, url); } catch { return { status: "error", http_status: code, listing_count: "" }; }
        if (/(^|\.)www\.appfolio\.com$/i.test(target.hostname) || target.hostname === "appfolio.com") {
          return { status: "dead", http_status: code, listing_count: "" };
        }
        if (target.hostname.toLowerCase() !== host) {
          // Redirected off the customer's host somewhere else entirely
          return { status: `redirect:${target.hostname}`, http_status: code, listing_count: "" };
        }
        url = target.toString();
        continue;
      }

      if (code === 200) {
        const body = await res.text();
        const ids = new Set();
        for (const m of body.matchAll(DETAIL_RE)) ids.add(m[1]);
        if (ids.size === 0 && !LISTINGS_MARKERS.test(body)) {
          return { status: "alive_nolistings", http_status: code, listing_count: "" };
        }
        return { status: "alive", http_status: code, listing_count: String(ids.size) };
      }

      return { status: `http_${code}`, http_status: code, listing_count: "" };
    }
    return { status: "error", http_status: "", listing_count: "" };
  } catch (err) {
    return { status: "error", http_status: "", listing_count: "", note: err.name === "AbortError" ? "timeout" : err.message };
  }
}

async function main() {
  if (!fs.existsSync(path.join(__dirname, "run_log.md"))) resetRunLog(`Census run ${today()}`);
  const customers = loadCsv(CUSTOMERS_CSV, CUSTOMERS_COLUMNS);
  const monthly   = loadCsv(MONTHLY_CSV, MONTHLY_COLUMNS);
  if (!customers.rows.length) { console.error("customers.csv is empty; run enumerate.js first."); process.exit(1); }

  const month = thisMonth();
  const d = today();

  let targets = customers.rows;
  if (ONLY_NEW) targets = targets.filter(r => !r.last_checked);
  if (SKIP_DEAD < Infinity) targets = targets.filter(r => parseInt(r.consecutive_dead || "0", 10) < SKIP_DEAD);
  if (LIMIT < Infinity) targets = targets.slice(0, LIMIT);

  log(`Polling ${targets.length} of ${customers.rows.length} subdomains for ${month} (concurrency ${CONCURRENCY})`);

  // Index this month's existing rows so re-runs replace rather than duplicate
  const monthIdx = new Map();
  monthly.rows.forEach((r, i) => { if (r.month === month) monthIdx.set(r.subdomain, i); });

  const tally = {};
  let sinceSave = 0;
  const save = () => {
    fs.writeFileSync(CUSTOMERS_CSV, serializeCsv(customers.header, customers.rows), "utf8");
    fs.writeFileSync(MONTHLY_CSV, serializeCsv(monthly.header, monthly.rows), "utf8");
  };

  await pool(targets, CONCURRENCY, async (row) => {
    const r = await pollOne(row);
    const rec = {
      month, subdomain: row.subdomain, status: r.status, http_status: String(r.http_status ?? ""),
      listing_count: r.listing_count, checked_at: d,
    };
    if (monthIdx.has(row.subdomain)) monthly.rows[monthIdx.get(row.subdomain)] = rec;
    else { monthly.rows.push(rec); monthIdx.set(row.subdomain, monthly.rows.length - 1); }

    // consecutive_dead counts MONTHS, so a re-run inside the same month must
    // not increment it again.
    const prevStatus = row.status;
    const sameMonth = (row.last_checked || "").startsWith(month);
    const isDead = (s) => s === "dead" || s === "http_404" || s === "http_410";
    row.last_checked = d;
    row.status = r.status;
    if (r.status.startsWith("alive")) {
      row.last_alive = d;
      row.consecutive_dead = "0";
      if (r.listing_count !== "") row.last_listing_count = r.listing_count;
    } else if (isDead(r.status) && !(sameMonth && isDead(prevStatus))) {
      row.consecutive_dead = String(parseInt(row.consecutive_dead || "0", 10) + 1);
    }
    const bucket = r.status.startsWith("redirect:") ? "redirect_other" : r.status;
    tally[bucket] = (tally[bucket] ?? 0) + 1;
    return r;
  }, (done, total) => {
    if (done % 25 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
    if (++sinceSave >= 500) { save(); sinceSave = 0; }
  });

  save();

  // ── Summary ───────────────────────────────────────────────────────────────
  const alive = customers.rows.filter(r => r.status === "alive" || r.status === "alive_nolistings").length;
  const withListings = monthly.rows.filter(r => r.month === month && r.status === "alive");
  const totalListings = withListings.reduce((s, r) => s + (parseInt(r.listing_count || "0", 10) || 0), 0);
  const deadNow = customers.rows.filter(r => r.status === "dead").length;
  const dead2 = customers.rows.filter(r => parseInt(r.consecutive_dead || "0", 10) >= 2).length;

  const lines = [];
  lines.push(`## Census poll ${d} (${month})`);
  lines.push("");
  lines.push(`Polled ${targets.length} subdomains. Panel: ${customers.rows.length} known, ${alive} alive, ${deadNow} dead this poll, ${dead2} dead for 2+ consecutive polls.`);
  lines.push(`Active listings across alive customers: ${totalListings} (over ${withListings.length} customers with a public listings page).`);
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
  const summary = lines.join("\n") + "\n";
  log("\n\n" + summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

main().catch(err => { console.error(err); process.exit(1); });
