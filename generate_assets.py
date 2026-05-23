import pandas as pd
import numpy as np
import json
import os
import re
import datetime

excel_file = "Portfolio Analysis(1).xlsx"
out_dir = "data/"
os.makedirs(out_dir, exist_ok=True)

# 1. Sector mappings for Stocks / Equities
SECTOR_MAP = {
    # Pharmaceuticals & Biotech
    "AJANTPHARM": "Pharmaceuticals",
    "CIPLA": "Pharmaceuticals",
    "DRREDDY": "Pharmaceuticals",
    "ERIS": "Pharmaceuticals",
    "JBCHEPHARM": "Pharmaceuticals",
    "LALPATHLAB": "Healthcare & Diagnostics",
    "MANKIND": "Pharmaceuticals",
    "SUNPHARMA": "Pharmaceuticals",
    "SYNGENE": "Biotechnology",
    "ZYDUSLIFE": "Pharmaceuticals",
    
    # Auto & Ancillaries
    "APOLLOTYRE": "Automobile & Ancillaries",
    "BAJAJ-AUTO": "Automobile & Ancillaries",
    "BALKRISIND": "Automobile & Ancillaries",
    "EICHERMOT": "Automobile & Ancillaries",
    "ENDURANCE": "Automobile & Ancillaries",
    "EXIDEIND": "Automobile & Ancillaries",
    "HEROMOTOCO": "Automobile & Ancillaries",
    "M&M": "Automobile & Ancillaries",
    "MOTHERSON": "Automobile & Ancillaries",
    "TVSMOTOR": "Automobile & Ancillaries",
    "UNOMINDA": "Automobile & Ancillaries",
    
    # Banking & Financials
    "AXISBANK": "Banking & Financial Services",
    "BAJFINANCE": "Banking & Financial Services",
    "BANKBARODA": "Banking & Financial Services",
    "BANKIETF": "Banking & Financial Services (ETF)",
    "FEDERALBNK": "Banking & Financial Services",
    "HDFCBANK": "Banking & Financial Services",
    "HDFCLIFE": "Insurance",
    "ICICIBANK": "Banking & Financial Services",
    "ICICIGI": "Insurance",
    "ICICIPRULI": "Insurance",
    "KARURVYSYA": "Banking & Financial Services",
    "KOTAKBANK": "Banking & Financial Services",
    "MFSL": "Banking & Financial Services",
    "SBILIFE": "Insurance",
    "SBIN": "Banking & Financial Services",
    
    # Real Estate & REITs
    "BRIGADE": "Real Estate & Construction",
    "DLF": "Real Estate & Construction",
    "EMBASSY-RR": "Real Estate (REIT)",
    "GODREJPROP": "Real Estate & Construction",
    "MINDSPACE-RR": "Real Estate (REIT)",
    "NXST-RR": "Real Estate (REIT)",
    "OBEROIRLTY": "Real Estate & Construction",
    "PHOENIXLTD": "Real Estate & Construction",
    "PRESTIGE": "Real Estate & Construction",
    
    # Consumer Goods & FMCG
    "BRITANNIA": "Consumer Goods & FMCG",
    "COLPAL": "Consumer Goods & FMCG",
    "FMCGIETF": "Consumer Goods & FMCG (ETF)",
    "ITC": "Consumer Goods & FMCG",
    "MARICO": "Consumer Goods & FMCG",
    "NESTLEIND": "Consumer Goods & FMCG",
    "TATACONSUM": "Consumer Goods & FMCG",
    "VBL": "Consumer Goods & FMCG",
    
    # IT & Telecom
    "COFORGE": "IT & Software Services",
    "HCLTECH": "IT & Software Services",
    "INFY": "IT & Software Services",
    "KPITTECH": "IT & Software Services",
    "MPHASIS": "IT & Software Services",
    "OFSS": "IT & Software Services",
    "PERSISTENT": "IT & Software Services",
    "TCS": "IT & Software Services",
    "BHARTIARTL": "Telecommunication Services",
    
    # Industrials, Materials & Energy
    "CIEINDIA": "Industrial Engineering",
    "COALINDIA": "Energy & Mining",
    "LT": "Engineering & Construction",
    "ONGC": "Energy & Mining",
    "PIDILITIND": "Chemicals & Adhesives",
    "SIEMENS": "Industrial Engineering",
    "TATASTEEL": "Metals & Mining",
    
    # Gold & Bonds (Commodities)
    "GOLDBEES": "Gold Commodity (ETF)",
    "SGBAUG28V": "Sovereign Gold Bonds",
    "SGBJUL28IV-GB": "Sovereign Gold Bonds",
    "SGBSEP28VI-GB": "Sovereign Gold Bonds",
    "716GS2050-GS": "Government Bonds",
    "738REC27TF": "Corporate Bonds",
    "TVSMNCRPS": "Debt Instrument",
    "ENRIN": "Industrial Engineering"
}

