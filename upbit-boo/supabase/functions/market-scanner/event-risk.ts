// External event/news risk layer for Trading-booooo v3.2.0.
// Read-only. Uses optional provider keys and always exposes provider coverage.

import type { PeriodAnalysis } from "./engine.ts";

export type EventRiskStatus = "CLEAR" | "REVIEW" | "BLOCK" | "UNKNOWN";
export type EventCategory =
  | "TOKEN_UNLOCK"
  | "LISTING"
  | "DELISTING"
  | "SECURITY_INCIDENT"
  | "PARTNERSHIP"
  | "FOUNDATION_FLOW"
  | "REGULATORY"
  | "NETWORK_EVENT"
  | "OTHER";

export type EventEvidence = {
  category: EventCategory;
  title: string;
  source: string;
  url?: string;
  published_at?: string;
  event_date?: string;
  displayed_date?: string;
  severity: "INFO" | "CAUTION" | "CRITICAL";
  confidence: number;
  matched_terms: string[];
};

export type EventRiskSnapshot = {
  status: EventRiskStatus;
  label: string;
  checked_at: string;
  symbol: string;
  provider_status: Record<string, "OK" | "DISABLED" | "ERROR">;
  coverage_complete: boolean;
  volume_anomaly: boolean;
  volume_ratio_4h: number;
  volume_ratio_day: number;
  evidence: EventEvidence[];
  warnings: string[];
};

type JsonRecord = Record<string, unknown>;

const cache = new Map<string, { expires: number; value: EventRiskSnapshot }>();
const CACHE_MS = 15 * 60_000;
const LOOKBACK_HOURS = 96;
const UNLOCK_LOOKAHEAD_DAYS = 14;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? value as JsonRecord : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function iso(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function withinHours(value: string | undefined, hours: number, now: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= now - hours * 3_600_000 && parsed <= now + 3_600_000;
}

function classify(input: string): { category: EventCategory; severity: EventEvidence["severity"]; terms: string[] } {
  const lower = input.toLowerCase();
  const rules: Array<[EventCategory, EventEvidence["severity"], string[]]> = [
    ["SECURITY_INCIDENT", "CRITICAL", ["hack", "hacked", "exploit", "breach", "drain", "stolen", "attack", "vulnerability", "rug pull", "해킹", "익스플로잇"]],
    ["DELISTING", "CRITICAL", ["delist", "delisting", "trading suspension", "withdrawal suspension", "상장 폐지", "거래 중단"]],
    ["TOKEN_UNLOCK", "CAUTION", ["token unlock", "unlock", "vesting", "cliff", "토큰 언락", "락업 해제"]],
    ["FOUNDATION_FLOW", "CAUTION", ["foundation wallet", "treasury transfer", "team wallet", "whale transfer", "wallet movement", "재단 지갑", "대량 이체"]],
    ["REGULATORY", "CAUTION", ["lawsuit", "sec ", "regulator", "investigation", "ban", "규제", "소송"]],
    ["LISTING", "CAUTION", ["new listing", "will list", "listed on", "launchpool", "상장", "거래 지원"]],
    ["NETWORK_EVENT", "CAUTION", ["mainnet", "hard fork", "upgrade", "migration", "network halt", "메인넷", "하드포크", "업그레이드"]],
    ["PARTNERSHIP", "INFO", ["partnership", "partners with", "integration", "collaboration", "파트너십", "협업"]],
  ];
  for (const [category, severity, terms] of rules) {
    const matched = terms.filter((term) => lower.includes(term));
    if (matched.length) return { category, severity, terms: matched };
  }
  return { category: "OTHER", severity: "INFO", terms: [] };
}

async function fetchJson(url: string, headers: HeadersInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7_500);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json", ...headers } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function newsApiEvidence(symbol: string, name: string, now: number): Promise<EventEvidence[]> {
  const key = (Deno.env.get("NEWSAPI_KEY") || "").trim();
  if (!key) return [];
  const from = new Date(now - LOOKBACK_HOURS * 3_600_000).toISOString();
  const query = `("${name}" OR "${symbol} token" OR "${symbol} crypto") AND (unlock OR listing OR delisting OR hack OR exploit OR partnership OR foundation OR treasury OR lawsuit OR upgrade)`;
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query.slice(0, 490));
  url.searchParams.set("searchIn", "title,description");
  url.searchParams.set("from", from);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "25");
  const data = record(await fetchJson(url.toString(), { "X-Api-Key": key }));
  return array(data?.articles).flatMap((item) => {
    const row = record(item);
    if (!row) return [];
    const title = text(row.title);
    const description = text(row.description);
    const published = iso(row.publishedAt);
    if (!title || !withinHours(published, LOOKBACK_HOURS, now)) return [];
    const classified = classify(`${title} ${description}`);
    if (classified.category === "OTHER") return [];
    return [{
      category: classified.category,
      title,
      source: text(record(row.source)?.name) || "NewsAPI",
      url: text(row.url) || undefined,
      published_at: published,
      severity: classified.severity,
      confidence: classified.terms.length >= 2 ? 0.78 : 0.62,
      matched_terms: classified.terms,
    } satisfies EventEvidence];
  });
}

