import { dispatchV5Action } from "./ops.ts";

const TOKEN_NAME = "market-v2-research";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function env(name: string): string {
  return String(Deno.env.get(name) || "").trim();
}

function constantTimeEqual(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < right.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function authorize(request: Request): Promise<boolean> {
  const supplied = String(request.headers.get("x-v2-research-token") || "").trim();
  if (!supplied) return false;
  const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!/^https?:\/\//i.test(supabaseUrl) || !serviceRoleKey) {
    throw new Error("V5 research authorization environment is unavailable");
  }
  const query = new URLSearchParams({
    name: `eq.${TOKEN_NAME}`,
    select: "token",
    limit: "1",
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/edge_internal_tokens?${query}`, {
    method: "GET",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`V5 research token lookup failed ${response.status}: ${text.slice(0, 300)}`);
  }
  const rows = text ? JSON.parse(text) : [];
  const expected = String(rows?.[0]?.token || "");
  return constantTimeEqual(supplied, expected);
}

Deno.serve(async (request: Request): Promise<Response> => {
  const startedAt = Date.now();
  try {
    if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
    if (!await authorize(request)) return json({ ok: false, error: "unauthorized" }, 401);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "valid JSON body required" }, 400);
    }
    const result = await dispatchV5Action(body);
    return json({ ...result, elapsed_ms: Date.now() - startedAt });
  } catch (error) {
    console.error("regime-router-v5-research", error);
    return json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsed_ms: Date.now() - startedAt,
    }, 500);
  }
});
