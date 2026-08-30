#!/usr/bin/env python3
"""Preregistered V10 continuation search for one RANGE lane and one BEAR lane.

Discovery never reads the final 2025-11-02..2026-01-01 holdout.  The same frozen
candidate definitions, regime classifier, execution model and ranking rule are used in
TEST.  A candidate-lock.json committed after discovery is required before TEST can run.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

UTC = timezone.utc
BAR_MS = 15 * 60 * 1000
DAY_MS = 24 * 60 * 60 * 1000
ASSETS = ["BTC","ETH","XRP","SOL","DOGE","ADA","AVAX","LINK","BCH","DOT","TRX","NEAR","APT","SUI","ETC","XLM","ATOM","UNI","ARB","OP","SEI"]
ROOT = "https://data.binance.vision/data/futures/um/monthly/klines"
HERE = Path(__file__).resolve().parent
CACHE = HERE.parents[1] / "v10-cache-continuation"
LOCK_PATH = HERE / "candidate-lock.json"
OUT_PATH = HERE / "result.json"
DISC_START = datetime(2025,1,1,tzinfo=UTC)
DISC_END = datetime(2025,10,8,tzinfo=UTC)
TEST_START = datetime(2025,11,2,tzinfo=UTC)
TEST_END = datetime(2026,1,1,tzinfo=UTC)
BASE_COST = 14.0
STRESS_COST = 23.0
MAX_HOLD = 16
MAX_POSITIONS = 3
STOP_ATR = 1.25
TARGET_ATR = 1.75
MIN_BARRIER_BPS = 35.0
MAX_BARRIER_BPS = 250.0
USER_AGENT = "Trading-booooo-V10-continuation/1.0"

# Candidate ideas are frozen before the 2025 discovery/validation run.  RANGE uses the
# lower/upper-edge absorption geometry suggested by the independent 2026 D5 pattern
# lineage.  BEAR uses a longer rebound rejection and a separate high-volume breakdown
# continuation mechanism; neither is a threshold tweak of the failed original V10 VWAP
# reversal or four-bar weak-rebound family.
CANDIDATES = [
    {"key":"V10C_RANGE_SPRING_A","lane":"RANGE","group":"RANGE_SPRING","side":"LONG","p":{"range_pos_max":0.22,"wick_min":0.30,"close_loc_min":0.58,"volume_z_min":0.50,"taker_signed_min":0.00,"ret3_atr_max":-0.50}},
    {"key":"V10C_RANGE_SPRING_B","lane":"RANGE","group":"RANGE_SPRING","side":"LONG","p":{"range_pos_max":0.18,"wick_min":0.35,"close_loc_min":0.62,"volume_z_min":0.75,"taker_signed_min":0.04,"ret3_atr_max":-0.75}},
    {"key":"V10C_RANGE_UPTHRUST_A","lane":"RANGE","group":"RANGE_UPTHRUST","side":"SHORT","p":{"range_pos_min":0.78,"wick_min":0.30,"close_loc_max":0.42,"volume_z_min":0.50,"taker_signed_max":0.00,"ret3_atr_min":0.50}},
    {"key":"V10C_RANGE_UPTHRUST_B","lane":"RANGE","group":"RANGE_UPTHRUST","side":"SHORT","p":{"range_pos_min":0.82,"wick_min":0.35,"close_loc_max":0.38,"volume_z_min":0.75,"taker_signed_max":-0.04,"ret3_atr_min":0.75}},
    {"key":"V10C_BEAR_REBOUND_BODY_A","lane":"BEAR","group":"BEAR_REBOUND_BODY","side":"SHORT","p":{"ret3_atr_min":0.75,"body_min":0.45,"close_loc_max":0.35,"volume_z_min":0.00,"taker_signed_max":0.00}},
    {"key":"V10C_BEAR_REBOUND_BODY_B","lane":"BEAR","group":"BEAR_REBOUND_BODY","side":"SHORT","p":{"ret3_atr_min":1.00,"body_min":0.55,"close_loc_max":0.30,"volume_z_min":0.25,"taker_signed_max":-0.04}},
    {"key":"V10C_BEAR_BREAKDOWN_A","lane":"BEAR","group":"BEAR_BREAKDOWN","side":"SHORT","p":{"break_atr_min":0.00,"body_min":0.45,"close_loc_max":0.30,"volume_z_min":0.50,"taker_signed_max":-0.04,"ret3_atr_max":-0.50}},
    {"key":"V10C_BEAR_BREAKDOWN_B","lane":"BEAR","group":"BEAR_BREAKDOWN","side":"SHORT","p":{"break_atr_min":0.10,"body_min":0.55,"close_loc_max":0.25,"volume_z_min":0.75,"taker_signed_max":-0.08,"ret3_atr_max":-0.75}},
]


def ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)

def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts/1000, UTC).isoformat().replace("+00:00","Z")

def canonical(obj: Any) -> bytes:
    return json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=False,allow_nan=False).encode()

def sha(obj: Any) -> str:
    return hashlib.sha256(canonical(obj)).hexdigest()

def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo,min(hi,v))

def fetch(url: str, attempts: int = 4) -> bytes:
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url,headers={"User-Agent":USER_AGENT})
            with urllib.request.urlopen(req,timeout=60) as r:
                return r.read()
        except (OSError,urllib.error.URLError,urllib.error.HTTPError) as e:
            last=e
            if i+1 < attempts:
                time.sleep(min(6,0.5*(2**i)))
    raise RuntimeError(f"download failed {url}: {last}")

@dataclass(slots=True)
class Bar:
    ts:int; o:float; h:float; l:float; c:float; volume:float; qv:float; taker_buy:float

@dataclass(slots=True)
class Feature:
    ts:int; asset:str; atr:float; ret24:float; ret3_atr:float; ema72:float; ema24:float
    efficiency24:float; range_pos:float; prior_low:float; prior_high:float
    volume_z:float; taker_signed:float; body_ratio:float; lower_wick:float
    upper_wick:float; close_loc:float; regime:str="OTHER"

@dataclass(slots=True)
class Trade:
    key:str; lane:str; asset:str; side:str; signal_ts:int; entry_ts:int; exit_ts:int
    gross:float; base:float; stress:float; score:float; reason:str


def months(start: datetime, end: datetime):
    y,m=start.year,start.month
    while datetime(y,m,1,tzinfo=UTC) < end:
        yield y,m
        if m==12: y,m=y+1,1
        else: m+=1


def get_archive(asset: str, year: int, month: int) -> Path:
    sym=f"{asset}USDT"; ym=f"{year:04d}-{month:02d}"
    d=CACHE/sym; d.mkdir(parents=True,exist_ok=True)
    p=d/f"{sym}-15m-{ym}.zip"
    checksum_url=f"{ROOT}/{sym}/15m/{p.name}.CHECKSUM"
    zip_url=f"{ROOT}/{sym}/15m/{p.name}"
    expected=fetch(checksum_url).decode("utf-8","replace").strip().split()[0].lower()
    if p.exists():
        actual=hashlib.sha256(p.read_bytes()).hexdigest()
        if actual==expected:
            return p
        p.unlink()
    data=fetch(zip_url)
    actual=hashlib.sha256(data).hexdigest()
    if actual!=expected:
        raise RuntimeError(f"checksum mismatch {p.name}")
    tmp=p.with_suffix(".tmp"); tmp.write_bytes(data); os.replace(tmp,p)
    return p


def parse_archive(path: Path, start_ms: int, end_ms: int) -> list[Bar]:
    out=[]
    with zipfile.ZipFile(path) as z:
        names=[n for n in z.namelist() if not n.endswith("/")]
        if len(names)!=1: raise RuntimeError(f"unexpected zip layout {path}")
        with z.open(names[0]) as raw:
            reader=csv.reader(io.TextIOWrapper(raw,encoding="utf-8"))
            for row in reader:
                if not row or not row[0].isdigit(): continue
                ts=int(row[0]);
                if ts>100_000_000_000_000: ts//=1000
                if ts<start_ms or ts>=end_ms: continue
                out.append(Bar(ts,float(row[1]),float(row[2]),float(row[3]),float(row[4]),float(row[5]),float(row[7]),float(row[9])))
    return out


def load_bars(mode: str) -> dict[str,list[Bar]]:
    if mode=="DISCOVERY":
        start,end=DISC_START,DISC_END
    else:
        # October is warm-up only. TEST begins 2025-11-02 and remains untouched in discovery.
        start,end=datetime(2025,10,1,tzinfo=UTC),TEST_END
    jobs=[(a,y,m) for a in ASSETS for y,m in months(start,end)]
    paths={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        fut={ex.submit(get_archive,*j):j for j in jobs}
        for f in as_completed(fut):
            j=fut[f]; paths[j]=f.result()
    result={}
    s,e=ms(start),ms(end)
    for asset in ASSETS:
        rows=[]
        for y,m in months(start,end): rows.extend(parse_archive(paths[(asset,y,m)],s,e))
        rows.sort(key=lambda b:b.ts)
        if len(rows)<400: raise RuntimeError(f"insufficient bars {asset}: {len(rows)}")
        seen=set()
        for b in rows:
            if b.ts in seen: raise RuntimeError(f"duplicate bar {asset} {b.ts}")
            seen.add(b.ts)
        result[asset]=rows
    return result


def feature_map(asset: str, bars: list[Bar]) -> dict[int,Feature]:
    out={}
    alpha72=2/(288+1); alpha24=2/(96+1)
    ema72=None; ema24=None
    trq=deque(); trsum=0.0
    pathq=deque(); pathsum=0.0
    qvq=deque(); qvsum=0.0; qvsum2=0.0
    highs=deque(); lows=deque()
    for i,b in enumerate(bars):
        ema72=b.c if ema72 is None else alpha72*b.c+(1-alpha72)*ema72
        ema24=b.c if ema24 is None else alpha24*b.c+(1-alpha24)*ema24
        prev=bars[i-1].c if i else b.c
        tr=max(b.h-b.l,abs(b.h-prev),abs(b.l-prev))
        trq.append(tr); trsum+=tr
        if len(trq)>14: trsum-=trq.popleft()
        atr=trsum/14 if len(trq)==14 else 0.0
        step=abs(b.c-prev)
        pathq.append(step); pathsum+=step
        if len(pathq)>96: pathsum-=pathq.popleft()
        while highs and highs[0] < i-96: highs.popleft()
        while lows and lows[0] < i-96: lows.popleft()
        prior_high=bars[highs[0]].h if highs else float("nan")
        prior_low=bars[lows[0]].l if lows else float("nan")
        vz=float("nan")
        if len(qvq)==96:
            mean=qvsum/96; var=max(0.0,qvsum2/96-mean*mean); sd=math.sqrt(var)
            vz=0.0 if sd<=1e-12 else (b.qv-mean)/sd
        qvq.append(b.qv); qvsum+=b.qv; qvsum2+=b.qv*b.qv
        if len(qvq)>96:
            old=qvq.popleft(); qvsum-=old; qvsum2-=old*old
        if i>=96 and bars[i].ts-bars[i-96].ts==96*BAR_MS and atr>0 and len(pathq)==96 and math.isfinite(prior_high):
            ret24=b.c/bars[i-96].c-1
            eff=0.0 if pathsum<=1e-12 else abs(b.c-bars[i-96].c)/pathsum
            ret3=(b.c-bars[i-12].c)/atr if i>=12 and bars[i].ts-bars[i-12].ts==12*BAR_MS else float("nan")
            span=max(1e-12,prior_high-prior_low)
            rpos=(b.c-prior_low)/span
            cspan=max(1e-12,b.h-b.l)
            body=abs(b.c-b.o)/cspan
            lowwick=(min(b.o,b.c)-b.l)/cspan
            upwick=(b.h-max(b.o,b.c))/cspan
            cloc=(b.c-b.l)/cspan
            taker=0.0 if b.volume<=0 else clamp(2*b.taker_buy/b.volume-1,-1,1)
            if math.isfinite(vz) and math.isfinite(ret3):
                out[b.ts]=Feature(b.ts,asset,atr,ret24,ret3,ema72,ema24,eff,rpos,prior_low,prior_high,vz,taker,body,lowwick,upwick,cloc)
        while highs and bars[highs[-1]].h<=b.h: highs.pop()
        highs.append(i)
        while lows and bars[lows[-1]].l>=b.l: lows.pop()
        lows.append(i)
    return out


def build_features(bars: dict[str,list[Bar]]) -> tuple[dict[str,dict[int,Feature]],dict[str,dict[int,int]]]:
    feats={a:feature_map(a,bs) for a,bs in bars.items()}
    indices={a:{b.ts:i for i,b in enumerate(bs)} for a,bs in bars.items()}
    btc=feats["BTC"]
    for ts,bf in btc.items():
        vals=[]
        for a in ASSETS:
            f=feats[a].get(ts)
            if f is not None: vals.append(1.0 if f.ret24>0 else 0.0)
        if len(vals)<15: continue
        breadth=sum(vals)/len(vals)
        btc_close=bars["BTC"][indices["BTC"][ts]].c
        if bf.ret24<=-0.03 and btc_close<bf.ema72 and breadth<=0.30: regime="STRONG_BEAR"
        elif bf.ret24<=-0.01 and btc_close<bf.ema72 and breadth<=0.45: regime="BEAR"
        elif abs(bf.ret24)<=0.02 and bf.efficiency24<=0.35 and 0.30<=breadth<=0.70: regime="RANGE"
        else: regime="OTHER"
        for a in ASSETS:
            f=feats[a].get(ts)
            if f is not None: f.regime=regime
    return feats,indices


def score_excess(v: float, threshold: float, direction: str) -> float:
    if direction=="min": return max(0.0,(v-threshold)/(abs(threshold)+1e-9))
    return max(0.0,(threshold-v)/(abs(threshold)+1e-9))


def signal(c: dict[str,Any], f: Feature, close: float) -> float | None:
    p=c["p"]; k=c["key"]
    if c["lane"]=="RANGE" and f.regime!="RANGE": return None
    if c["lane"]=="BEAR" and f.regime not in ("BEAR","STRONG_BEAR"): return None
    if k.startswith("V10C_RANGE_SPRING"):
        if not (f.range_pos<=p["range_pos_max"] and f.lower_wick>=p["wick_min"] and f.close_loc>=p["close_loc_min"] and f.volume_z>=p["volume_z_min"] and f.taker_signed>=p["taker_signed_min"] and f.ret3_atr<=p["ret3_atr_max"]): return None
        return (p["range_pos_max"]-f.range_pos)/max(p["range_pos_max"],1e-9)+(f.lower_wick-p["wick_min"])+max(0,f.volume_z-p["volume_z_min"])+max(0,p["ret3_atr_max"]-f.ret3_atr)
    if k.startswith("V10C_RANGE_UPTHRUST"):
        if not (f.range_pos>=p["range_pos_min"] and f.upper_wick>=p["wick_min"] and f.close_loc<=p["close_loc_max"] and f.volume_z>=p["volume_z_min"] and f.taker_signed<=p["taker_signed_max"] and f.ret3_atr>=p["ret3_atr_min"]): return None
        return (f.range_pos-p["range_pos_min"])+max(0,f.upper_wick-p["wick_min"])+max(0,f.volume_z-p["volume_z_min"])+max(0,f.ret3_atr-p["ret3_atr_min"])
    if k.startswith("V10C_BEAR_REBOUND_BODY"):
        if not (f.ret3_atr>=p["ret3_atr_min"] and close<f.ema24 and f.body_ratio>=p["body_min"] and f.close_loc<=p["close_loc_max"] and f.volume_z>=p["volume_z_min"] and f.taker_signed<=p["taker_signed_max"]): return None
        return max(0,f.ret3_atr-p["ret3_atr_min"])+max(0,f.body_ratio-p["body_min"])+max(0,p["close_loc_max"]-f.close_loc)+max(0,p["taker_signed_max"]-f.taker_signed)
    if k.startswith("V10C_BEAR_BREAKDOWN"):
        break_atr=(f.prior_low-close)/f.atr
        if not (break_atr>=p["break_atr_min"] and f.body_ratio>=p["body_min"] and f.close_loc<=p["close_loc_max"] and f.volume_z>=p["volume_z_min"] and f.taker_signed<=p["taker_signed_max"] and f.ret3_atr<=p["ret3_atr_max"]): return None
        return max(0,break_atr-p["break_atr_min"])+max(0,f.body_ratio-p["body_min"])+max(0,f.volume_z-p["volume_z_min"])+max(0,p["ret3_atr_max"]-f.ret3_atr)
    raise RuntimeError(f"unknown candidate {k}")


def outcome(c: dict[str,Any], f: Feature, bars: list[Bar], idx: int, score: float, end_ms: int) -> Trade | None:
    if idx+1+MAX_HOLD>len(bars): return None
    entry_i=idx+1; last_i=entry_i+MAX_HOLD-1
    if bars[last_i].ts+BAR_MS>end_ms: return None
    entry=bars[entry_i].o
    atr_bps=f.atr/entry*10000
    stop_bps=clamp(STOP_ATR*atr_bps,MIN_BARRIER_BPS,MAX_BARRIER_BPS)
    target_bps=clamp(TARGET_ATR*atr_bps,MIN_BARRIER_BPS,MAX_BARRIER_BPS)
    side=c["side"]
    if side=="LONG": tp=entry*(1+target_bps/10000); sl=entry*(1-stop_bps/10000)
    else: tp=entry*(1-target_bps/10000); sl=entry*(1+stop_bps/10000)
    exit_price=bars[last_i].c; exit_i=last_i; reason="TIME"
    for j in range(entry_i,last_i+1):
        b=bars[j]
        stop_hit=(b.l<=sl) if side=="LONG" else (b.h>=sl)
        target_hit=(b.h>=tp) if side=="LONG" else (b.l<=tp)
        if stop_hit:
            exit_price=sl; exit_i=j; reason="STOP"; break
        if target_hit:
            exit_price=tp; exit_i=j; reason="TARGET"; break
    gross=((exit_price/entry-1) if side=="LONG" else (1-exit_price/entry))*10000
    return Trade(c["key"],c["lane"],f.asset,side,f.ts,bars[entry_i].ts,bars[exit_i].ts+BAR_MS,gross,gross-BASE_COST,gross-STRESS_COST,score,reason)


def portfolio(trades: list[Trade]) -> list[Trade]:
    grouped=defaultdict(list)
    for t in trades: grouped[t.entry_ts].append(t)
    active=[]; admitted=[]
    for ts in sorted(grouped):
        active=[x for x in active if x.exit_ts>ts]
        used={x.asset for x in active}; slots=MAX_POSITIONS-len(active)
        if slots<=0: continue
        choices=sorted(grouped[ts],key=lambda x:(-x.score,x.asset,x.key))
        for t in choices:
            if slots<=0: break
            if t.asset in used: continue
            admitted.append(t); active.append(t); used.add(t.asset); slots-=1
    return admitted


def metrics(trades: list[Trade]) -> dict[str,Any]:
    trades=sorted(trades,key=lambda t:(t.entry_ts,t.asset,t.key))
    n=len(trades); total=sum(t.stress for t in trades); pos=sum(max(0,t.stress) for t in trades); neg=sum(min(0,t.stress) for t in trades)
    pf=(pos/-neg) if neg<0 else (999.0 if pos>0 else 0.0)
    eq=0.0; peak=0.0; dd=0.0
    by_market=defaultdict(list)
    for t in trades:
        eq+=t.stress; peak=max(peak,eq); dd=min(dd,eq-peak); by_market[t.asset].append(t)
    days=len({t.entry_ts//DAY_MS for t in trades})
    max_share=max((len(v)/n for v in by_market.values()),default=0.0)
    winner=max(by_market,key=lambda a:sum(t.stress for t in by_market[a]),default=None)
    wo=[t for t in trades if t.asset!=winner] if winner else []
    wtotal=sum(t.stress for t in wo); wpos=sum(max(0,t.stress) for t in wo); wneg=sum(min(0,t.stress) for t in wo)
    wpf=(wpos/-wneg) if wneg<0 else (999.0 if wpos>0 else 0.0)
    if trades:
        mid=(trades[0].entry_ts+trades[-1].entry_ts)//2
        h1=sum(t.stress for t in trades if t.entry_ts<=mid); h2=sum(t.stress for t in trades if t.entry_ts>mid)
    else: h1=h2=0.0
    return {"trades":n,"signal_days":days,"wins":sum(t.stress>0 for t in trades),"stress_bps":round(total,3),"mean_stress_bps":round(total/n,3) if n else 0.0,"stress_pf":round(pf,4),"max_drawdown_bps":round(dd,3),"max_market_share":round(max_share,4),"top_market":winner,"without_top_market_stress_bps":round(wtotal,3),"without_top_market_mean_bps":round(wtotal/len(wo),3) if wo else 0.0,"without_top_market_pf":round(wpf,4),"first_half_stress_bps":round(h1,3),"second_half_stress_bps":round(h2,3),"gross_bps":round(sum(t.gross for t in trades),3),"base_bps":round(sum(t.base for t in trades),3)}


def eval_interval(c: dict[str,Any], start_ms: int, end_ms: int, bars: dict[str,list[Bar]], feats: dict[str,dict[int,Feature]], indices: dict[str,dict[int,int]]) -> tuple[list[Trade],dict[str,Any]]:
    raw=[]
    for a in ASSETS:
        bs=bars[a]; im=indices[a]
        for ts,f in feats[a].items():
            if ts<start_ms or ts>=end_ms: continue
            idx=im[ts]; sc=signal(c,f,bs[idx].c)
            if sc is None: continue
            t=outcome(c,f,bs,idx,sc,end_ms)
            if t is not None: raw.append(t)
    p=portfolio(raw)
    return p,metrics(p)


def folds():
    start=ms(DISC_START)
    out=[]
    for i in range(4):
        fs=start+i*40*DAY_MS
        train_s=fs; train_e=fs+120*DAY_MS
        val_s=train_e+16*BAR_MS; val_e=fs+160*DAY_MS
        out.append((i+1,train_s,train_e,val_s,val_e))
    if out[-1][-1]!=ms(DISC_END): raise RuntimeError("fold schedule mismatch")
    return out


def discover(bars,feats,indices):
    rows=[]
    by_key={}
    for c in CANDIDATES:
        train_all=[]; val_all=[]; fold_rows=[]
        for no,ts,te,vs,ve in folds():
            tt,tm=eval_interval(c,ts,te,bars,feats,indices)
            vt,vm=eval_interval(c,vs,ve,bars,feats,indices)
            train_all.extend(tt); val_all.extend(vt)
            fold_rows.append({"fold":no,"train":tm,"validation":vm})
        train_m=metrics(sorted(train_all,key=lambda t:(t.entry_ts,t.asset)))
        val_m=metrics(sorted(val_all,key=lambda t:(t.entry_ts,t.asset)))
        positive_folds=sum(r["validation"]["stress_bps"]>0 for r in fold_rows)
        by_key[c["key"]]={"candidate":c,"train":train_m,"validation":val_m,"folds":fold_rows,"positive_validation_folds":positive_folds}
    groups=defaultdict(list)
    for c in CANDIDATES: groups[c["group"]].append(c["key"])
    selected={}
    for lane in ("RANGE","BEAR"):
        eligible=[]
        for c in CANDIDATES:
            if c["lane"]!=lane: continue
            r=by_key[c["key"]]; tr=r["train"]; va=r["validation"]
            neighbor_ok=False
            for nk in groups[c["group"]]:
                if nk==c["key"]: continue
                nr=by_key[nk]
                if nr["validation"]["stress_bps"]>0 and nr["positive_validation_folds"]>=2: neighbor_ok=True
            gates={
                "train_positive":tr["mean_stress_bps"]>0 and tr["stress_pf"]>1,
                "validation_min_trades":va["trades"]>=80,
                "validation_min_days":va["signal_days"]>=20,
                "validation_positive_folds":r["positive_validation_folds"]>=3,
                "validation_pf":va["stress_pf"]>=1.05,
                "validation_mean":va["mean_stress_bps"]>=1.0,
                "market_share":va["max_market_share"]<=0.35,
                "top_market_removal":va["without_top_market_mean_bps"]>0 and va["without_top_market_pf"]>1,
                "half_stability":va["first_half_stress_bps"]>0 and va["second_half_stress_bps"]>0,
                "neighbor":neighbor_ok,
            }
            r["gates"]=gates; r["eligible"]=all(gates.values())
            if r["eligible"]: eligible.append(r)
        if eligible:
            eligible.sort(key=lambda r:(-r["validation"]["stress_bps"],-r["validation"]["max_drawdown_bps"],r["candidate"]["key"]))
            selected[lane]=eligible[0]["candidate"]["key"]
        else: selected[lane]=None
    return {"mode":"DISCOVERY","revision":"V10_CONTINUATION_RANGE_BEAR_20260830","candidate_universe_sha256":sha(CANDIDATES),"data_window":[DISC_START.isoformat(),DISC_END.isoformat()],"candidates":by_key,"selected":selected,"test_accessed":False}


def test_run(bars,feats,indices,lock):
    if lock.get("candidate_universe_sha256")!=sha(CANDIDATES): raise RuntimeError("candidate universe hash mismatch")
    keys=lock.get("selected")
    if not isinstance(keys,dict) or not keys.get("RANGE") or not keys.get("BEAR"): raise RuntimeError("lock must contain one RANGE and one BEAR candidate")
    by={c["key"]:c for c in CANDIDATES}
    lane_results={}; combined=[]
    for lane in ("RANGE","BEAR"):
        key=keys[lane]
        if key not in by or by[key]["lane"]!=lane: raise RuntimeError(f"invalid locked {lane} candidate")
        t,m=eval_interval(by[key],ms(TEST_START),ms(TEST_END),bars,feats,indices)
        combined.extend(t)
        passed=m["trades"]>=20 and m["stress_bps"]>0 and m["stress_pf"]>1 and m["max_market_share"]<=0.40 and m["without_top_market_stress_bps"]>0
        lane_results[lane]={"candidate":key,"metrics":m,"passed":passed}
    cm=metrics(portfolio(combined))
    portfolio_ok=cm["stress_bps"]>0 and abs(cm["max_drawdown_bps"])<=cm["stress_bps"]
    return {"mode":"TEST","revision":"V10_CONTINUATION_RANGE_BEAR_20260830","candidate_universe_sha256":sha(CANDIDATES),"lock_sha256":sha(lock),"test_window":[TEST_START.isoformat(),TEST_END.isoformat()],"lanes":lane_results,"combined":cm,"portfolio_requirement_passed":portfolio_ok,"passed":all(x["passed"] for x in lane_results.values()) and portfolio_ok,"test_accessed":True}


def main():
    mode="TEST" if LOCK_PATH.exists() else "DISCOVERY"
    bars=load_bars(mode)
    feats,indices=build_features(bars)
    if mode=="DISCOVERY": result=discover(bars,feats,indices)
    else: result=test_run(bars,feats,indices,json.loads(LOCK_PATH.read_text()))
    OUT_PATH.write_text(json.dumps(result,ensure_ascii=False,sort_keys=True,indent=2)+"\n")
    print("V10_CONT_RESULT_BEGIN")
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))
    print("V10_CONT_RESULT_END")
    return 0

if __name__=="__main__":
    try: raise SystemExit(main())
    except Exception as e:
        print(f"V10_CONTINUATION_FAILED: {type(e).__name__}: {e}",file=sys.stderr)
        raise
