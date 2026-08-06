import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "server.mjs");
let source = fs.readFileSync(serverPath, "utf8");

const functionMarker = 'async function openOrders(exchange, market = null) {';
const tradeHistoryFunction = `async function tradeHistory(exchange, market, options = {}) {
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
    id: Number(row?.id),
    orderId: Number(row?.orderId),
    price: String(row?.price ?? "0"),
    qty: String(row?.qty ?? "0"),
    quoteQty: String(row?.quoteQty ?? "0"),
    commission: String(row?.commission ?? "0"),
    commissionAsset: String(row?.commissionAsset ?? ""),
    time: Number(row?.time),
    isBuyer: Boolean(row?.isBuyer),
    isMaker: Boolean(row?.isMaker),
  }));
}

`;

if (!source.includes("async function tradeHistory(")) {
  if (!source.includes(functionMarker)) {
    throw new Error("gateway patch failed: openOrders marker not found");
  }
  source = source.replace(functionMarker, `${tradeHistoryFunction}${functionMarker}`);
}

const caseMarker = `    case "open_orders":
      return openOrders(exchange, command.market || null);`;
const caseReplacement = `    case "trade_history":
      return tradeHistory(exchange, command.market, {
        fromId: command.from_id,
        limit: command.limit,
      });
${caseMarker}`;

if (!source.includes('case "trade_history":')) {
  if (!source.includes(caseMarker)) {
    throw new Error("gateway patch failed: open_orders case marker not found");
  }
  source = source.replace(caseMarker, caseReplacement);
}

if (!source.includes("/api/v3/myTrades") || !source.includes('case "trade_history":')) {
  throw new Error("gateway patch verification failed");
}

fs.writeFileSync(serverPath, source);
console.log("Applied read-only Binance trade_history gateway route.");
