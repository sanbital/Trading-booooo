/** Hosts the V17 exit shadow worker inside the Binance gateway.
 *
 * Supplies the two things the worker cannot supply itself: a real WebSocket to Binance
 * and the list of positions to shadow. It still cannot place an order — the worker it
 * drives has no order path, and this module adds none.
 *
 * Positions arrive by push. The executor already talks to this gateway over a signed
 * channel once a minute, so reusing that direction avoids giving the gateway a database
 * credential it does not otherwise need. The cost is that a new position can be picked
 * up up to one executor cycle late, which only shortens the shadow window.
 */
const STREAM_BASE = "wss://fstream.binance.com/stream?streams=";
const MAX_BACKOFF_MS = 30_000;

/** Positions are pushed from outside, so they are validated before the engine sees them. */
export function normalizePositions(raw) {
  if (!Array.isArray(raw)) throw new Error("V17_SHADOW_POSITIONS_NOT_ARRAY");
  if (raw.length > 20) throw new Error("V17_SHADOW_POSITIONS_TOO_MANY");
  return raw.map((p) => {
    const symbol = String(p?.symbol ?? "").toUpperCase();
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) throw new Error(`V17_SHADOW_BAD_SYMBOL:${symbol}`);
    const out = {
      positionId: String(p.positionId ?? p.id ?? symbol),
      symbol,
      entryPrice: Number(p.entryPrice),
      entryAt: Number(p.entryAt),
      quantity: Number(p.quantity),
      entryFee: Number(p.entryFee),
      quantityStep: Number(p.quantityStep),
    };
    for (const k of ["entryPrice", "entryAt", "quantity", "entryFee", "quantityStep"]) {
      if (!Number.isFinite(out[k])) throw new Error(`V17_SHADOW_BAD_FIELD:${symbol}:${k}`);
    }
    return out;
  });
}

export function createShadowHost({
  createShadowWorker,
  engine,
  WebSocketImpl = globalThis.WebSocket,
  log = console.log,
  report = (r) => console.log(JSON.stringify({ v17Shadow: r })),
  streamBase = STREAM_BASE,
  timers = globalThis,
  clock = Date.now,
}) {
  if (typeof createShadowWorker !== "function") throw new Error("V17_SHADOW_HOST_WORKER");
  if (typeof WebSocketImpl !== "function") throw new Error("V17_SHADOW_HOST_NO_WEBSOCKET");
  let positions = [];
  let sockets = [];
  let backoffMs = 1000;

  const worker = createShadowWorker({
    engine,
    listPositions: async () => positions,
    clock,
    emit: (decision) => log(JSON.stringify({ v17ShadowSignal: decision })),
    report,
    timers,
    connect: (streams) => open(streams),
  });

  function open(streams) {
    const url = `${streamBase}${streams.join("/")}`;
    let closedByUs = false, socket;
    const connect = () => {
      try {
        socket = new WebSocketImpl(url);
      } catch (error) {
        report({ kind: "SHADOW_WS_OPEN_FAILED", error: String(error?.message ?? error) });
        return retry();
      }
      socket.onopen = () => {
        backoffMs = 1000;
        report({ kind: "SHADOW_WS_OPEN", streams: streams.length });
      };
      socket.onmessage = (event) => {
        let parsed;
        try {
          parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
          return; // a frame we cannot parse is not evidence; drop it rather than guess
        }
        worker.onMessage(parsed);
      };
      socket.onerror = () => {}; // close always follows; handle it there
      socket.onclose = () => {
        if (closedByUs) return;
        // Reconnecting leaves a hole in the aggregate-trade sequence. The engine detects
        // that itself and marks coverage broken, so no confirmation can span the gap.
        report({ kind: "SHADOW_WS_CLOSED", reconnectInMs: backoffMs });
        retry();
      };
    };
    const retry = () => {
      if (closedByUs) return;
      const wait = backoffMs;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      const t = timers.setTimeout(connect, wait);
      if (typeof t?.unref === "function") t.unref();
    };
    connect();
    const handle = {
      close() {
        closedByUs = true;
        try {
          socket?.close();
        } catch { /* already gone */ }
      },
    };
    sockets.push(handle);
    return handle;
  }

  return {
    async setPositions(raw) {
      positions = normalizePositions(raw);
      report({ kind: "SHADOW_POSITIONS", count: positions.length });
      await worker.start();
      return { accepted: positions.length };
    },
    status() {
      return { positions: positions.length, tracked: worker.snapshot() };
    },
    stop() {
      worker.stop();
      for (const s of sockets) s.close();
      sockets = [];
    },
  };
}
