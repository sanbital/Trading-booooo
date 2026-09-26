// Runtime loader for market-scanner v7.2.1.
// It patches the previously verified production scanner source at module load so every
// Top-10 symbol receives at least 50 seconds of its own orderbook observation.

const SOURCE_URL =
  "https://raw.githubusercontent.com/sanbital/Trading-booooo/5e1bedc2d37478a27c1fb6e371635de421aebc22/supabase/functions/market-scanner/index.ts";

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`market-scanner source fetch failed: ${response.status} ${response.statusText}`);
}

let source = await response.text();
const replacements: Array<[string, string]> = [
  [
    "// Trading-booooo Market Scanner v7.1.1-LOB-45S-PROFIT-OR-5PCT — Supabase Edge Function",
    "// Trading-booooo Market Scanner v7.2.1-TOP10-PER-MARKET-50S — Supabase Edge Function",
  ],
  [
    "const DEFAULT_DYNAMIC_OBSERVATION_MS = 47_000;",
    "const DEFAULT_DYNAMIC_OBSERVATION_MS = 55_000;",
  ],
  [
    "const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 50_000;",
    "const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 60_000;",
  ],
  [
    "const MIN_DYNAMIC_OBSERVATION_MS = 47_000;",
    "const MIN_DYNAMIC_OBSERVATION_MS = 55_000;",
  ],
  [
    "const MAX_DYNAMIC_OBSERVATION_MS = 50_000;",
    "const MAX_DYNAMIC_OBSERVATION_MS = 60_000;",
  ],
  [
    "const REQUIRED_PER_MARKET_OBSERVATION_MS = 45_000;",
    "const REQUIRED_PER_MARKET_OBSERVATION_MS = 50_000;",
  ],
  [
    "still receive a full 45 seconds. All books use the 47–50 second observation range.",
    "still receive a full 50 seconds. All books use a 55–60 second collector window.",
  ],
  [
    "Every symbol must receive its own full 45-second wall-clock observation window.",
    "Every symbol must receive its own full 50-second wall-clock observation window.",
  ],
];

for (const [oldValue, newValue] of replacements) {
  if (!source.includes(oldValue)) {
    throw new Error(`market-scanner patch anchor missing: ${oldValue}`);
  }
  source = source.replace(oldValue, newValue);
}

const requiredChecks = [
  "const DEFAULT_DYNAMIC_OBSERVATION_MS = 55_000;",
  "const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 60_000;",
  "const MIN_DYNAMIC_OBSERVATION_MS = 55_000;",
  "const MAX_DYNAMIC_OBSERVATION_MS = 60_000;",
  "const REQUIRED_PER_MARKET_OBSERVATION_MS = 50_000;",
];
for (const check of requiredChecks) {
  if (!source.includes(check)) throw new Error(`market-scanner patch verification failed: ${check}`);
}

// A data: module has no filesystem base URL. Rewrite only the entry module's relative
// imports to absolute raw-GitHub URLs; nested modules then resolve their own relatives
// normally from their raw-GitHub locations.
source = source.replace(
  /(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
  (_match, prefix: string, specifier: string, suffix: string) =>
    `${prefix}${new URL(specifier, SOURCE_URL).href}${suffix}`,
);
source = source.replace(
  /(import\s+["'])(\.\.?\/[^"']+)(["'])/g,
  (_match, prefix: string, specifier: string, suffix: string) =>
    `${prefix}${new URL(specifier, SOURCE_URL).href}${suffix}`,
);

const bytes = new TextEncoder().encode(source);
let binary = "";
const chunkSize = 0x8000;
for (let offset = 0; offset < bytes.length; offset += chunkSize) {
  binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
}
const moduleUrl = `data:application/typescript;base64,${btoa(binary)}`;
await import(moduleUrl);