async function coinMarketCalEvidence(symbol: string, now: number): Promise<EventEvidence[]> {
  const key = (Deno.env.get("COINMARKETCAL_API_KEY") || "").trim();
  if (!key) return [];
  const coinUrl = new URL("https://api.coinmarketcal.com/v2/coins");
  coinUrl.searchParams.set("query", symbol);
  coinUrl.searchParams.set("limit", "10");
  const coinData = record(await fetchJson(coinUrl.toString(), { "x-api-key": key }));
  const exact = array(coinData?.data).map(record).filter(Boolean).find((coin) => text(coin?.symbol).toUpperCase() === symbol.toUpperCase());
  const slug = text(exact?.slug);
  if (!slug) return [];
  const eventUrl = new URL("https://api.coinmarketcal.com/v2/events");
  eventUrl.searchParams.set("coins", slug);
  eventUrl.searchParams.set("from", new Date(now - 24 * 3_600_000).toISOString());
  eventUrl.searchParams.set("to", new Date(now + UNLOCK_LOOKAHEAD_DAYS * 86_400_000).toISOString());
  eventUrl.searchParams.set("limit", "50");
  const eventData = record(await fetchJson(eventUrl.toString(), { "x-api-key": key }));
  return array(eventData?.data).flatMap((item) => {
    const row = record(item);
    if (!row) return [];
    const title = text(row.title);
    const description = text(row.description);
    const categories = array(row.categories).map(text).join(" ");
    const classified = classify(`${title} ${description} ${categories}`);
    if (classified.category === "OTHER") return [];
    const impact = number(row.impact, 0);
    const severity = classified.category === "TOKEN_UNLOCK" && impact >= 7
      ? "CRITICAL"
      : classified.severity;
    return [{
      category: classified.category,
      title,
      source: "CoinMarketCal",
      url: text(row.sourceUrl) || undefined,
      event_date: iso(row.date),
      displayed_date: text(row.displayedDate) || undefined,
      severity,
      confidence: Math.min(0.95, Math.max(0.65, impact ? impact / 10 : 0.72)),
      matched_terms: classified.terms,
    } satisfies EventEvidence];
  });
}

async function customFeedEvidence(symbol: string): Promise<EventEvidence[]> {
  const endpoint = (Deno.env.get("EVENT_FEED_URL") || "").trim();
  if (!endpoint) return [];
  const url = new URL(endpoint);
  url.searchParams.set("symbol", symbol);
  const data = await fetchJson(url.toString(), Deno.env.get("EVENT_FEED_TOKEN")
    ? { Authorization: `Bearer ${Deno.env.get("EVENT_FEED_TOKEN")}` }
    : {});
  const rows = Array.isArray(data) ? data : array(record(data)?.events);
  return rows.flatMap((item) => {
    const row = record(item);
    if (!row) return [];
    const title = text(row.title);
    if (!title) return [];
    const classified = classify(`${title} ${text(row.description)} ${text(row.category)}`);
    return [{
      category: (text(row.category).toUpperCase() as EventCategory) || classified.category,
      title,
      source: text(row.source) || "CUSTOM_FEED",
      url: text(row.url) || undefined,
      published_at: iso(row.published_at),
      event_date: iso(row.event_date),
      displayed_date: text(row.displayed_date) || undefined,
      severity: (["INFO", "CAUTION", "CRITICAL"].includes(text(row.severity).toUpperCase())
        ? text(row.severity).toUpperCase()
        : classified.severity) as EventEvidence["severity"],
      confidence: Math.min(1, Math.max(0, number(row.confidence, 0.8))),
      matched_terms: classified.terms,
    } satisfies EventEvidence];
  });
}

