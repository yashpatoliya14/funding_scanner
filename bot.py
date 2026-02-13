import requests
import json
import sys
from datetime import datetime, timezone
from itertools import combinations

session = requests.Session()

# Default minimum funding rate difference (raw decimal, not percentage)
# 0.003 = 0.3% difference in funding rate
DEFAULT_MIN_FUNDING_DIFF = 0.003

# ========================
# EXCHANGE TRADE LINKS
# ========================

def get_exchange_url(exchange, symbol):
    """Generate a direct trading link for the symbol on the given exchange."""
    base = symbol.replace("USDT", "")

    if exchange == "Binance":
        return f"https://www.binance.com/en/futures/{symbol}"
    elif exchange == "Bybit":
        return f"https://www.bybit.com/trade/usdt/{symbol}"
    elif exchange == "Delta":
        return f"https://www.india.delta.exchange/app/futures/trade/{base}/USD"
    elif exchange == "CoinDCX":
        return f"https://coindcx.com/futures-trading/B-{base}_USDT"
    return "#"


# ============================
# LOAD FUNDING RATES + PRICES
# ============================

def load_binance_funding():
    """
    Binance: lastFundingRate is a raw decimal
    e.g., 0.00010000 = 0.01%
    Also fetches markPrice for spread calculations.
    """
    r = session.get("https://fapi.binance.com/fapi/v1/premiumIndex", timeout=10).json()
    funding = {}
    for x in r:
        sym = x["symbol"]
        rate = float(x["lastFundingRate"])
        next_time = int(x["nextFundingTime"])
        mark_price = float(x.get("markPrice", 0))
        # Skip quarterly contracts and inactive
        if "_" in sym or next_time == 0:
            continue
        funding[sym] = {
            "rate": rate,
            "next_funding": next_time,
            "mark_price": mark_price,
        }
    return funding


def load_bybit_funding():
    """
    Bybit: fundingRate is a raw decimal (same scale as Binance)
    e.g., 0.0000393 = 0.00393%
    Also fetches markPrice for spread calculations.
    """
    r = session.get(
        "https://api.bybit.com/v5/market/tickers",
        params={"category": "linear"},
        timeout=10
    ).json()

    funding = {}
    for x in r["result"]["list"]:
        sym = x["symbol"]
        rate_str = x.get("fundingRate", "")
        next_str = x.get("nextFundingTime", "0")
        if not rate_str or next_str == "0":
            continue
        rate = float(rate_str)
        next_time = int(next_str)
        mark_price = float(x.get("markPrice", 0))
        funding[sym] = {
            "rate": rate,
            "next_funding": next_time,
            "mark_price": mark_price,
        }
    return funding


def load_delta_funding():
    """
    Delta Exchange INDIA (api.india.delta.exchange)
    
    Symbols are in USD format (e.g., BTCUSD, ETHUSD)
    funding_rate is in percentage form:
        e.g., 0.01 means 0.01%
    We convert to raw decimal to match Binance/Bybit scale:
        raw_decimal = delta_rate / 100
    So 0.01 (Delta %) -> 0.0001 (raw decimal) = 0.01%

    Also fetches mark_price for spread calculations.
    """
    r = session.get("https://api.india.delta.exchange/v2/tickers", timeout=10).json()

    funding = {}
    for item in r["result"]:
        # Only perpetual futures have funding rates
        if item.get("contract_type") != "perpetual_futures":
            continue
        funding_rate_str = item.get("funding_rate")
        if funding_rate_str is None:
            continue

        sym = item["symbol"]
        # Delta rate is already in percentage form, convert to raw decimal
        delta_rate = float(funding_rate_str)
        raw_rate = delta_rate / 100  # 0.01% -> 0.0001

        mark_price = float(item.get("mark_price", 0))

        funding[sym] = {
            "rate": raw_rate,
            "next_funding": 0,  # Delta doesn't give next funding time in ticker
            "mark_price": mark_price,
        }
    return funding


def load_coindcx_funding():
    """
    CoinDCX public API (no auth needed).
    
    Endpoint: https://public.coindcx.com/market_data/v3/current_prices/futures/rt
    Symbol format: 'B-BTC_USDT' -> normalized to 'BTCUSDT'
    
    fr = funding rate (already in raw decimal, same as Binance/Bybit)
    efr = estimated funding rate
    mp = mark price
    """
    try:
        r = session.get("https://public.coindcx.com/market_data/v3/current_prices/futures/rt", timeout=10).json()

        funding = {}
        # The API returns data in 'prices' key
        prices = r.get("prices", {})
        
        for pair_key, data in prices.items():
            # Check for funding rate
            fr = data.get("fr")
            if fr is None:
                continue

            # Check for mark price
            mark_price = float(data.get("mp", 0))

            funding[pair_key] = {
                "rate": float(fr),
                "next_funding": 0,  # Not provided in this endpoint
                "mark_price": mark_price,
            }
        return funding
    except Exception as e:
        sys.stderr.write(f"Error loading CoinDCX: {e}\n")
        return {}