def clean_float(val):
    if pd.isna(val) or val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().replace('%', '').replace('\n', '').replace(' ', '').replace(',', '')
    if s == '' or s == '-' or s == 'nan':
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0

# Column mapping helper to normalize varying schemas in historical sheets
def normalize_dataframe(df):
    col_mapping = {
        'Company': 'Instrument',
        'Quantity': 'Qty.',
        'Current Price': 'LTP',
        'Average Buy Price': 'Avg. cost',
        'Average Buy NAV': 'Avg. cost',
        'Amount Invested': 'Invested',
        'Total Investment': 'Invested',
        'Current Price ': 'LTP',
        'Current Valuation': 'Cur. val',
        'Gain/Loss': 'P&L',
        'Gain/ Loss': 'P&L',
        'Unrealised Gain/Loss': 'P&L',
        'Gain %': 'Gain %',
        'Gain/ Loss %': 'Gain %',
        'Scheme': 'Instrument',
        'Scheme Type': 'Category'
    }
    
    # Clean column names in df
    df.columns = [str(c).strip() for c in df.columns]
    
    # Rename columns based on mapping
    rename_dict = {}
    for col in df.columns:
        if col in col_mapping:
            rename_dict[col] = col_mapping[col]
            
    df = df.rename(columns=rename_dict)
    return df

# Load workbook sheet names
print("Loading workbook...")
wb = pd.ExcelFile(excel_file)
sheet_names = wb.sheet_names

# 2. Extract Date Sheets chronologically
# Format: YYYYMMDD E or YYYYMMDD MF
e_pattern = re.compile(r"^(\d{8})\s+E$")
mf_pattern = re.compile(r"^(\d{8})\s+MF$")

e_sheets = []
mf_sheets = []

for s in sheet_names:
    m_e = e_pattern.match(s)
    if m_e:
        e_sheets.append((m_e.group(1), s))
    m_mf = mf_pattern.match(s)
    if m_mf:
        mf_sheets.append((m_mf.group(1), s))

# Sort chronologically by date string
e_sheets.sort(key=lambda x: x[0])
mf_sheets.sort(key=lambda x: x[0])

print(f"Found {len(e_sheets)} equity sheets and {len(mf_sheets)} mutual fund sheets.")

# 3. Parse Breakup Sheet
print("Processing Breakup sheet...")
df_b = pd.read_excel(excel_file, sheet_name='Breakup', header=None)

# The date columns are from index 2 to index 66
header_row = df_b.iloc[0].tolist()
date_cols = []
for idx in range(2, 67):
    val = header_row[idx]
    if isinstance(val, (pd.Timestamp, datetime.datetime)):
        date_cols.append((idx, val.strftime('%Y-%m-%d')))
    elif isinstance(val, str):
        date_cols.append((idx, val.strip()))
    else:
        date_cols.append((idx, f"Period_{idx}"))

sections = {
    "net_worth": (3, 15),
    "contribution": (17, 27),
    "new_investment": (29, 41),
    "returns": (43, 55),
    "net_change": (57, 69),
    "net_cashflows": (71, 83),
    "xirr": (85, 97),
    "pct_returns": (101, 113)
}

breakup_data = {}
for name, (start, end) in sections.items():
    section_dict = {}
    for r_idx in range(start, end):
        row_label = df_b.iloc[r_idx, 0]
        asset_type = df_b.iloc[r_idx, 1]
        
        if pd.isna(row_label):
            row_label = "Total"
        else:
            row_label = str(row_label).strip()
            
        values = []
        for col_idx, date_str in date_cols:
            val = df_b.iloc[r_idx, col_idx]
            values.append(clean_float(val))
            
        key = f"{row_label} ({asset_type})" if pd.notna(asset_type) else row_label
        section_dict[key] = {
            "label": row_label,
            "asset_type": asset_type if pd.notna(asset_type) else None,
            "values": values
        }
    breakup_data[name] = section_dict

