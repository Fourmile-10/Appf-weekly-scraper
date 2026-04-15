/**
 * portal-lib.js — shared portal detection library.
 *
 * Imported by both scraper.js (for inline detection of new/retry rows)
 * and portal-detector.js (for standalone manual re-detection runs).
 *
 * All functions are pure async — callers supply the Playwright browser/page.
 */

import { chromium } from "playwright";

// ── Portal domain signatures (URL-based) ──────────────────────────────────

export const PORTAL_DOMAINS = {
  "appfolio.com":       "AppFolio",
  "rentvine.com":       "Rentvine",
  "managebuilding.com": "Buildium",
  "buildium.com":       "Buildium",
  "liverez.com":        "Buildium",
  "propertyware.com":   "Propertyware",
  "pwentry.com":        "Propertyware",
  "yardi.com":          "Yardi",
  "yardirentcafe.com":  "Yardi",
  "rentcafe.com":       "Yardi",
  "entrata.com":        "Entrata",
  "realpage.com":       "RealPage",
  "onsite.com":         "RealPage",
  "leasestar.com":      "RealPage",
  "resman.com":         "ResMan",
  "myresman.com":       "ResMan",
  "rentmanager.com":    "Rent Manager",
  "rmtenant.com":       "Rent Manager",
  "tenantcloud.com":    "TenantCloud",
  "doorloop.com":       "DoorLoop",
  "turbotenant.com":    "TurboTenant",
  "avail.co":           "Avail",
  "hemlane.com":        "Hemlane",
  "mrisoftware.com":    "MRI Software",
  "mrinetwork.com":     "MRI Software",
  "paylease.com":       "PayLease/Zego",
  "gozego.com":         "PayLease/Zego",
  "cozy.co":            "Cozy",
  "smartrent.com":      "SmartRent",
  "paymentus.com":      "Paymentus",
  "clickpay.com":       "ClickPay",
  "livly.io":           "Livly",
  "funnelleasing.com":  "Funnel Leasing",
  "rently.com":         "Rently",
  "showmojo.com":       "ShowMojo",
  "rentecdirect.com":   "Rentec Direct",
  "payprop.com":        "PayProp",
};

// Content patterns — identify PMS from page branding / HTML text
export const CONTENT_PATTERNS = [
  { re: /appfolio/i,                     name: "AppFolio" },
  { re: /rentvine/i,                     name: "Rentvine" },
  { re: /buildium|managebuilding/i,      name: "Buildium" },
  { re: /propertyware|pwentry/i,         name: "Propertyware" },
  { re: /yardirentcafe|rentcafe|yardi/i, name: "Yardi" },
  { re: /\bentrata\b/i,                  name: "Entrata" },
  { re: /realpage/i,                     name: "RealPage" },
  { re: /myresman|\bresman\b/i,          name: "ResMan" },
  { re: /rmtenant|rentmanager/i,         name: "Rent Manager" },
  { re: /\bdoorloop\b/i,                 name: "DoorLoop" },
  { re: /turbotenant/i,                  name: "TurboTenant" },
  { re: /\bhemlane\b/i,                  name: "Hemlane" },
  { re: /mrisoftware|mrinetwork/i,       name: "MRI Software" },
  { re: /paylease|gozego|\bzego\b/i,     name: "PayLease/Zego" },
  { re: /tenantcloud/i,                  name: "TenantCloud" },
  { re: /smartrent/i,                    name: "SmartRent" },
  { re: /paymentus/i,                    name: "Paymentus" },
  { re: /clickpay/i,                     name: "ClickPay" },
  { re: /\blivly\b/i,                    name: "Livly" },
  { re: /funnel\s*leasing/i,             name: "Funnel Leasing" },
  { re: /\brently\b/i,                   name: "Rently" },
  { re: /showmojo/i,                     name: "ShowMojo" },
  { re: /rentecdirect/i,                 name: "Rentec Direct" },
  { re: /\bpayprop\b/i,                  name: "PayProp" },
  { re: /corelogic/i,                    name: "CoreLogic" },
  { re: /\bavail\b/i,                    name: "Avail" },
  { re: /\bcozy\.co\b/i,                 name: "Cozy" },
];