def normalize_symbol(sym, exchange=None):
    """
    Normalize symbol names across exchanges to find common pairs.
    
    Delta India uses USD suffix (BTCUSD), while Binance/Bybit use USDT (BTCUSDT).
    We normalize all to USDT format for matching.
    """
    sym = sym.upper().replace("-", "").replace("_", "")

    # CoinDCX: B-BTC_USDT -> BTCUSDT
    if exchange == "CoinDCX":
        # After initial normalization, 'B-BTC_USDT' becomes 'BBTCUSDT'.
        # We need to remove the leading 'B' if it exists.
        if sym.startswith("B"):
            sym = sym[1:]  # Remove 'B' prefix
    # Delta India: Convert XXXUSD -> XXXUSDT for matching
    elif exchange == "Delta":
        if sym.endswith("USD") and not sym.endswith("USDT") and not sym.endswith("USDC"):
            sym = sym + "T"  # BTCUSD -> BTCUSDT
    else:
        # For Binance/Bybit, skip inverse contracts (ending in USD but not USDT)
        if sym.endswith("USD") and not sym.endswith("USDT") and not sym.endswith("USDC"):
            return None

    # Only keep USDT pairs for comparison
    if not sym.endswith("USDT"):
        return None

    return sym


def format_funding(rate):
    """
    Format funding rate properly.
    Input: raw decimal (e.g., 0.00010000)
    Output: percentage string like '0.0100%'
    """
    pct = rate * 100  # convert to percentage
    return f"{pct:.4f}%"


def format_next_funding(timestamp_ms):
    """Format next funding time as HH:MM UTC"""
    if timestamp_ms == 0:
        return "N/A"
    dt = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
    return dt.strftime("%H:%M UTC")


def scan(min_diff=None, include_delta=True):
    """Run the full scanner and return structured data."""
    if min_diff is None:
        min_diff = DEFAULT_MIN_FUNDING_DIFF

    binance_funding = load_binance_funding()
    bybit_funding = load_bybit_funding()
    coindcx_funding = load_coindcx_funding()

    if include_delta:
        delta_funding = load_delta_funding()
    else:
        delta_funding = {}

    # Build normalized maps
    exchange_data = {
        "Binance": {},
        "Bybit": {},
        "CoinDCX": {},
    }
    if include_delta:
        exchange_data["Delta"] = {}

    for raw_sym, data in binance_funding.items():
        norm = normalize_symbol(raw_sym, exchange="Binance")
        if norm:
            exchange_data["Binance"][norm] = data

    for raw_sym, data in bybit_funding.items():
        norm = normalize_symbol(raw_sym, exchange="Bybit")
        if norm:
            exchange_data["Bybit"][norm] = data

    for raw_sym, data in coindcx_funding.items():
        norm = normalize_symbol(raw_sym, exchange="CoinDCX")
        if norm:
            exchange_data["CoinDCX"][norm] = data

    if include_delta:
        for raw_sym, data in delta_funding.items():
            norm = normalize_symbol(raw_sym, exchange="Delta")
            if norm:
                exchange_data["Delta"][norm] = data

    # Find all USDT symbols
    all_symbols = set()
    for ex_data in exchange_data.values():
        all_symbols.update(ex_data.keys())

    # Collect opportunities
    opportunities = []
    exchanges_list = list(exchange_data.keys())

    for sym in sorted(all_symbols):
        available = {}
        for ex in exchanges_list:
            if sym in exchange_data[ex]:
                available[ex] = exchange_data[ex][sym]

        if len(available) < 2:
            continue

        # Compare all pairs of exchanges
        ex_names = list(available.keys())
        for e1, e2 in combinations(ex_names, 2):
            r1 = available[e1]["rate"]
            r2 = available[e2]["rate"]
            diff = abs(r1 - r2)

            if diff >= min_diff:
                if r1 > r2:
                    short_ex = e1
                    long_ex = e2
                else:
                    short_ex = e2
                    long_ex = e1

                # Calculate price spread between exchanges
                price1 = available[e1].get("mark_price", 0)
                price2 = available[e2].get("mark_price", 0)
                price_diff = abs(price1 - price2)
                avg_price = (price1 + price2) / 2 if (price1 > 0 and price2 > 0) else 0
                spread_pct = (price_diff / avg_price * 100) if avg_price > 0 else 0

                opportunities.append({
                    "symbol": sym,
                    "exchange1": e1,
                    "exchange2": e2,
                    "rate1": r1,
                    "rate2": r2,
                    "rate1_fmt": format_funding(r1),
                    "rate2_fmt": format_funding(r2),
                    "diff": diff,
                    "diff_fmt": format_funding(diff),
                    "short_exchange": short_ex,
                    "long_exchange": long_ex,
                    "next_funding1": format_next_funding(available[e1]["next_funding"]),
                    "next_funding2": format_next_funding(available[e2]["next_funding"]),
                    "url1": get_exchange_url(e1, sym),
                    "url2": get_exchange_url(e2, sym),
                    "short_url": get_exchange_url(short_ex, sym),
                    "long_url": get_exchange_url(long_ex, sym),
                    "price1": price1,
                    "price2": price2,
                    "price_diff": round(price_diff, 4),
                    "spread_pct": round(spread_pct, 4),
                })

    # Sort by biggest difference first
    opportunities.sort(key=lambda x: x["diff"], reverse=True)

    exchange_counts = {
        "Binance": len(exchange_data["Binance"]),
        "Bybit": len(exchange_data["Bybit"]),
        "CoinDCX": len(exchange_data["CoinDCX"]),
    }
    if include_delta:
        exchange_counts["Delta"] = len(exchange_data["Delta"])

    return {
        "scan_time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "threshold": format_funding(min_diff),
        "threshold_raw": min_diff,
        "exchange_counts": exchange_counts,
        "total_symbols": len(all_symbols),
        "opportunities": opportunities,
        "count": len(opportunities),
        "include_delta": include_delta,
    }


