import crypto from "node:crypto";
const url = String(process.argv[2] || "").replace(/\/$/, "");
const secret = String(process.argv[3] || "");
const exchanges = String(process.argv[4] || "upbit,binance").split(",").map((x) => x.trim()).filter(Boolean);
if (!url || secret.length < 32) throw new Error("usage: node smoke.mjs <gateway-url> <shared-secret> [upbit,binance]");
for (const exchange of exchanges) {
  const command = JSON.stringify({ exchange, action: "portfolio" });
  const ts = String(Date.now()); const nonce = crypto.randomUUID();
  const signature = crypto.createHmac("sha256", secret).update(`${ts}\n${nonce}\n${command}`).digest("hex");
  const response = await fetch(`${url}/v1/command`, { method: "POST", headers: { "content-type": "application/json", "x-gateway-ts": ts, "x-gateway-nonce": nonce, "x-gateway-signature": signature }, body: command });
  const text = await response.text();
  if (!response.ok) throw new Error(`${exchange} smoke ${response.status}: ${text}`);
  console.log(`${exchange}: ${text}`);
}
