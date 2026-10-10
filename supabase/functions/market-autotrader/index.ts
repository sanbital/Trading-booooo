Deno.serve(() => new Response(JSON.stringify({
  error: "AUTOMATED_TRADING_DISABLED",
  message: "Trading Boo is read only by operator request.",
}), {
  status: 403,
  headers: { "content-type": "application/json" },
}));
