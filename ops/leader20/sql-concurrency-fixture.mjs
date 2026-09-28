// Build an isolated PostgreSQL copy of the tested migration. No trading tables,
// external HTTP, real credentials, or real ledger balances are referenced.
import {readFileSync} from 'node:fs';
const test=readFileSync('tests/leader20-batch-ledger.test.mjs','utf8');
let setup=test.match(/await db\.exec\(`([\s\S]*?)`\);/)[1];
setup=setup.replace('create role anon;create role authenticated;create role service_role bypassrls;','')
 .replace('create schema net;','').replaceAll('net.requests','leader20_release_audit.http_requests')
 .replaceAll('net.http_post','leader20_release_audit.http_post');
let migration=readFileSync('supabase/migrations/20260928012054_leader20_batch_provider_ledger.sql','utf8')
 .replaceAll('public.','leader20_release_audit.').replaceAll('net.http_post','leader20_release_audit.http_post')
 .replaceAll('20260927,40','20260928,140').replaceAll('20260928,51','20260928,151').replaceAll('20260928,52','20260928,152');
console.log(JSON.stringify({sql:`create schema leader20_release_audit;\nrevoke all on schema leader20_release_audit from public,anon,authenticated;\nset local search_path=leader20_release_audit,pg_catalog;\n${setup}\n${migration}`,
 transformations:['public schema → isolated audit schema','HTTP → local request log','advisory keys → isolated keys']}));