breakup_data["dates"] = [d[1] for d in date_cols]
with open(os.path.join(out_dir, "breakup_summary.json"), "w") as f:
    json.dump(breakup_data, f, indent=2)
print("Saved breakup_summary.json")

# 4. Parse Historical Holdings Stock-by-Stock & Fund-by-Fund
print("Processing historical holdings...")
historical_holdings = {
    "stocks": {},
    "mfs": {}
}

# Parse all Equity sheets chronologically
for date_str, sheet_name in e_sheets:
    formatted_date = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    df = pd.read_excel(excel_file, sheet_name=sheet_name)
    df = normalize_dataframe(df)
    
    # Drop empty instrument names and 'Total' rows
    df = df.dropna(subset=['Instrument'])
    df = df[df['Instrument'] != 'Total']
    
    for idx, row in df.iterrows():
        inst_name = str(row['Instrument']).strip()
        qty = clean_float(row.get('Qty.', 0))
        avg_cost = clean_float(row.get('Avg. cost', 0))
        ltp = clean_float(row.get('LTP', 0))
        invested = clean_float(row.get('Invested', 0))
        cur_val = clean_float(row.get('Cur. val', 0))
        pnl = clean_float(row.get('P&L', 0))
        gain_pct = clean_float(row.get('Gain %', 0))
        
        # If gain_pct is a fraction (e.g. 1.22 for 122%), multiply by 100
        # If it is already a large percentage (>10 for example), we leave it
        if abs(gain_pct) < 10.0 and gain_pct != 0.0:
            # Let's verify: gain_pct * 100.
            gain_pct = gain_pct * 100
            
        sector = SECTOR_MAP.get(inst_name, "Other Equities")
        
        if inst_name not in historical_holdings["stocks"]:
            historical_holdings["stocks"][inst_name] = {
                "instrument": inst_name,
                "sector": sector,
                "history": []
            }
            
        historical_holdings["stocks"][inst_name]["history"].append({
            "date": formatted_date,
            "qty": qty,
            "avg_cost": avg_cost,
            "ltp": ltp,
            "invested": invested,
            "cur_val": cur_val,
            "pnl": pnl,
            "gain_pct": gain_pct
        })

# Parse all Mutual Fund sheets chronologically
for date_str, sheet_name in mf_sheets:
    formatted_date = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    df = pd.read_excel(excel_file, sheet_name=sheet_name)
    df = normalize_dataframe(df)
    
    df = df.dropna(subset=['Instrument'])
    df = df[df['Instrument'] != 'Total']
    
    for idx, row in df.iterrows():
        inst_name = str(row['Instrument']).strip()
        category = str(row.get('Category', 'Other')).strip()
        qty = clean_float(row.get('Qty.', 0))
        avg_cost = clean_float(row.get('Avg. cost', 0))
        ltp = clean_float(row.get('LTP', 0))
        invested = clean_float(row.get('Invested', 0))
        cur_val = clean_float(row.get('Cur. val', 0))
        pnl = clean_float(row.get('P&L', 0))
        gain_pct = clean_float(row.get('Gain %', 0))
        
        if abs(gain_pct) < 10.0 and gain_pct != 0.0:
            gain_pct = gain_pct * 100
            
        if inst_name not in historical_holdings["mfs"]:
            historical_holdings["mfs"][inst_name] = {
                "instrument": inst_name,
                "category": category,
                "history": []
            }
            
        historical_holdings["mfs"][inst_name]["history"].append({
            "date": formatted_date,
            "qty": qty,
            "avg_cost": avg_cost,
            "ltp": ltp,
            "invested": invested,
            "cur_val": cur_val,
            "pnl": pnl,
            "gain_pct": gain_pct
        })

with open(os.path.join(out_dir, "historical_holdings.json"), "w") as f:
    json.dump(historical_holdings, f, indent=2)
print("Saved historical_holdings.json")

# 5. Save latest positions (using latest dates)
latest_e_date, latest_e_sheet = e_sheets[-1]
latest_mf_date, latest_mf_sheet = mf_sheets[-1]

print(f"Latest equity sheet: {latest_e_sheet} (Date: {latest_e_date})")
print(f"Latest mutual fund sheet: {latest_mf_sheet} (Date: {latest_mf_date})")

