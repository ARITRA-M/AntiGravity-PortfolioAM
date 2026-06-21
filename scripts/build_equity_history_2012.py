#!/usr/bin/env python3
"""Reconstruct ACTUAL equity (stocks+ETF+MF) net-worth history since 2012 by
replaying the Numbers transaction log and valuing holdings at month-end using
fetched historical prices. Output: data/equity_history_2012.json (plaintext,
served behind auth like transaction_history.json). Current values untouched.
"""
import json, os, sys, time, urllib.request, datetime
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NUMBERS = os.path.join(ROOT, 'AM Portfolio Transactions.numbers')
TXN_HIST = os.path.join(ROOT, 'data', 'transaction_history.json')
CACHE = os.path.join(ROOT, 'scripts', '_price_cache.json')
OUT = os.path.join(ROOT, 'data', 'equity_history_2012.json')

# ---- MF scheme -> mfapi code (from app.js MF_SCHEME_CODES) ----
MF_CODES = {
  "Axis Small Cap Fund Direct-Growth":125354,"HDFC Small Cap Fund Direct- Growth":130503,
  "UTI Nifty Next 50 Index Fund Direct - Growth":143341,"Axis Midcap Direct Plan-Growth":120505,
  "Parag Parikh Flexi Cap Fund Direct-Growth":122639,"Motilal Oswal Nasdaq 100 FOF Direct - Growth":145552,
  "Navi Nifty 50 Index Fund Direct - Growth":149039,"Quant Mid Cap Fund Direct-Growth":120841,
  "Canara Robeco Small Cap Fund Direct - Growth":146130,"Navi Nifty Next 50 Index Fund Direct - Growth":149447,
  "Axis Greater China Equity FoF Direct-Growth":148699,"HDFC BSE Sensex Index Fund Direct-Growth":119065,
  "Edelweiss US Technology Equity FoF Direct - Growth":148063,"Quant Small Cap Fund Direct Plan-Growth":120828,
  "Kotak Midcap Fund Direct-Growth":119775,"PGIM India Global Equity Opportunities FoF Direct-Growth":138528,
  "Navi Nasdaq100 US Specific Equity Passive FoF Direct - Growth":149910,
  "Nippon India Nifty IT Index Fund Direct - Growth":152392,
}
# ETF / special Yahoo symbols (NSE)
ETF_SYMS = {
  'NIFTYBEES':'NIFTYBEES.NS','JUNIORBEES':'JUNIORBEES.NS','LIQUIDBEES':'LIQUIDBEES.NS',
  'GOLDBEES':'GOLDBEES.NS','BANKBEES':'BANKBEES.NS','BANKIETF':'BANKIETF.NS',
  'SBIGETS':'SETFGOLD.NS','FMCGIETF':'FMCGIETF.NS',
}
# Exited / renamed holdings whose company name wasn't in transaction_history ticker_map.
EXITED_TICKERS = {
  'Aurobindo Pharma Ltd.':'AUROPHARMA','Chambal Fertilisers & Chemicals Ltd.':'CHAMBLFERT',
  'City Union Bank Ltd.':'CUB','DCB Bank Ltd.':'DCBBANK','Equitas Small Finance Bank Ltd.':'EQUITASBNK',
  'Finolex Industries Ltd.':'FINPIPE','GATI':'GATI','General Insurance Corporation of India':'GICRE',
  'Gland Pharma Ltd.':'GLAND','Go Digit General Insurance Ltd.':'GODIGIT',
  'Gujarat Alkalies & Chemicals Ltd.':'GUJALKALI','Gujarat Mineral Development Corporation Ltd.':'GMDCLTD',
  'Gujarat Narmada Valley Fertilizers & Chemicals Ltd.':'GNFC','Hyundai Motor India Ltd.':'HYUNDAI',
  'Insecticides (India) Ltd.':'INSECTICID','JK Lakshmi Cement Ltd.':'JKLAKSHMI','Jyothy Labs Ltd.':'JYOTHYLAB',
  'Kalyani Steels Ltd.':'KSL','Kirloskar Ferrous Industries Ltd.':'KIRLFER','LT Foods Ltd.':'LTFOODS',
  'LTIM':'LTIM','Lupin Ltd.':'LUPIN','Maharashtra Seamless Ltd.':'MAHSEAMLES',
  'Mahindra Lifespace Developers Ltd.':'MAHLIFE','Orient Cement Ltd.':'ORIENTCEM','PB Fintech Ltd.':'POLICYBZR',
  'Redington Ltd.':'REDINGTON','Sagar Cements Ltd.':'SAGCEM','Srikalahasthi Pipes Ltd.':'SRIPIPES',
  'Star Health and Allied Insurance Company Ltd.':'STARHEALTH','Sunteck Realty Ltd.':'SUNTECK',
  'TATAMOTORS':'TATAMOTORS',
}
# Liquid funds with no equity exposure — value at cost (treat NAV growth as ~0 impact).
LIQUID_FUNDS = {'Axis Liquid Direct Fund-Growth','Edelweiss Liquid Direct-Growth',
                'Franklin India Liquid Fund Super Institutional Plan Direct-Growth'}
