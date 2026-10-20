#!/usr/bin/env node
/**
 * quarterly-recheck.js — quarterly PMS churn check across the whole panel.
 *
 * The weekly scraper only runs portal detection on NEW partners and on rows
 * that never got a confirmed portal. Once a partner is tagged "AppFolio" it is
 * never looked at again, so a PM that migrates to Rentvine would still show as
 * AppFolio forever. This script re-runs portal detection on every partner with
 * a confirmed PMS and records what changed.
 *
 * Outputs (all committed to the repo):
 *   partners.csv          — current state, one row per partner (unchanged
 *                           layout; only portal_* columns are updated on a
 *                           confirmed switch, plus date_last_verified)
 *   portal_history.csv    — long-format log, one row per partner per check
 *   portal_changes.csv    — one row per confirmed PMS switch (the churn log)
 *
 * Rules to avoid false churn signals:
 *   - A result of Error / Confirmed None / "Likely: ..." never overwrites a
 *     confirmed PMS. It is logged in history as "unverified" and the row keeps
 *     its old value.
 *   - Payment / leasing add-ons (Zego, ClickPay, Paymentus, ShowMojo, Rently,
 *     Funnel, Livly, SmartRent) are not a PMS. If one is detected where a PMS
 *     was previously confirmed, it is logged as "ambiguous", not a switch.
 *   - A detected switch is re-run once; it only counts if both runs agree.
 *
 * Resumable: rows whose date_last_verified is on/after the start of the
 * current quarter are skipped, so a timed-out job can simply be re-run.
 *
 * Usage:
 *   node quarterly-recheck.js              — full panel
 *   node quarterly-recheck.js --limit 10   — first 10 eligible rows (testing)
 *   node quarterly-recheck.js --slug foo   — one partner by url_slug
 *   node quarterly-recheck.js --force      — ignore the resume skip
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  REPROCESS_TYPES,
  launchBrowser,
  detectPortals,
} from "./portal-lib.js";

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const PARTNERS_CSV  = path.join(__dirname, "partners.csv");
const HISTORY_CSV   = path.join(__dirname, "portal_history.csv");
const CHANGES_CSV   = path.join(__dirname, "portal_changes.csv");

const HISTORY_COLUMNS = [
  "check_date", "url_slug", "partner_name", "partner_website",
  "previous_portal_type", "detected_portal_type", "detected_portal_url",
  "detection_method", "status",
];
const CHANGES_COLUMNS = [
  "change_date", "url_slug", "partner_name", "partner_website",
  "from_portal_type", "to_portal_type", "evidence_url", "detection_method",
];

// Real property management systems. Anything detected outside this set is an
// add-on (payments, showings, leasing) and cannot by itself prove a switch.
const PMS_TYPES = new Set([
  "AppFolio", "Rentvine", "Buildium", "Propertyware", "Yardi", "Entrata",
  "RealPage", "ResMan", "Rent Manager", "TenantCloud", "DoorLoop",
  "TurboTenant", "Avail", "Hemlane", "MRI Software", "Rentec Direct",
  "PayProp", "Cozy",
]);

const CONCURRENCY = parseInt(process.env.RECHECK_CONCURRENCY || "5", 10);

const args = process.argv.slice(2);
const argVal = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const LIMIT = argVal("--limit") ? parseInt(argVal("--limit"), 10) : Infinity;
const ONLY_SLUG = argVal("--slug");
const FORCE = args.includes("--force");

// ── CSV helpers (same dialect as scraper.js) ───────────────────────────────

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
  if (!lines[0]) return { header: [], rows: [] };
  const header = lines[0].split(",").map(h => h.trim());
  const rows = lines.slice(1).filter(l => l.length).map(line => {
    const fields = splitCsvLine(line);
    const obj = {};
    header.forEach((h, i) => (obj[h] = (fields[i] ?? "").trim()));
    return obj;
  });
  return { header, rows };
}

function escapeCsvField(val) {
  val = String(val ?? "");
  if (val.includes('"')) val = val.replace(/"/g, '""');
  if (val.includes(",") || val.includes('"') || val.includes("\n")) return `"${val}"`;
  return val;
}

function serializeCsv(header, rows) {
  const lines = [header.join(",")];
  for (const row of rows) lines.push(header.map(h => escapeCsvField(row[h] ?? "")).join(","));
  return lines.join("\n") + "\n";
}

function loadCsv(csvPath, defaultHeader) {
  if (!fs.existsSync(csvPath)) return { header: [...defaultHeader], rows: [] };
  const parsed = parseCsv(fs.readFileSync(csvPath, "utf8"));
  if (!parsed.header.length) return { header: [...defaultHeader], rows: [] };
  for (const col of defaultHeader) if (!parsed.header.includes(col)) parsed.header.push(col);
  return parsed;
}

const today = () => new Date().toISOString().slice(0, 10);

function quarterStart(d = new Date()) {
  const m = d.getUTCMonth();
  return new Date(Date.UTC(d.getUTCFullYear(), m - (m % 3), 1)).toISOString().slice(0, 10);
}

// ── Classification of a fresh detection against the stored value ───────────

function classify(previous, result) {
  const detected = result.portal_type || "";
  if (!result.portal_detected || result.portal_detected !== "true") return "unverified";
  if (REPROCESS_TYPES.has(detected) || detected.startsWith("Likely:")) return "unverified";
  if (detected === previous) return "confirmed";
  if (!PMS_TYPES.has(detected)) return "ambiguous";   // add-on found, PMS not re-seen
  return "changed";
}

async function recheckOne(browser, row) {
  const page = await browser.newPage();
  try {
    let result = await detectPortals(page, row.partner_website);
    let status = classify(row.portal_type, result);

    // A switch must survive a second, independent look.
    if (status === "changed") {
      const second = await detectPortals(page, row.partner_website);
      const secondStatus = classify(row.portal_type, second);
      if (secondStatus === "changed" && second.portal_type === result.portal_type) {
        result = second;
      } else if (secondStatus === "confirmed") {
        result = second; status = "confirmed";
      } else {
        status = "ambiguous";
      }
    }
    return { result, status };
  } catch (err) {
    return {
      result: { portal_detected: "false", portal_type: "Error", portal_url: "",
                owner_portal_type: "", owner_portal_url: "",
                detection_method: err.message.slice(0, 100) },
      status: "unverified",
    };
  } finally {
    await page.close();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(PARTNERS_CSV)) { console.error("partners.csv not found."); process.exit(1); }

  const partners = loadCsv(PARTNERS_CSV, []);
  if (!partners.header.includes("date_last_verified")) partners.header.push("date_last_verified");
  const history  = loadCsv(HISTORY_CSV, HISTORY_COLUMNS);
  const changes  = loadCsv(CHANGES_CSV, CHANGES_COLUMNS);

  const qStart = quarterStart();
  const runDate = today();

  // Eligible: has a website and a confirmed PMS (the weekly job already
  // retries everything else). Skip rows already verified this quarter.
  let eligible = partners.rows.filter(r =>
    r.partner_website &&
    r.portal_detected === "true" &&
    PMS_TYPES.has(r.portal_type) &&
    (FORCE || !r.date_last_verified || r.date_last_verified < qStart)
  );
  if (ONLY_SLUG) eligible = partners.rows.filter(r => r.url_slug === ONLY_SLUG);
  if (LIMIT < Infinity) eligible = eligible.slice(0, LIMIT);

  const alreadyDone = partners.rows.filter(r => r.date_last_verified && r.date_last_verified >= qStart).length;
  console.log(`Quarter starting ${qStart}. Run date ${runDate}.`);
  console.log(`Rows to recheck: ${eligible.length}  (${alreadyDone} already verified this quarter)`);
  if (!eligible.length) { console.log("Nothing to do."); return; }

  const browser = await launchBrowser();
  const tally = { confirmed: 0, changed: 0, ambiguous: 0, unverified: 0 };
  const transitions = {};
  let done = 0;

  const save = () => {
    fs.writeFileSync(PARTNERS_CSV, serializeCsv(partners.header, partners.rows), "utf8");
    fs.writeFileSync(HISTORY_CSV,  serializeCsv(history.header,  history.rows),  "utf8");
    fs.writeFileSync(CHANGES_CSV,  serializeCsv(changes.header,  changes.rows),  "utf8");
  };

  try {
    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
      const batch = eligible.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(r => recheckOne(browser, r)));

      batch.forEach((row, k) => {
        const { result, status } = results[k];
        tally[status]++;

        history.rows.push({
          check_date: runDate,
          url_slug: row.url_slug,
          partner_name: row.partner_name,
          partner_website: row.partner_website,
          previous_portal_type: row.portal_type,
          detected_portal_type: result.portal_type || "",
          detected_portal_url: result.portal_url || "",
          detection_method: result.detection_method || "",
          status,
        });

        if (status === "changed") {
          const key = `${row.portal_type} → ${result.portal_type}`;
          transitions[key] = (transitions[key] ?? 0) + 1;
          changes.rows.push({
            change_date: runDate,
            url_slug: row.url_slug,
            partner_name: row.partner_name,
            partner_website: row.partner_website,
            from_portal_type: row.portal_type,
            to_portal_type: result.portal_type,
            evidence_url: result.portal_url || "",
            detection_method: result.detection_method || "",
          });
          row.portal_type       = result.portal_type;
          row.portal_url        = result.portal_url || "";
          row.owner_portal_type = result.owner_portal_type || row.owner_portal_type;
          row.owner_portal_url  = result.owner_portal_url  || row.owner_portal_url;
          row.detection_method  = result.detection_method || "";
          console.log(`\n  SWITCH  ${row.partner_name}: ${key}  (${result.portal_url})`);
        }

        // Confirmed and changed rows are verified. Ambiguous and unverified
        // rows keep their old value but are also stamped so the job can resume
        // past them; the history row records that they were not verified.
        row.date_last_verified = runDate;
      });

      save();
      done += batch.length;
      process.stdout.write(`\r  ${done}/${eligible.length} rechecked`);
    }
  } finally {
    await browser.close();
    save();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const share = {};
  for (const r of partners.rows) {
    const t = PMS_TYPES.has(r.portal_type) ? r.portal_type : "Other / unresolved";
    share[t] = (share[t] ?? 0) + 1;
  }
  const total = partners.rows.length;

  const lines = [];
  lines.push(`## Quarterly PMS recheck ${runDate}`);
  lines.push("");
  lines.push(`Rechecked ${eligible.length} partners: ${tally.confirmed} confirmed, ${tally.changed} switched, ${tally.ambiguous} ambiguous, ${tally.unverified} unverified (site down or portal not found).`);
  lines.push("");
  if (Object.keys(transitions).length) {
    lines.push("### Switches");
    for (const [k, v] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
    lines.push("");
    lines.push("| Partner | From | To | Evidence |");
    lines.push("|---|---|---|---|");
    for (const c of changes.rows.filter(c => c.change_date === runDate)) {
      lines.push(`| ${c.partner_name} | ${c.from_portal_type} | ${c.to_portal_type} | ${c.evidence_url} |`);
    }
    lines.push("");
  } else {
    lines.push("No confirmed PMS switches this quarter.");
    lines.push("");
  }
  lines.push("### Panel share (all partners)");
  lines.push("| PMS | Partners | Share |");
  lines.push("|---|---|---|");
  for (const [t, n] of Object.entries(share).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${t} | ${n} | ${(n / total * 100).toFixed(1)}% |`);
  }
  const summary = lines.join("\n") + "\n";

  console.log("\n\n" + summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

main().catch(err => { console.error(err); process.exit(1); });
