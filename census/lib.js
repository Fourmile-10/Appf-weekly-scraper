/**
 * census/lib.js — shared helpers for the AppFolio customer census.
 */

import fs from "fs";

export const CUSTOMERS_COLUMNS = [
  "subdomain", "first_seen", "sources", "status", "last_alive", "last_checked",
  "consecutive_dead", "last_listing_count",
];

export const MONTHLY_COLUMNS = [
  "month", "subdomain", "status", "http_status", "listing_count", "checked_at",
];

// Subdomains that are AppFolio infrastructure, not customers.
export const NON_CUSTOMER_SUBDOMAINS = new Set([
  "www", "account", "accounts", "help", "support", "api", "apis", "mail", "email",
  "assets", "static", "cdn", "blog", "status", "login", "investors", "investor",
  "careers", "jobs", "go", "info", "learn", "community", "ir", "app", "apps",
  "my", "secure", "dev", "test", "staging", "stage", "qa", "demo", "sandbox",
  "docs", "developer", "developers", "partners", "partner", "marketplace",
  "stack", "realm", "insights", "events", "webinar", "webinars", "resources",
  "pay", "payments", "mx", "ns1", "ns2", "autodiscover", "sip", "lyncdiscover",
  "msoid", "enterpriseenrollment", "enterpriseregistration", "ftp", "smtp",
  "imap", "pop", "vpn", "remote", "owa", "exchange", "sso", "auth", "id",
  "identity", "oauth", "shop", "store", "press", "news", "media", "m", "mobile",
  "beta", "alpha", "canary", "preview", "legal", "privacy", "security", "trust",
  "university", "academy", "training", "forum", "forums", "ideas", "feedback",
  "survey", "surveys", "email-us", "email-updates", "team", "teams", "corp",
  "corporate", "intranet", "wiki", "git", "github", "jenkins", "ci", "monitor",
  "monitoring", "metrics", "grafana", "kibana", "logs", "sentry", "cloud",
  "aws", "gcp", "azure", "k8s", "kube", "docker", "registry", "artifactory",
  "npm", "pypi", "maven", "nexus", "sonar", "vault", "consul", "nomad",
  "appfolio", "appfolioinc", "propertymanager", "property-manager",
  "investmentmanagement", "investment-management", "smartmaintenance",
]);
// Anything else is kept: the poller decides whether a subdomain actually
// serves a customer listings page, so a false positive here costs nothing.

export const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function extractSubdomain(urlOrHost) {
  try {
    let host = urlOrHost;
    if (/^https?:\/\//i.test(host)) host = new URL(host).hostname;
    host = host.toLowerCase().replace(/\.$/, "");
    const m = host.match(/^([a-z0-9-]+)\.appfolio\.com$/);
    if (!m) return null;
    const sub = m[1];
    if (!SUBDOMAIN_RE.test(sub)) return null;
    if (NON_CUSTOMER_SUBDOMAINS.has(sub)) return null;
    return sub;
  } catch {
    return null;
  }
}

// ── CSV ────────────────────────────────────────────────────────────────────

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

export function parseCsv(content) {
  const lines = content.replace(/^﻿/, "").trimEnd().split(/\r?\n/);
  if (!lines[0]) return { header: [], rows: [] };
  const header = splitCsvLine(lines[0]).map(h => h.trim());
  const rows = lines.slice(1).filter(l => l.length).map(line => {
    const fields = splitCsvLine(line);
    const obj = {};
    header.forEach((h, i) => (obj[h] = (fields[i] ?? "").trim()));
    return obj;
  });
  return { header, rows };
}

export function escapeCsvField(val) {
  val = String(val ?? "");
  if (val.includes('"')) val = val.replace(/"/g, '""');
  if (val.includes(",") || val.includes('"') || val.includes("\n")) return `"${val}"`;
  return val;
}

export function serializeCsv(header, rows) {
  const lines = [header.join(",")];
  for (const row of rows) lines.push(header.map(h => escapeCsvField(row[h] ?? "")).join(","));
  return lines.join("\n") + "\n";
}

export function loadCsv(csvPath, defaultHeader) {
  if (!fs.existsSync(csvPath)) return { header: [...defaultHeader], rows: [] };
  const parsed = parseCsv(fs.readFileSync(csvPath, "utf8"));
  if (!parsed.header.length) return { header: [...defaultHeader], rows: [] };
  for (const col of defaultHeader) if (!parsed.header.includes(col)) parsed.header.push(col);
  return parsed;
}

// Run log committed with the CSVs, since Actions logs are not always reachable.
import path from "path";
import { fileURLToPath } from "url";
const RUN_LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "run_log.md");
export function resetRunLog(title) { fs.writeFileSync(RUN_LOG, `# ${title}\n\n`, "utf8"); }
export function log(...parts) {
  const line = parts.join(" ");
  console.log(line);
  try { fs.appendFileSync(RUN_LOG, line.replace(/\r/g, "") + "\n"); } catch {}
}

export const today = () => new Date().toISOString().slice(0, 10);
export const thisMonth = () => new Date().toISOString().slice(0, 7);

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fetch with timeout + retry on 429/5xx/network error
export async function fetchRetry(url, { tries = 4, timeout = 30_000, backoff = 2000, ...opts } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { "user-agent": UA, ...(opts.headers || {}) } });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        const ra = parseInt(res.headers.get("retry-after") || "0", 10);
        await sleep(Math.max(ra * 1000, backoff * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      await sleep(backoff * (i + 1));
    }
  }
  throw lastErr;
}

export const UA = "Mozilla/5.0 (compatible; appf-census/1.0; research use; contact via GitHub)";

// Simple concurrency pool
export async function pool(items, concurrency, worker, onProgress) {
  let idx = 0; let done = 0;
  const results = new Array(items.length);
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await worker(items[i], i); }
      catch (err) { results[i] = { error: err.message }; }
      done++;
      if (onProgress) onProgress(done, items.length, results[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
