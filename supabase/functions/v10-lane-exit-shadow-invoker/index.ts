import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const headers = { "content-type": "application/json; charset=utf-8" };
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers });

Deno.serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return reply(500, { error: "SUPABASE_ENV_MISSING" });
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const requestToken = req.headers.get("x-v10-exit-token");
  const { data: tokenRow, error: tokenError } = await db
    .from("edge_internal_tokens")
    .select("token")
    .eq("name", "v10-lane-exit-shadow")
    .maybeSingle();
  if (tokenError || !requestToken || tokenRow?.token !== requestToken) {
    return reply(401, { error: "UNAUTHORIZED" });
  }

  const input = req.method === "GET" ? {} : await req.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(50, Number(input?.limit ?? 50)));
  const target = `${supabaseUrl}/functions/v1/v10-lane-exit-shadow`;
  const upstream = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ mode: "shadow", limit }),
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
});
