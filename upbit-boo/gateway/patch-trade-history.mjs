import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "server.mjs");
let source = fs.readFileSync(serverPath, "utf8");

const functionMarker = 'async function openOrders(exchange, market = null) {';
const historyFunctions = `async function tradeHistory(exchange, market, options = {}) {
  if (exchange !== "binance" && exchange !== "binance_futures") {
    throw Object.assign(new Error("trade_history is supported only for Binance spot/futures"), {
      status: 400,
      code: "UNSUPPORTED_EXCHANGE",
    });
  }
  const symbol = validateBinanceSymbol(market);
  const requestedLimit = Math.trunc(Number(options.limit ?? 1000));
  const limit = Math.min(1000, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 1000));
  const params = { symbol, limit };
  const fromId = Number(options.fromId);
  if (options.fromId !== null && options.fromId !== undefined && options.fromId !== "" &&
      Number.isInteger(fromId) && fromId >= 0) {
    params.fromId = fromId;
  }
  const futures = exchange === "binance_futures";
  const rows = futures
    ? (await futuresRequest("GET", "/fapi/v1/userTrades", params)).data
    : (await binanceRequest("GET", "/api/v3/myTrades", params)).data;
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    symbol: row?.symbol || symbol,
    id: row?.id,
    orderId: row?.orderId,
    price: row?.price,
    qty: row?.qty,
    quoteQty: row?.quoteQty ?? (Number(row?.price || 0) * Number(row?.qty || 0)),
    commission: row?.commission,
    commissionAsset: row?.commissionAsset,
    realizedPnl: row?.realizedPnl ?? null,
    time: row?.time,
    isBuyer: row?.isBuyer ?? String(row?.side || "").toUpperCase() === "BUY",
    isMaker: row?.isMaker ?? row?.maker ?? false,
  }));
}

async function orderHistory(exchange, market, options = {}) {
  if (exchange !== "binance" && exchange !== "binance_futures") {
    throw Object.assign(new Error("order_history is supported only for Binance spot/futures"), {
      status: 400,
      code: "UNSUPPORTED_EXCHANGE",
    });
  }
  const symbol = validateBinanceSymbol(market);
  const requestedLimit = Math.trunc(Number(options.limit ?? 1000));
  const limit = Math.min(1000, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 1000));
  const params = { symbol, limit };
  const startTime = Number(options.startTime);
  const endTime = Number(options.endTime);
  const orderId = Number(options.orderId);
  if (Number.isFinite(startTime) && startTime > 0) params.startTime = Math.trunc(startTime);
  if (Number.isFinite(endTime) && endTime > 0) params.endTime = Math.trunc(endTime);
  if (Number.isInteger(orderId) && orderId >= 0) params.orderId = orderId;
  return exchange === "binance_futures"
    ? ((await futuresRequest("GET", "/fapi/v1/allOrders", params)).data || [])
    : ((await binanceRequest("GET", "/api/v3/allOrders", params)).data || []);
}

`;

if (!source.includes("async function tradeHistory(") || !source.includes("async function orderHistory(")) {
  if (!source.includes(functionMarker)) {
    throw new Error("gateway patch failed: openOrders marker not found");
  }
  if (!source.includes("async function tradeHistory(") && !source.includes("async function orderHistory(")) {
    source = source.replace(functionMarker, `${historyFunctions}${functionMarker}`);
  } else {
    // A prior deploy may have injected the old spot-only helper. Replace the complete
    // injected block so deployments are idempotent and futures support cannot regress.
    source = source.replace(
      /async function tradeHistory\(exchange, market, options = \{\}\) \{[\s\S]*?\n\}\n\nasync function orderHistory\(exchange, market, options = \{\}\) \{[\s\S]*?\n\}\n\n(?=async function openOrders)/,
      historyFunctions,
    );
  }
}

const caseMarker = `    case "open_orders":
      return openOrders(exchange, command.market || null);`;
let caseReplacement = caseMarker;
if (!source.includes('case "trade_history":')) {
  caseReplacement = `    case "trade_history":
      return tradeHistory(exchange, command.market, {
        fromId: command.from_id,
        limit: command.limit,
      });
${caseReplacement}`;
}
if (!source.includes('case "order_history":')) {
  caseReplacement = `    case "order_history":
      return orderHistory(exchange, command.market, {
        orderId: command.order_id,
        startTime: command.start_time,
        endTime: command.end_time,
        limit: command.limit,
      });
${caseReplacement}`;
}
if (caseReplacement !== caseMarker) {
  if (!source.includes(caseMarker)) {
    throw new Error("gateway patch failed: open_orders case marker not found");
  }
  source = source.replace(caseMarker, caseReplacement);
}

if (
  !source.includes("/api/v3/myTrades") ||
  !source.includes("/fapi/v1/userTrades") ||
  !source.includes("/api/v3/allOrders") ||
  !source.includes("/fapi/v1/allOrders") ||
  !source.includes('case "trade_history":') ||
  !source.includes('case "order_history":')
) {
  throw new Error("gateway patch verification failed");
}

fs.writeFileSync(serverPath, source);
console.log("Applied read-only Binance spot/futures trade_history and order_history gateway routes.");