// Tenant keywords ordered high → low specificity
export const TENANT_PRIORITY = [
  "pay rent", "pay now", "pay online", "make a payment", "make payment",
  "online payment", "renter portal", "tenant portal", "tenant login",
  "tenant log in", "tenant access", "resident portal", "resident login",
  "resident log in", "resident access", "resident services", "online portal",
  "apply now", "apply online", "apply here",
  "residents", "current residents", "existing residents", "tenants",
  "my account", "login", "log in", "sign in", "apply",
];

export const TENANT_RE = new RegExp(
  TENANT_PRIORITY.map(k => k.replace(/[\s-]+/g, "[\\s\\-]*")).join("|"),
  "i"
);

export const OWNER_RE =
  /owner[\s-]*portal|owner[\s-]*log[\s-]*in|owner[\s-]*access|investor[\s-]*log[\s-]*in|property\s+owner[s]?|owner\s+services|owner\s+statement|owner\s+reports|owners|investors/i;

// Domains to skip when finding the PM's website on their SecondNature page
export const SKIP_DOMAINS = [
  "secondnature.com", "facebook.com", "twitter.com", "x.com",
  "linkedin.com", "instagram.com", "youtube.com", "yelp.com",
  "google.com", "hubspot.com", "hs-sites.com", "hubspotlinks.com",
];

// Direct URL paths to probe when element search finds nothing
export const PROBE_PATHS = [
  "/residents", "/resident-portal", "/resident-login", "/resident-services",
  "/tenants", "/tenant-portal", "/tenant-login",
  "/owners", "/owner-portal", "/owner-login",
  "/login", "/portal", "/pay", "/pay-rent", "/payments",
  "/apply", "/application",
];

// portal_type values that should be retried each week
export const REPROCESS_TYPES = new Set([
  "Unknown", "None", "Confirmed None", "Error", "",
]);

const NAV_TIMEOUT  = 20_000;
const PROBE_TIMEOUT = 10_000;

// ── URL classification ─────────────────────────────────────────────────────

export function classifyUrl(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  for (const [domain, name] of Object.entries(PORTAL_DOMAINS)) {
    if (lower.includes(domain)) return name;
  }
  return null;
}

// ── Content-based PMS identification ─────────────────────────────────────

export async function identifyFromContent(page) {
  try {
    const [title, html] = await Promise.all([page.title(), page.content()]);
    const text = (title + " " + html).slice(0, 80_000);
    for (const { re, name } of CONTENT_PATTERNS) {
      if (re.test(text)) return name;
    }
  } catch {}
  return null;
}

// ── Expand dropdown menus ─────────────────────────────────────────────────

export async function expandAllDropdowns(page) {
  try {
    const triggers = await page.$$(
      "nav li > a, nav li > button, header li > a, header li > button, " +
      "[class*='menu-item'] > a, [class*='nav-item'] > a, " +
      "[class*='dropdown'] > a, [class*='dropdown'] > button"
    );
    for (const t of triggers.slice(0, 50)) {
      try { await t.hover({ force: true, timeout: 500 }); } catch {}
    }
    await page.waitForTimeout(350);
  } catch {}
}

// ── Element discovery ─────────────────────────────────────────────────────

