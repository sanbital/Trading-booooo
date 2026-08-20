export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i++) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

export function automationAllowed(request: Request): boolean {
  const expected = (Deno.env.get("AUTOTRADE_ACCESS_TOKEN") || Deno.env.get("AUTOMATION_ACCESS_TOKEN") || "").trim();
  const provided = (request.headers.get("x-autotrade-token") || request.headers.get("x-automation-token") || "").trim();
  return expected.length >= 32 && provided.length > 0 && constantTimeEqual(expected, provided);
}