# ========================
# MAIN
# ========================
if __name__ == "__main__":
    json_mode = "--json" in sys.argv

    # Parse threshold from args (--threshold 0.003)
    min_diff = DEFAULT_MIN_FUNDING_DIFF
    if "--threshold" in sys.argv:
        idx = sys.argv.index("--threshold")
        if idx + 1 < len(sys.argv):
            try:
                min_diff = float(sys.argv[idx + 1])
            except ValueError:
                pass

    # Parse delta flag
    include_delta = "--no-delta" not in sys.argv

    if not json_mode:
        exchanges = "Binance, Bybit"
        if include_delta:
            exchanges += " & Delta Exchange"
        print(f"⚡ Loading funding rates from {exchanges}...\n")

    result = scan(min_diff=min_diff, include_delta=include_delta)

    if json_mode:
        print(json.dumps(result))
    else:
        print(f"  Binance pairs loaded: {result['exchange_counts']['Binance']}")
        print(f"  Bybit pairs loaded:   {result['exchange_counts']['Bybit']}")
        if include_delta:
            print(f"  Delta pairs loaded:   {result['exchange_counts'].get('Delta', 0)}")
        print(f"  Total unique USDT symbols: {result['total_symbols']}\n")

        print("=" * 85)
        print("📊 FUNDING RATE ARBITRAGE SCANNER")
        print("=" * 85)
        print(f"  Min diff threshold: {result['threshold']}")
        print(f"  Time: {result['scan_time']}")
        print("=" * 85)

        if not result["opportunities"]:
            print("\n❌ No funding rate differences found above threshold.")
        else:
            print(f"\n🔥 Found {result['count']} opportunities:\n")

            for i, opp in enumerate(result["opportunities"], 1):
                print(f"  {i:>3}. {opp['symbol']:<20}  {opp['exchange1']} vs {opp['exchange2']}")
                print(f"       {opp['exchange1']:<10} funding: {opp['rate1_fmt']:>12}  price: ${opp['price1']:.2f}  (next: {opp['next_funding1']})")
                print(f"       {opp['exchange2']:<10} funding: {opp['rate2_fmt']:>12}  price: ${opp['price2']:.2f}  (next: {opp['next_funding2']})")
                print(f"       Difference:        {opp['diff_fmt']:>12}    Spread: {opp['spread_pct']:.4f}%")
                print(f"       Strategy:          Short {opp['short_exchange']} / Long {opp['long_exchange']}")
                print()

        print("=" * 85)
        print(f"✅ Scan complete. {result['count']} pairs with funding diff >= {result['threshold']}")
        print("=" * 85)
