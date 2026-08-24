import crypto from "node:crypto";
const url = String(process.argv[2] || "").replace(/\/$/, "");
const secret = String(process.argv[3] || "");
const exchanges = String(process.argv[4] || "upbit,binance").split(",").map((x) => x.trim()).filter(Boolean);
if (!url || secret.length < 32) throw new Error("usage: node smoke.mjs <gateway-url> <shared-secret> [upbit,binance]");
for (const exchange of exchanges) {
  for (const body of [
    { exchange, action: "portfolio" },
    { exchange, action: "p10_portfolio" },
    {
      exchange,
      action: "p10_quotes",
      markets: [exchange === "upbit" ? "KRW-BTC" : "BTCUSDT"],
    },
  ]) {
    const command = JSON.stringify(body);
    const ts = String(Date.now());
    const nonce = crypto.randomUUID();
    const signature = crypto.createHmac("sha256", secret).update(`${ts}\n${nonce}\n${command}`)
      .digest("hex");
    const response = await fetch(`${url}/v1/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-ts": ts,
        "x-gateway-nonce": nonce,
        "x-gateway-signature": signature,
      },
      body: command,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${exchange} ${body.action} smoke ${response.status}: ${text}`);
    }
    const payload = JSON.parse(text);
    if (body.action === "p10_quotes") {
      const quote = Array.isArray(payload?.result) ? payload.result[0] : null;
      if (!(Number(quote?.best_bid) > 0 && Number(quote?.best_ask) > 0)) {
        throw new Error(`${exchange} p10_quotes smoke returned no executable top of book`);
      }
    } else if (body.action === "p10_portfolio") {
      const accounts = Array.isArray(payload?.result?.accounts) ? payload.result.accounts : [];
      if (!accounts.length) {
        throw new Error(`${exchange} p10_portfolio smoke returned no authenticated accounts`);
      }
    }
    console.log(`${exchange} ${body.action}: ${text}`);
  }
}