def _norm_mf(name):
    return name.replace(' - ','-').replace(' -','-').replace('- ','-').replace('  ',' ').strip().lower()
MF_CODES_NORM = {_norm_mf(k):v for k,v in MF_CODES.items()}

def load_cache():
    try: return json.load(open(CACHE))
    except: return {}
def save_cache(c): json.dump(c, open(CACHE,'w'))

cache = load_cache()

def yahoo_monthly(sym):
    """Return {YYYY-MM: close} or None."""
    if sym in cache: return cache[sym]
    url=f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1mo&range=15y"
    try:
        req=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
        d=json.load(urllib.request.urlopen(req, timeout=20))
        r=d['chart']['result'][0]
        ts=r['timestamp']; cl=r['indicators']['quote'][0]['close']
        out={}
        for t,c in zip(ts,cl):
            if c is None: continue
            dt=datetime.date.fromtimestamp(t)
            out[f"{dt.year}-{dt.month:02d}"]=round(c,4)
        cache[sym]=out; save_cache(cache); time.sleep(0.4)
        return out
    except Exception as e:
        cache[sym]=None; save_cache(cache)
        return None

def mfapi_monthly(code):
    key=f"MF{code}"
    if key in cache: return cache[key]
    try:
        d=json.load(urllib.request.urlopen(f"https://api.mfapi.in/mf/{code}", timeout=20))
        out={}
        for e in d.get('data',[]):
            dd,mm,yy=e['date'].split('-')
            k=f"{yy}-{mm}"
            # keep the LAST (latest) nav seen per month while iterating (data is newest-first)
            if k not in out: out[k]=float(e['nav'])
        cache[key]=out; save_cache(cache); time.sleep(0.3)
        return out
    except Exception as e:
        cache[key]=None; save_cache(cache); return None

# ---- Parse Numbers transactions ----
from numbers_parser import Document
doc=Document(NUMBERS)
th=json.load(open(TXN_HIST))
TMAP=th.get('ticker_map',{})  # company -> ticker

def parse_sheet(idx, kind):
    t=doc.sheets[idx].tables[0]
    rows=[]
    for r in range(1,t.num_rows):
        try:
            dv=str(t.cell(r,0).value or '').strip()
            name=str(t.cell(r,1).value or '').strip()
            typ=str(t.cell(r,3).value or '').strip().upper()
            qty=float(t.cell(r,4).value or 0)
            px=float(t.cell(r,5).value or 0)
            if not dv or not name or not typ: continue
            d=datetime.datetime.strptime(dv,'%d-%m-%Y').date()
            rows.append({'date':d,'name':name,'type':typ,'qty':qty,'price':px,'kind':kind})
        except: pass
    return rows

txns = parse_sheet(0,'stock') + parse_sheet(2,'etf') + parse_sheet(1,'mf')
txns.sort(key=lambda x:x['date'])
print(f"Parsed {len(txns)} transactions, {txns[0]['date']}..{txns[-1]['date']}")

# Map each txn to a price key (yahoo sym for stock/etf, mf code for mf) and a canonical id
def resolve(t):
    if t['kind']=='mf':
        if t['name'] in LIQUID_FUNDS: return ('liquid', t['name'], None)
        code=MF_CODES.get(t['name']) or MF_CODES_NORM.get(_norm_mf(t['name']))
        return ('mf', t['name'], code)
    tk=TMAP.get(t['name']) or EXITED_TICKERS.get(t['name']) or t['name']
    if tk in ETF_SYMS: return ('etf', tk, ETF_SYMS[tk])
    if t['kind']=='etf':
        return ('etf', tk, ETF_SYMS.get(tk, tk+'.NS'))
    return ('stock', tk, tk+'.NS')

