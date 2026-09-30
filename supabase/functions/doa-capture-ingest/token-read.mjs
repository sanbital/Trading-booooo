export function transientTokenReadError(error) {
  return /signal timed out|timeout|timed out|fetch failed|network|econn|socket|DATABASE_(?:429|5\d\d)/i.test(String(error?.message ?? error));
}

export function createTokenReader(read, { ttlMs = 30_000, waitMs = 120, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let cached = null;
  let pending = null;
  return async function getToken() {
    if (cached?.token && cached.expires > now()) return cached.token;
    if (pending) return pending;
    pending = (async () => {
      let token;
      try {
        token = await read();
      } catch (error) {
        if (!transientTokenReadError(error)) throw error;
        await sleep(waitMs);
        token = await read();
      }
      if (token) cached = { token, expires: now() + ttlMs };
      return token;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
