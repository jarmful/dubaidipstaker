#!/usr/bin/env node
/**
 * Fetches price, market cap, day change and 7-day history for every company
 * in scripts/tickers.json from Yahoo Finance, converts everything to USD and
 * writes companies/data/companies.json (sorted by market cap, rank assigned).
 *
 * Zero dependencies — needs Node 18+ (global fetch). Run from the repo root:
 *   node scripts/update-companies.mjs
 *
 * Designed to run in the scheduled GitHub Action (.github/workflows/
 * update-companies.yml). If a symbol fails, its previous entry from the
 * existing data file is kept so one bad ticker never blanks the site.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TICKERS_FILE = join(ROOT, "scripts", "tickers.json");
const OUT_FILE = join(ROOT, "companies", "data", "companies.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSession() {
  // Yahoo's quote API wants a session cookie + crumb.
  const res = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes("{")) throw new Error("could not obtain Yahoo crumb");
  return { cookie, crumb };
}

async function getQuotes(symbols, session) {
  const out = new Map();
  // Batch to stay well under URL length limits.
  for (let i = 0; i < symbols.length; i += 40) {
    const batch = symbols.slice(i, i + 40);
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(batch.join(",")) +
      "&crumb=" +
      encodeURIComponent(session.crumb);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: session.cookie },
    });
    if (!res.ok) throw new Error(`quote request failed: HTTP ${res.status}`);
    const json = await res.json();
    for (const q of json?.quoteResponse?.result ?? []) out.set(q.symbol, q);
    await sleep(300);
  }
  return out;
}

async function getSpark(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    "?range=7d&interval=90m";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const json = await res.json();
  const closes = (json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter(
    (v) => typeof v === "number"
  );
  if (closes.length < 2) return null;
  // Downsample to ~28 points; plenty for a sparkline, keeps the JSON small.
  const step = Math.max(1, Math.floor(closes.length / 28));
  const spark = closes.filter((_, idx) => idx % step === 0).map((v) => +v.toPrecision(5));
  if (spark[spark.length - 1] !== +closes[closes.length - 1].toPrecision(5)) {
    spark.push(+closes[closes.length - 1].toPrecision(5));
  }
  const changePct7d = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  return { spark, changePct7d: +changePct7d.toFixed(2) };
}

async function getFxRates(currencies, session) {
  const rates = { USD: 1 };
  const need = [...currencies].filter((c) => c && c !== "USD");
  if (!need.length) return rates;
  const quotes = await getQuotes(need.map((c) => `${c}USD=X`), session);
  for (const c of need) {
    const q = quotes.get(`${c}USD=X`);
    if (q?.regularMarketPrice) rates[c] = q.regularMarketPrice;
  }
  return rates;
}

function loadPrevious() {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, "utf8"));
    return new Map(prev.companies.map((c) => [c.symbol, c]));
  } catch {
    return new Map();
  }
}

const { companies: tickers } = JSON.parse(readFileSync(TICKERS_FILE, "utf8"));
const previous = loadPrevious();
const session = await getSession();
const quotes = await getQuotes(tickers.map((t) => t.symbol), session);
const fx = await getFxRates(
  new Set([...quotes.values()].map((q) => q.currency)),
  session
);

const rows = [];
for (const t of tickers) {
  const q = quotes.get(t.symbol);
  const rate = q ? fx[q.currency] : undefined;
  if (!q?.marketCap || !rate) {
    const prev = previous.get(t.symbol);
    if (prev) {
      console.warn(`! ${t.symbol}: no fresh data, keeping previous entry`);
      rows.push(prev);
    } else {
      console.warn(`! ${t.symbol}: no data, skipped`);
    }
    continue;
  }
  let sparkInfo = null;
  try {
    sparkInfo = await getSpark(t.symbol);
  } catch {
    /* sparkline is optional */
  }
  await sleep(250);
  rows.push({
    symbol: t.symbol,
    name: t.name,
    country: t.country,
    sector: t.sector,
    nativeCurrency: q.currency,
    priceUsd: +(q.regularMarketPrice * rate).toFixed(2),
    marketCapUsd: Math.round(q.marketCap * rate),
    changePct1d: q.regularMarketChangePercent != null ? +q.regularMarketChangePercent.toFixed(2) : null,
    changePct7d: sparkInfo?.changePct7d ?? null,
    spark: sparkInfo?.spark ?? null,
  });
  console.log(`✓ ${t.symbol}`);
}

rows.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
rows.forEach((r, i) => (r.rank = i + 1));

const out = {
  updated: new Date().toISOString(),
  source: "Yahoo Finance",
  note: "All values converted to USD. Generated by scripts/update-companies.mjs.",
  companies: rows,
};

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(out, null, 1) + "\n");
console.log(`\nWrote ${rows.length} companies to ${OUT_FILE}`);