export async function findPortalElements(page) {
  return await page.evaluate(({ tenantReSrc, ownerReSrc, tenantPriority }) => {
    const tenantRe = new RegExp(tenantReSrc, "i");
    const ownerRe  = new RegExp(ownerReSrc,  "i");
    const seen = new Set();
    const results = [];

    const processEl = (el) => {
      const rawText = (
        el.textContent?.trim() ||
        el.getAttribute?.("value") ||
        el.getAttribute?.("aria-label") ||
        el.getAttribute?.("title") || ""
      ).replace(/\s+/g, " ").trim();

      if (!rawText || rawText.length > 120) return;
      const isTenant = tenantRe.test(rawText);
      const isOwner  = ownerRe.test(rawText);
      if (!isTenant && !isOwner) return;

      let href = "";
      if (el.tagName === "A") href = el.href || "";
      if (!href) {
        const onclick = el.getAttribute?.("onclick") || "";
        const m = onclick.match(/['"]((https?:\/\/|\/)[^'"]{4,})['"]/);
        if (m) href = m[1].startsWith("/") ? location.origin + m[1] : m[1];
      }
      if (!href) href = el.getAttribute?.("data-href") || el.getAttribute?.("data-url") || "";
      if (!href) { const pa = el.closest?.("a[href]"); if (pa) href = pa.href || ""; }

      if (!href || /^(javascript:|#|mailto:|tel:)/.test(href) || href === location.href) return;
      if (seen.has(href)) return;
      seen.add(href);

      const textLower = rawText.toLowerCase();
      let priority = tenantPriority.length;
      for (let i = 0; i < tenantPriority.length; i++) {
        if (textLower.includes(tenantPriority[i])) { priority = i; break; }
      }

      results.push({
        text: rawText.slice(0, 80),
        href,
        elementType: el.tagName === "A" ? "link" : "button",
        portalSide: isTenant ? "tenant" : "owner",
        priority,
      });
    };

    for (const el of document.querySelectorAll("a[href]")) processEl(el);
    for (const el of document.querySelectorAll(
      'button, [role="button"], input[type="submit"], input[type="button"]'
    )) processEl(el);

    return results.sort((a, b) => a.priority - b.priority);
  }, { tenantReSrc: TENANT_RE.source, ownerReSrc: OWNER_RE.source, tenantPriority: TENANT_PRIORITY });
}

// ── Page source scan ──────────────────────────────────────────────────────

export async function scanPageSource(page) {
  const html = await page.content();
  const lower = html.toLowerCase();
  const found = [];
  for (const [domain, name] of Object.entries(PORTAL_DOMAINS)) {
    if (lower.includes(domain) && !found.includes(name)) found.push(name);
  }
  return found;
}

// ── Follow a link and classify ────────────────────────────────────────────

export async function followAndClassify(page, href, depth = 0) {
  const staticPortal = classifyUrl(href);
  if (staticPortal) return { portal: staticPortal, finalUrl: href };
  if (!href.startsWith("http")) return null;

  try {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const finalUrl = page.url();

    const dynPortal = classifyUrl(finalUrl);
    if (dynPortal) return { portal: dynPortal, finalUrl };

    const contentPortal = await identifyFromContent(page);
    if (contentPortal) return { portal: contentPortal, finalUrl, fromContent: true };

    if (depth < 1) {
      const subEls = await findPortalElements(page);
      for (const el of subEls.slice(0, 8)) {
        if (!el.href || el.href === href) continue;
        const result = await followAndClassify(page, el.href, depth + 1);
        if (result?.portal) return result;
      }
      const sourcePortals = await scanPageSource(page);
      if (sourcePortals.length > 0) return { portal: sourcePortals[0], finalUrl, fromSource: true };
    }

    return { portal: null, finalUrl };
  } catch {
    return null;
  }
}

// ── Direct URL path probing ───────────────────────────────────────────────

export async function probeDirectPaths(page, baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return null; }

  for (const p of PROBE_PATHS) {
    try {
      const resp = await page.goto(origin + p, { waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT });
      if (!resp || resp.status() >= 400) continue;
      const finalUrl = page.url();
      if (finalUrl === origin || finalUrl === origin + "/" || finalUrl === baseUrl) continue;

      const direct = classifyUrl(finalUrl);
      if (direct) return { portal: direct, finalUrl, method: `direct path ${p}` };

      const contentPortal = await identifyFromContent(page);
      if (contentPortal) return { portal: contentPortal, finalUrl, method: `direct path ${p} (content)` };

      const sourcePortals = await scanPageSource(page);
      if (sourcePortals.length > 0) return { portal: sourcePortals[0], finalUrl, method: `direct path ${p} (source)` };

      const els = await findPortalElements(page);
      for (const el of els.slice(0, 6)) {
        const result = await followAndClassify(page, el.href, 1);
        if (result?.portal) return { ...result, method: `direct path ${p} → ${el.text.toLowerCase()}` };
      }
    } catch {}
  }
  return null;
}

// ── Full portal detection for one website ─────────────────────────────────

export async function detectPortals(page, websiteUrl) {
  const blank = {
    portal_detected: "false",
    portal_type: "Confirmed None",
    portal_url: "",
    owner_portal_type: "",
    owner_portal_url: "",
    detection_method: "exhaustive check — no portal found",
  };

  try {
    await page.goto(websiteUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  } catch {
    return { ...blank, portal_type: "Error", detection_method: "site unreachable" };
  }

  await expandAllDropdowns(page);
  const sourcePortals = await scanPageSource(page);
  const elements = await findPortalElements(page);

  let tenant = null;
  let owner  = null;
  let firstUnclassifiedTenant = null;

  for (const el of elements) {
    if (tenant && owner) break;
    if (!el.href) continue;

    const classified = await followAndClassify(page, el.href);
    if (!classified) continue;

    const methodSuffix = classified.fromContent
      ? " (content match)" : classified.fromSource ? " (source scan)" : "";
    const method = `${el.text.toLowerCase()} (${el.elementType})${methodSuffix}`;

    if (classified.portal) {
      if (el.portalSide === "tenant" && !tenant) {
        tenant = { portal: classified.portal, url: classified.finalUrl, method };
      } else if (el.portalSide === "owner" && !owner) {
        owner = { portal: classified.portal, url: classified.finalUrl };
      }
    } else if (el.portalSide === "tenant" && !firstUnclassifiedTenant && classified.finalUrl) {
      firstUnclassifiedTenant = { url: classified.finalUrl, text: el.text };
    }
  }

  // Fallback 1: source scan on PM site
  if (!tenant && sourcePortals.length > 0) {
    tenant = { portal: sourcePortals[0], url: websiteUrl, method: "page source scan" };
  }

  // Fallback 2: direct path probing
  if (!tenant) {
    const pathResult = await probeDirectPaths(page, websiteUrl);
    if (pathResult) {
      tenant = { portal: pathResult.portal, url: pathResult.finalUrl, method: pathResult.method };
    }
  }

  // Fallback 3: "Likely: domain" educated guess
  if (!tenant && firstUnclassifiedTenant) {
    try {
      const domain = new URL(firstUnclassifiedTenant.url).hostname.replace(/^www\./, "");
      return {
        portal_detected: "true",
        portal_type: `Likely: ${domain}`,
        portal_url: firstUnclassifiedTenant.url,
        owner_portal_type: owner?.portal || "",
        owner_portal_url: owner?.url || "",
        detection_method: `${firstUnclassifiedTenant.text.toLowerCase()} — unidentified portal`,
      };
    } catch {}
  }

  if (!tenant) return { ...blank, owner_portal_type: owner?.portal || "", owner_portal_url: owner?.url || "" };

  return {
    portal_detected: "true",
    portal_type: tenant.portal,
    portal_url: tenant.url,
    owner_portal_type: owner?.portal || "",
    owner_portal_url: owner?.url || "",
    detection_method: tenant.method,
  };
}

// ── Get PM website from SecondNature page ─────────────────────────────────

export async function getPartnerWebsite(page, secondNatureUrl) {
  try {
    await page.goto(secondNatureUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const links = await page.$$eval(
      "a[href]",
      (anchors, skipDomains) =>
        anchors
          .map(a => ({ href: a.href, text: a.textContent.trim().toLowerCase() }))
          .filter(({ href }) => href.startsWith("http") && !skipDomains.some(d => href.includes(d))),
      SKIP_DOMAINS
    );
    if (!links.length) return null;
    const preferred = links.find(({ text }) => /\bvisit\b|\bwebsite\b|\blearn more\b|\bhome ?page\b/.test(text));
    return preferred?.href ?? links[0]?.href ?? null;
  } catch {
    return null;
  }
}

// ── Browser launcher (convenience) ───────────────────────────────────────

export async function launchBrowser() {
  return chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
}

// ── Process a single row through portal detection ─────────────────────────

export async function processRow(browser, row, NAV_TIMEOUT_OVERRIDE) {
  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_OVERRIDE ?? NAV_TIMEOUT);
  try {
    let website = row.partner_website || null;
    if (!website) website = await getPartnerWebsite(page, row.full_url);

    if (!website) {
      return {
        ...row,
        partner_website: "",
        portal_detected: "false",
        portal_type: "Confirmed None",
        portal_url: "",
        owner_portal_type: "",
        owner_portal_url: "",
        detection_method: "no website found",
      };
    }

    const result = await detectPortals(page, website);
    return { ...row, partner_website: website, ...result };
  } catch (err) {
    return {
      ...row,
      partner_website: row.partner_website || "",
      portal_detected: "false",
      portal_type: "Error",
      portal_url: "",
      owner_portal_type: "",
      owner_portal_url: "",
      detection_method: err.message.slice(0, 100),
    };
  } finally {
    await page.close();
  }
}