# ---- Build month-end holdings by replay ----
months=[]
d=datetime.date(2012,1,31)
end=datetime.date(2026,6,1)
def month_end(y,m):
    if m==12: return datetime.date(y,12,31)
    return datetime.date(y,m+1,1)-datetime.timedelta(days=1)
y,m=2012,1
while datetime.date(y,m,1)<=end:
    months.append(month_end(y,m)); m+=1
    if m>12: y+=1; m=1

# running qty + cost basis per canonical id
qty=defaultdict(float); invested=defaultdict(float); meta={}
ti=0
hist_qty=[]   # list over months: {id: qty}
hist_inv=[]
for me in months:
    while ti<len(txns) and txns[ti]['date']<=me:
        t=txns[ti]; ti+=1
        kind,cid,pkey=resolve(t)
        meta[cid]={'kind':kind,'pkey':pkey,'name':t['name']}
        if t['type']=='BUY':
            qty[cid]+=t['qty']; invested[cid]+=t['qty']*t['price']
        elif t['type']=='SELL':
            s=min(t['qty'],qty[cid]); avg=invested[cid]/qty[cid] if qty[cid]>0 else 0
            invested[cid]-=avg*s; qty[cid]-=s
            if qty[cid]<1e-6: qty[cid]=0
        elif t['type'] in ('SPLIT','BONUS'):
            qty[cid]+=t['qty']
    hist_qty.append({k:v for k,v in qty.items() if v>1e-6})
    hist_inv.append({k:invested[k] for k in qty if qty[k]>1e-6})

# ---- Fetch prices for all involved ids ----
ids=set()
for hq in hist_qty: ids.update(hq.keys())
print(f"{len(ids)} unique instruments held at some point")
prices={}
fail=[]
for cid in sorted(ids):
    info=meta[cid]
    if info['kind']=='mf':
        p=mfapi_monthly(info['pkey']) if info['pkey'] else None
    else:
        p=yahoo_monthly(info['pkey'])
    prices[cid]=p
    if not p: fail.append(f"{cid}({info['pkey']})")
print(f"price fetch: {len(ids)-len(fail)} ok, {len(fail)} failed")
if fail: print("  failed:", ', '.join(fail[:40]))

# ---- Value monthly ----
def price_at(cid, ym, me):
    p=prices.get(cid)
    if not p: return None
    if ym in p: return p[ym]
    # fallback: nearest earlier month within 4 months
    yy,mm=map(int,ym.split('-'))
    for back in range(1,5):
        mm-=1
        if mm<1: mm=12; yy-=1
        k=f"{yy}-{mm:02d}"
        if k in p: return p[k]
    return None

series=[]
covered_val=[]
for i,me in enumerate(months):
    ym=f"{me.year}-{me.month:02d}"
    tot=0; inv=0; cov=0; miss=0
    for cid,q in hist_qty[i].items():
        if meta[cid]['kind']=='liquid':
            tot+=hist_inv[i].get(cid,0); cov+=1; continue  # liquid: value ≈ cost
        px=price_at(cid,ym,me)
        if px is None: miss+=1; continue
        tot+=q*px; cov+=1
    for cid,v in hist_inv[i].items(): inv+=v
    series.append({'date':me.isoformat(),'equity_value':round(tot/1e5,4),
                   'invested':round(inv/1e5,4),'holdings':cov,'missing':miss})

# trim leading all-zero months
while series and series[0]['equity_value']==0: series.pop(0)
print(f"\nSeries {series[0]['date']}..{series[-1]['date']} ({len(series)} months)")
for s in series[::12]:
    print(f"  {s['date']}: equity ₹{s['equity_value']:.1f}L invested ₹{s['invested']:.1f}L ({s['holdings']} held, {s['missing']} missing px)")
print(f"  LAST {series[-1]['date']}: equity ₹{series[-1]['equity_value']:.1f}L ({series[-1]['holdings']} held, {series[-1]['missing']} missing)")

out={'generated':datetime.date.today().isoformat(),
     'note':'Actual equity (stocks+ETF+MF) net worth reconstructed from transactions + historical month-end prices. Equity-only; excludes PF/PPF/NPS/Gold/Cash.',
     'series':series,
     'price_coverage':{'instruments':len(ids),'failed':len(fail),'failed_list':fail}}
json.dump(out, open(OUT,'w'), separators=(',',':'))
print(f"\nWrote {OUT} ({os.path.getsize(OUT)//1024} KB)")