function dedupe(items: EventEvidence[]): EventEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.category}|${item.title.toLowerCase().replace(/\s+/g, " ").slice(0, 160)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    const severity = { CRITICAL: 3, CAUTION: 2, INFO: 1 };
    return severity[b.severity] - severity[a.severity] || b.confidence - a.confidence;
  }).slice(0, 12);
}

export async function assessEventRisk(period: PeriodAnalysis): Promise<EventRiskSnapshot> {
  const symbol = period.universe.market.split("-").pop()?.replace(/USDT$/, "") || period.universe.market;
  const cached = cache.get(symbol);
  if (cached && cached.expires > Date.now()) return cached.value;
  const now = Date.now();
  const providerStatus: EventRiskSnapshot["provider_status"] = {
    NEWSAPI: Deno.env.get("NEWSAPI_KEY") ? "OK" : "DISABLED",
    COINMARKETCAL: Deno.env.get("COINMARKETCAL_API_KEY") ? "OK" : "DISABLED",
    CUSTOM_FEED: Deno.env.get("EVENT_FEED_URL") ? "OK" : "DISABLED",
  };
  const settled = await Promise.allSettled([
    newsApiEvidence(symbol, period.universe.english_name || symbol, now),
    coinMarketCalEvidence(symbol, now),
    customFeedEvidence(symbol),
  ]);
  const providerNames = ["NEWSAPI", "COINMARKETCAL", "CUSTOM_FEED"];
  const evidence: EventEvidence[] = [];
  settled.forEach((result, index) => {
    if (providerStatus[providerNames[index]] === "DISABLED") return;
    if (result.status === "fulfilled") evidence.push(...result.value);
    else providerStatus[providerNames[index]] = "ERROR";
  });
  const unique = dedupe(evidence);
  const volume4h = Number(period.timeframes.h4.volume_ratio || 0);
  const volumeDay = Number(period.timeframes.day.volume_ratio || 0);
  const volumeAnomaly = volume4h >= 8 || volumeDay >= 20;
  const critical = unique.filter((item) => item.severity === "CRITICAL" && item.confidence >= 0.65);
  const caution = unique.filter((item) => item.severity === "CAUTION" && item.confidence >= 0.6);
  const enabled = Object.values(providerStatus).filter((status) => status !== "DISABLED").length;
  const successful = Object.values(providerStatus).filter((status) => status === "OK").length;
  const coverageComplete = enabled > 0 && enabled === successful;
  let status: EventRiskStatus = "CLEAR";
  const warnings: string[] = [];
  if (critical.length) status = "BLOCK";
  else if (caution.length || volumeAnomaly) status = "REVIEW";
  else if (enabled === 0 || successful === 0) status = "UNKNOWN";
  if (volumeAnomaly && unique.length === 0) {
    warnings.push("거래대금 급증 원인을 외부 이벤트 데이터에서 확인하지 못했습니다. 원인 확인 전 신규 진입을 보류합니다.");
  }
  if (!coverageComplete) warnings.push("이벤트 공급자 일부가 비활성 또는 오류 상태라 뉴스·공시 커버리지가 완전하지 않습니다.");
  const value: EventRiskSnapshot = {
    status,
    label: status === "BLOCK" ? "중대 이벤트 위험" : status === "REVIEW" ? "이벤트 원인 확인 필요" : status === "CLEAR" ? "중대 이벤트 미검출" : "이벤트 데이터 미확인",
    checked_at: new Date(now).toISOString(),
    symbol,
    provider_status: providerStatus,
    coverage_complete: coverageComplete,
    volume_anomaly: volumeAnomaly,
    volume_ratio_4h: volume4h,
    volume_ratio_day: volumeDay,
    evidence: unique,
    warnings,
  };
  cache.set(symbol, { expires: now + CACHE_MS, value });
  return value;
}

export function neutralEventRisk(symbol = "UNKNOWN"): EventRiskSnapshot {
  return {
    status: "UNKNOWN",
    label: "이벤트 데이터 미확인",
    checked_at: new Date(0).toISOString(),
    symbol,
    provider_status: {},
    coverage_complete: false,
    volume_anomaly: false,
    volume_ratio_4h: 0,
    volume_ratio_day: 0,
    evidence: [],
    warnings: ["이벤트 위험 데이터가 제공되지 않았습니다."],
  };
}
