#!/usr/bin/env node
/**
 * portal-detector.js — standalone manual re-detection utility.
 *
 * Re-processes partners whose portal_type is Unknown, None, Confirmed None,
 * Error, or blank. Useful for one-off runs outside the weekly schedule.
 *
 * For the automated weekly pipeline, portal detection is now integrated
 * directly into scraper.js.
 *
 * Usage:
 *   node portal-detector.js          — process all unresolved rows
 *   node portal-detector.js --limit 5  — process at most 5 rows (for testing)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  REPROCESS_TYPES,
  launchBrowser,
  processRow,
} from "./portal-lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, "partners.csv");

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

const CONCURRENCY = 3;

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

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CSV_PATH)) { console.error("partners.csv not found."); process.exit(1); }

  const content = fs.readFileSync(CSV_PATH, "utf8");
  let { header, rows } = parseCsv(content);

  for (const col of [
    "partner_website", "portal_detected", "portal_type", "portal_url",
    "owner_portal_type", "owner_portal_url", "detection_method", "date_portal_detected",
  ]) { if (!header.includes(col)) header.push(col); }

  let toProcess = rows.filter(r => REPROCESS_TYPES.has(r.portal_type ?? ""));
  if (LIMIT < Infinity) toProcess = toProcess.slice(0, LIMIT);

  const skipped = rows.length - rows.filter(r => REPROCESS_TYPES.has(r.portal_type ?? "")).length;
  console.log(`Partners to process: ${toProcess.length}  (${skipped} skipped — already confirmed)`);
  if (!toProcess.length) { console.log("Nothing to process."); return; }

  const browser = await launchBrowser();
  let done = 0;

  try {
    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const batch = toProcess.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(r => processRow(browser, r)));

      for (const updated of results) {
        // Preserve or set date_portal_detected
        const original = rows.find(r => r.url_slug === updated.url_slug);
        if (updated.portal_detected === "true" && !original?.date_portal_detected) {
          updated.date_portal_detected = new Date().toISOString().slice(0, 10);
        } else {
          updated.date_portal_detected = original?.date_portal_detected || "";
        }

        const idx = rows.findIndex(r => r.url_slug === updated.url_slug);
        if (idx !== -1) rows[idx] = updated;
      }

      fs.writeFileSync(CSV_PATH, serializeCsv(header, rows), "utf8");
      done += results.length;
      process.stdout.write(`\r  ${done}/${toProcess.length} processed`);
    }
  } finally {
    await browser.close();
  }

  console.log("\n");

  const tenantCounts = {};
  const ownerCounts  = {};
  for (const row of rows) {
    const pt = row.portal_type || "";
    tenantCounts[pt] = (tenantCounts[pt] ?? 0) + 1;
    if (row.owner_portal_type) ownerCounts[row.owner_portal_type] = (ownerCounts[row.owner_portal_type] ?? 0) + 1;
  }

  const detected = rows.filter(r => r.portal_detected === "true").length;
  console.log("=".repeat(45));
  console.log(`Total partners:         ${rows.length}`);
  console.log(`Portal detected:        ${detected} (${Math.round(detected / rows.length * 100)}%)`);
  console.log("\nTenant portal breakdown:");
  for (const [type, count] of Object.entries(tenantCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(26)} ${count}`);
  }
  if (Object.keys(ownerCounts).length) {
    console.log("\nOwner portal breakdown:");
    for (const [type, count] of Object.entries(ownerCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type.padEnd(26)} ${count}`);
    }
  }
  console.log(`\nOutput: ${CSV_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
