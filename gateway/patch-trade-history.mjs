import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "server.mjs");
let source = fs.readFileSync(serverPath, "utf8");

const functionMarker = 'async function openOrders(exchange, market = null) {';
const historyFunctions = `async function tradeHistory(exchange, market, options = {}) {
  if (exchange !== "binance") {
    throw Object.assign(new Error("trade_history is supported only for Binance"), {
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
  const rows = (await binanceRequest("GET", "/api/v3/myTrades", params)).data;
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    symbol: row?.symbol || symbol,
    id: row?.id,
    orderId: row?.orderId,
    price: row?.price,
    qty: row?.qty,
    quoteQty: row?.quoteQty,
    commission: row?.commission,
    commissionAsset: row?.commissionAsset,
    time: row?.time,
    isBuyer: row?.isBuyer,
    isMaker: row?.isMaker,
  }));
}

async function orderHistory(exchange, market, options = {}) {
  if (exchange !== "binance") {
    throw Object.assign(new Error("order_history is supported only for Binance"), {
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
  const rows = (await binanceRequest("GET", "/api/v3/allOrders", params)).data;
  return Array.isArray(rows) ? rows : [];
}

`;

if (!source.includes("async function tradeHistory(") || !source.includes("async function orderHistory(")) {
  if (!source.includes(functionMarker)) {
    throw new Error("gateway patch failed: openOrders marker not found");
  }
  if (!source.includes("async function tradeHistory(") && !source.includes("async function orderHistory(")) {
    source = source.replace(functionMarker, `${historyFunctions}${functionMarker}`);
  } else if (!source.includes("async function orderHistory(")) {
    const existingMarker = 'async function tradeHistory(exchange, market, options = {}) {';
    const orderOnly = historyFunctions.slice(historyFunctions.indexOf("async function orderHistory("));
    source = source.replace(functionMarker, `${orderOnly}${functionMarker}`);
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
  !source.includes("/api/v3/allOrders") ||
  !source.includes('case "trade_history":') ||
  !source.includes('case "order_history":')
) {
  throw new Error("gateway patch verification failed");
}

fs.writeFileSync(serverPath, source);
console.log("Applied read-only Binance trade_history and order_history gateway routes.");
