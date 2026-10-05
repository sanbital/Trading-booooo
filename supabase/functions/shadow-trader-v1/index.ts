import { createHandler } from './handler.mjs';

Deno.serve(createHandler({
  url: (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, ''),
  key: (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim(),
}));