# Clean latest positions specifically
latest_equity_list = []
for inst_name, info in historical_holdings["stocks"].items():
    # Get last item in history if it matches the latest date
    last_hist = info["history"][-1]
    formatted_latest_date = f"{latest_e_date[:4]}-{latest_e_date[4:6]}-{latest_e_date[6:8]}"
    if last_hist["date"] == formatted_latest_date and last_hist["qty"] > 0:
        latest_equity_list.append({
            "instrument": inst_name,
            "sector": info["sector"],
            "qty": last_hist["qty"],
            "avg_cost": last_hist["avg_cost"],
            "ltp": last_hist["ltp"],
            "invested": last_hist["invested"],
            "cur_val": last_hist["cur_val"],
            "pnl": last_hist["pnl"],
            "gain_pct": last_hist["gain_pct"]
        })

latest_mf_list = []
for inst_name, info in historical_holdings["mfs"].items():
    last_hist = info["history"][-1]
    formatted_latest_date = f"{latest_mf_date[:4]}-{latest_mf_date[4:6]}-{latest_mf_date[6:8]}"
    if last_hist["date"] == formatted_latest_date and last_hist["qty"] > 0:
        latest_mf_list.append({
            "scheme": inst_name,
            "scheme_type": info["category"],
            "qty": last_hist["qty"],
            "price": last_hist["ltp"],
            "avg_nav": last_hist["avg_cost"],
            "invested": last_hist["invested"],
            "cur_val": last_hist["cur_val"],
            "pnl": last_hist["pnl"],
            "gain_pct": last_hist["gain_pct"]
        })

with open(os.path.join(out_dir, "latest_equity.json"), "w") as f:
    json.dump(latest_equity_list, f, indent=2)
with open(os.path.join(out_dir, "latest_mf.json"), "w") as f:
    json.dump(latest_mf_list, f, indent=2)
print("Saved latest_equity.json and latest_mf.json")

# 6. Generate Portfolio Summary Metrics
print("Generating final portfolio summary...")
latest_net_worth = breakup_data["net_worth"]
latest_date_idx = -1

total_nw = latest_net_worth["Total"]["values"][latest_date_idx]
eq_val = (
    latest_net_worth["Stocks (Equity)"]["values"][latest_date_idx] +
    latest_net_worth["Mutual Funds (Equity)"]["values"][latest_date_idx] +
    latest_net_worth["NPS E (Equity)"]["values"][latest_date_idx]
)
debt_val = (
    latest_net_worth["NPS C (Debt)"]["values"][latest_date_idx] +
    latest_net_worth["NPS G (Debt)"]["values"][latest_date_idx] +
    latest_net_worth["PF (Debt)"]["values"][latest_date_idx] +
    latest_net_worth["PPF (Debt)"]["values"][latest_date_idx] +
    latest_net_worth["Bonds (Debt)"]["values"][latest_date_idx]
)
gold_val = latest_net_worth["Gold (Gold)"]["values"][latest_date_idx]
liq_val = latest_net_worth["Cash (Liquid)"]["values"][latest_date_idx]
alt_val = latest_net_worth["Crypto (Alternate)"]["values"][latest_date_idx]

# Inflows (new investments)
new_inv_section = breakup_data["new_investment"]
cumulative_investments = []
running_sum = 0.0
for val in new_inv_section["Total Investment"]["values"]:
    running_sum += val
    cumulative_investments.append(running_sum)

portfolio_summary = {
    "total_net_worth_lakhs": total_nw,
    "equity_lakhs": eq_val,
    "debt_lakhs": debt_val,
    "gold_lakhs": gold_val,
    "liquid_lakhs": liq_val,
    "alternate_lakhs": alt_val,
    "allocation_pct": {
        "Equity": (eq_val / total_nw) * 100 if total_nw > 0 else 0,
        "Debt": (debt_val / total_nw) * 100 if total_nw > 0 else 0,
        "Gold": (gold_val / total_nw) * 100 if total_nw > 0 else 0,
        "Liquid": (liq_val / total_nw) * 100 if total_nw > 0 else 0,
        "Alternate": (alt_val / total_nw) * 100 if total_nw > 0 else 0
    },
    "cumulative_investment_history": cumulative_investments
}

with open(os.path.join(out_dir, "portfolio_summary.json"), "w") as f:
    json.dump(portfolio_summary, f, indent=2)
print("Saved portfolio_summary.json")
print("ALL PREPROCESSING AND ENRICHMENT COMPLETE! SUCCESS!")
