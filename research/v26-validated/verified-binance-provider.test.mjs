import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256Hex } from "./data-source-integrity.mjs";
import { createVerifiedVisionProvider } from "./verified-binance-provider.mjs";

function fixtureArchive() {
  const dir=mkdtempSync(join(tmpdir(),"v26-vision-fixture-"));
  const filename="BTCUSDT-15m-2026-05.zip";
  const csvName="BTCUSDT-15m-2026-05.csv";
  writeFileSync(join(dir,csvName),"1777593600000,1,2,0.5,1.5,10,1777594499999,15,2,5,8,0\n");
  execFileSync("zip",["-q",filename,csvName],{cwd:dir});
  const bytes=readFileSync(join(dir,filename));
  const checksum=`${sha256Hex(bytes)}  ${filename}\n`;
  return {bytes,checksum,filename};
}

test("verified Vision provider checks official checksum and produces a cache-stable record",async()=>{
  const fixture=fixtureArchive();
  const cache=mkdtempSync(join(tmpdir(),"v26-vision-cache-"));
  let calls=0;
  const fake=async url=>{
    calls++;
    if(String(url).endsWith(".CHECKSUM"))return{ok:true,status:200,text:async()=>fixture.checksum};
    return{ok:true,status:200,arrayBuffer:async()=>fixture.bytes.buffer.slice(fixture.bytes.byteOffset,fixture.bytes.byteOffset+fixture.bytes.byteLength)};
  };
  const records=[];
  const provider=createVerifiedVisionProvider({cacheDir:cache,fetchImpl:fake,onVerified:r=>records.push(r)});
  const first=await provider.load({kind:"monthly",symbol:"BTCUSDT",interval:"15m",period:"2026-05"});
  assert.equal(first.rows.length,1);
  assert.equal(calls,2);
  const firstRecord=records.at(-1);

  // A cache hit must verify and re-extract the archive without any network use.
  const offline=createVerifiedVisionProvider({cacheDir:cache,fetchImpl:async()=>{throw Error("NETWORK_MUST_NOT_RUN");},onVerified:r=>records.push(r)});
  const second=await offline.load({kind:"monthly",symbol:"BTCUSDT",interval:"15m",period:"2026-05"});
  assert.deepEqual(second.rows,first.rows);
  assert.deepEqual(records.at(-1),firstRecord);
});

test("verified Vision provider rejects a checksum mismatch before caching",async()=>{
  const fixture=fixtureArchive();
  const cache=mkdtempSync(join(tmpdir(),"v26-vision-bad-"));
  const fake=async url=>String(url).endsWith(".CHECKSUM")
    ?{ok:true,status:200,text:async()=>`${"0".repeat(64)}  ${fixture.filename}\n`}
    :{ok:true,status:200,arrayBuffer:async()=>fixture.bytes.buffer.slice(fixture.bytes.byteOffset,fixture.bytes.byteOffset+fixture.bytes.byteLength)};
  const provider=createVerifiedVisionProvider({cacheDir:cache,fetchImpl:fake});
  await assert.rejects(()=>provider.load({kind:"monthly",symbol:"BTCUSDT",interval:"15m",period:"2026-05"}),/CHECKSUM_MISMATCH/);
});
