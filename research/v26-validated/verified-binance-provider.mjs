import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { verifyChecksumBytes } from "./data-source-integrity.mjs";

function csvRows(text) {
  const out=[];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    const row=line.split(",");
    if (/^\d+$/.test(row[0]??"")) out.push(row);
  }
  return out;
}

function safePart(value) {
  return encodeURIComponent(String(value));
}

/**
 * Binance Vision reader with provenance-preserving cache semantics.
 * A cached CSV alone is deliberately not trusted: the archive and its official
 * CHECKSUM must both be present and valid, otherwise the object is downloaded
 * and verified again.
 */
export function createVerifiedVisionProvider({
  cacheDir,
  fetchImpl=fetch,
  onRequest=()=>{},
  onNotFound=()=>{},
  onRetry=()=>{},
  onVerified=()=>{},
}) {
  if (!cacheDir) throw new Error("VISION_CACHE_DIR_REQUIRED");
  mkdirSync(cacheDir,{recursive:true});

  async function fetchWithRetry(url,{allow404=false}={}) {
    let response;
    for (let attempt=0; attempt<4; attempt++) {
      onRequest(url);
      response=await fetchImpl(url,{headers:{"user-agent":"Trading-booooo-v26-validation"}});
      if (response?.ok) return response;
      if (allow404 && response?.status===404) {
        onNotFound(url);
        return null;
      }
      if (response?.status===418 || response?.status===429 || response?.status===451) {
        throw new Error(`VISION_HTTP_${response.status}:${url}`);
      }
      onRetry(url,response?.status);
      if (attempt<3) await new Promise(resolve=>setTimeout(resolve,Math.min(8000,500*2**attempt)));
    }
    throw new Error(`VISION_HTTP_${response?.status??"UNKNOWN"}:${url}`);
  }

  async function load({kind,symbol,interval,period}) {
    if (!['daily','monthly'].includes(kind) || !symbol || !interval || !period) {
      throw new Error("INVALID_VISION_OBJECT");
    }
    const safeSymbol=safePart(symbol);
    const filename=`${symbol}-${interval}-${period}.zip`;
    const encodedFilename=safePart(filename);
    const url=`https://data.binance.vision/data/futures/um/${kind}/klines/${safeSymbol}/${interval}/${encodedFilename}`;
    const prefix=`${safeSymbol}-${safePart(interval)}-${safePart(period)}-${kind}`;
    const zipPath=`${cacheDir}/${prefix}.zip`;
    const checksumPath=`${zipPath}.CHECKSUM`;
    const csvPath=`${cacheDir}/${prefix}.csv`;

    let bytes,checksumText;
    if (existsSync(zipPath) && existsSync(checksumPath)) {
      bytes=new Uint8Array(readFileSync(zipPath));
      checksumText=readFileSync(checksumPath,"utf8");
    } else {
      const archive=await fetchWithRetry(url,{allow404:true});
      if (!archive) return {rows:[],missing:true,sourceRecord:null,url};
      const checksum=await fetchWithRetry(url+".CHECKSUM");
      bytes=new Uint8Array(await archive.arrayBuffer());
      checksumText=await checksum.text();
      // Verify before persisting anything as reusable cache.
      verifyChecksumBytes(bytes,checksumText,filename);
      writeFileSync(zipPath,bytes);
      writeFileSync(checksumPath,checksumText);
    }
    const sha256=verifyChecksumBytes(bytes,checksumText,filename);
    // Always derive parsed content from the verified archive. A stale or
    // independently modified extracted CSV must never influence a cache hit.
    const text=execFileSync("unzip",["-p",zipPath],{encoding:"utf8",maxBuffer:256*1024*1024});
    writeFileSync(csvPath,text);
    const sourceRecord={source:url,sha256};
    onVerified(sourceRecord);
    return {rows:csvRows(text),missing:false,sourceRecord,url};
  }

  return {load};
}
