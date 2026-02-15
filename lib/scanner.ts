// =============================================================================
// Funding Rate Scanner — TypeScript (replaces bot.py)
//
// Fetches funding rates from Binance, Bybit, Delta Exchange India, and CoinDCX,
// normalises symbols across exchanges, and finds arbitrage opportunities where
// the funding-rate difference exceeds a configurable threshold.
// =============================================================================

// Default minimum funding rate difference (raw decimal, not percentage)
// 0.003 = 0.3% difference in funding rate
const DEFAULT_MIN_FUNDING_DIFF = 0.003;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FundingEntry {
    rate: number;
    next_funding: number; // ms timestamp (0 = unavailable)
    mark_price: number;
    original_symbol: string; // raw symbol key from the exchange API
}

interface Opportunity {
    symbol: string;
    exchange1: string;
    exchange2: string;
    original_symbol1: string; // raw symbol as used on exchange1
    original_symbol2: string; // raw symbol as used on exchange2
    rate1: number;
    rate2: number;
    rate1_fmt: string;
    rate2_fmt: string;
    diff: number;
    diff_fmt: string;
    short_exchange: string;
    long_exchange: string;
    next_funding1: string;
    next_funding2: string;
    price1: number;
    price2: number;
    price_diff: number;
    spread_pct: number;
}

export interface ScanResult {
    scan_time: string;
    threshold: string;
    threshold_raw: number;
    exchange_counts: Record<string, number>;
    total_symbols: number;
    opportunities: Opportunity[];
    count: number;
    include_delta: boolean;
}



// ---------------------------------------------------------------------------
// Fetch helpers (with timeout)
// ---------------------------------------------------------------------------

async function fetchJSON(url: string, params?: Record<string, string>, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const fullUrl = params
            ? `${url}?${new URLSearchParams(params).toString()}`
            : url;

        const res = await fetch(fullUrl, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Load Funding Rates from each exchange
// ---------------------------------------------------------------------------

/**
 * Binance: lastFundingRate is a raw decimal
 * e.g., 0.00010000 = 0.01%
 * Also fetches markPrice for spread calculations.
 */
async function loadBinanceFunding(): Promise<Record<string, FundingEntry>> {
    const data = await fetchJSON("https://fapi.binance.com/fapi/v1/premiumIndex");
    const funding: Record<string, FundingEntry> = {};

    for (const x of data) {
        const sym: string = x.symbol;
        const rate = parseFloat(x.lastFundingRate);
        const nextTime = parseInt(x.nextFundingTime, 10);
        const markPrice = parseFloat(x.markPrice || "0");

        // Skip quarterly contracts and inactive
        if (sym.includes("_") || nextTime === 0) continue;

        funding[sym] = { rate, next_funding: nextTime, mark_price: markPrice, original_symbol: sym };
    }

    return funding;
}

/**
 * Bybit: fundingRate is a raw decimal (same scale as Binance)
 * e.g., 0.0000393 = 0.00393%
 * Also fetches markPrice for spread calculations.
 */
async function loadBybitFunding(): Promise<Record<string, FundingEntry>> {
    const data = await fetchJSON("https://api.bybit.com/v5/market/tickers", {
        category: "linear",
    });

    const funding: Record<string, FundingEntry> = {};
    for (const x of data.result.list) {
        const sym: string = x.symbol;
        const rateStr: string = x.fundingRate || "";
        const nextStr: string = x.nextFundingTime || "0";
        if (!rateStr || nextStr === "0") continue;

        const rate = parseFloat(rateStr);
        const nextTime = parseInt(nextStr, 10);
        const markPrice = parseFloat(x.markPrice || "0");

        funding[sym] = { rate, next_funding: nextTime, mark_price: markPrice, original_symbol: sym };
    }

    return funding;
}

/**
 * Delta Exchange India (api.india.delta.exchange)
 *
 * Symbols are in USD format (e.g., BTCUSD, ETHUSD)
 * funding_rate is in percentage form:
 *     e.g., 0.01 means 0.01%
 * We convert to raw decimal to match Binance/Bybit scale:
 *     raw_decimal = delta_rate / 100
 * So 0.01 (Delta %) -> 0.0001 (raw decimal) = 0.01%
 *
 * Also fetches mark_price for spread calculations.
 */
async function loadDeltaFunding(): Promise<Record<string, FundingEntry>> {
    const data = await fetchJSON("https://api.india.delta.exchange/v2/tickers");

    const funding: Record<string, FundingEntry> = {};
    for (const item of data.result) {
        if (item.contract_type !== "perpetual_futures") continue;
        if (item.funding_rate == null) continue;

        const sym: string = item.symbol;
        const deltaRate = parseFloat(item.funding_rate);
        const rawRate = deltaRate / 100; // 0.01% -> 0.0001
        const markPrice = parseFloat(item.mark_price || "0");

        funding[sym] = {
            rate: rawRate,
            next_funding: 0,
            mark_price: markPrice,
            original_symbol: sym,
        };
    }

    return funding;
}

/**
 * CoinDCX public API (no auth needed).
 *
 * Endpoint: https://public.coindcx.com/market_data/v3/current_prices/futures/rt
 * Symbol format: 'B-BTC_USDT' -> normalized to 'BTCUSDT'
 *
 * fr = funding rate (already in raw decimal, same as Binance/Bybit)
 * efr = estimated funding rate
 * mp = mark price
 */
async function loadCoinDCXFunding(): Promise<Record<string, FundingEntry>> {
    try {
        const data = await fetchJSON(
            "https://public.coindcx.com/market_data/v3/current_prices/futures/rt"
        );

        const funding: Record<string, FundingEntry> = {};
        const prices = data.prices || {};

        for (const [pairKey, pairData] of Object.entries(prices)) {
            const d = pairData as Record<string, unknown>;
            const fr = d.fr;
            if (fr == null) continue;

            const markPrice = parseFloat(String(d.mp || "0"));

            funding[pairKey] = {
                rate: parseFloat(String(fr)),
                next_funding: 0,
                mark_price: markPrice,
                original_symbol: pairKey, // preserve raw key like "B-CHESS_USDT"
            };
        }

        return funding;
    } catch (e) {
        console.error("Error loading CoinDCX:", e);
        return {};
    }
}

// ---------------------------------------------------------------------------
// Symbol Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalize symbol names across exchanges to find common pairs.
 *
 * Delta India uses USD suffix (BTCUSD), while Binance/Bybit use USDT (BTCUSDT).
 * We normalize all to USDT format for matching.
 */
function normalizeSymbol(sym: string, exchange?: string): string | null {
    sym = sym.toUpperCase().replace(/-/g, "").replace(/_/g, "");

    // CoinDCX: B-BTC_USDT -> BTCUSDT
    if (exchange === "CoinDCX") {
        if (sym.startsWith("B")) {
            sym = sym.slice(1); // Remove 'B' prefix
        }
    } else if (exchange === "Delta") {
        // Delta India: Convert XXXUSD -> XXXUSDT for matching
        if (sym.endsWith("USD") && !sym.endsWith("USDT") && !sym.endsWith("USDC")) {
            sym = sym + "T"; // BTCUSD -> BTCUSDT
        }
    } else {
        // For Binance/Bybit, skip inverse contracts (ending in USD but not USDT)
        if (sym.endsWith("USD") && !sym.endsWith("USDT") && !sym.endsWith("USDC")) {
            return null;
        }
    }

    // Only keep USDT pairs for comparison
    if (!sym.endsWith("USDT")) return null;

    return sym;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format funding rate properly.
 * Input: raw decimal (e.g., 0.00010000)
 * Output: percentage string like '0.0100%'
 */
function formatFunding(rate: number): string {
    const pct = rate * 100;
    return `${pct.toFixed(4)}%`;
}

/**
 * Format next funding time as HH:MM UTC
 */
function formatNextFunding(timestampMs: number): string {
    if (timestampMs === 0) return "N/A";
    const dt = new Date(timestampMs);
    const hours = dt.getUTCHours().toString().padStart(2, "0");
    const minutes = dt.getUTCMinutes().toString().padStart(2, "0");
    return `${hours}:${minutes} UTC`;
}

// ---------------------------------------------------------------------------
// Generate Combinations helper
// ---------------------------------------------------------------------------

function combinations<T>(arr: T[], k: number): T[][] {
    if (k === 0) return [[]];
    if (arr.length === 0) return [];
    const [first, ...rest] = arr;
    const withFirst = combinations(rest, k - 1).map((combo) => [first, ...combo]);
    const withoutFirst = combinations(rest, k);
    return [...withFirst, ...withoutFirst];
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export async function scan(
    minDiff: number = DEFAULT_MIN_FUNDING_DIFF,
    includeDelta: boolean = true
): Promise<ScanResult> {
    // Fetch all exchanges in parallel
    const [binanceFunding, bybitFunding, coindcxFunding, deltaFunding] =
        await Promise.all([
            loadBinanceFunding(),
            loadBybitFunding(),
            loadCoinDCXFunding(),
            (includeDelta ? loadDeltaFunding() : Promise.resolve({})) as Promise<Record<string, FundingEntry>>,
        ]);

    // Build normalised maps
    const exchangeData: Record<string, Record<string, FundingEntry>> = {
        Binance: {},
        Bybit: {},
        CoinDCX: {},
    };
    if (includeDelta) exchangeData["Delta"] = {};

    for (const [rawSym, data] of Object.entries(binanceFunding)) {
        const norm = normalizeSymbol(rawSym, "Binance");
        if (norm) exchangeData["Binance"][norm] = data;
    }

    for (const [rawSym, data] of Object.entries(bybitFunding)) {
        const norm = normalizeSymbol(rawSym, "Bybit");
        if (norm) exchangeData["Bybit"][norm] = data;
    }

    for (const [rawSym, data] of Object.entries(coindcxFunding)) {
        const norm = normalizeSymbol(rawSym, "CoinDCX");
        if (norm) exchangeData["CoinDCX"][norm] = data;
    }

    if (includeDelta) {
        for (const [rawSym, data] of Object.entries(deltaFunding)) {
            const norm = normalizeSymbol(rawSym, "Delta");
            if (norm) exchangeData["Delta"][norm] = data;
        }
    }

    // Find all USDT symbols
    const allSymbols = new Set<string>();
    for (const exData of Object.values(exchangeData)) {
        for (const sym of Object.keys(exData)) {
            allSymbols.add(sym);
        }
    }

    // Collect opportunities
    const opportunities: Opportunity[] = [];
    const exchangesList = Object.keys(exchangeData);

    for (const sym of [...allSymbols].sort()) {
        const available: Record<string, FundingEntry> = {};
        for (const ex of exchangesList) {
            if (exchangeData[ex][sym]) {
                available[ex] = exchangeData[ex][sym];
            }
        }

        if (Object.keys(available).length < 2) continue;

        // Compare all pairs of exchanges
        const exNames = Object.keys(available);
        const pairs = combinations(exNames, 2);

        for (const [e1, e2] of pairs) {
            const r1 = available[e1].rate;
            const r2 = available[e2].rate;
            const diff = Math.abs(r1 - r2);

            if (diff >= minDiff) {
                const shortEx = r1 > r2 ? e1 : e2;
                const longEx = r1 > r2 ? e2 : e1;

                // Calculate price spread between exchanges
                const price1 = available[e1].mark_price || 0;
                const price2 = available[e2].mark_price || 0;
                const priceDiff = Math.abs(price1 - price2);
                const avgPrice = price1 > 0 && price2 > 0 ? (price1 + price2) / 2 : 0;
                const spreadPct = avgPrice > 0 ? (priceDiff / avgPrice) * 100 : 0;

                opportunities.push({
                    symbol: sym,
                    exchange1: e1,
                    exchange2: e2,
                    original_symbol1: available[e1].original_symbol,
                    original_symbol2: available[e2].original_symbol,
                    rate1: r1,
                    rate2: r2,
                    rate1_fmt: formatFunding(r1),
                    rate2_fmt: formatFunding(r2),
                    diff,
                    diff_fmt: formatFunding(diff),
                    short_exchange: shortEx,
                    long_exchange: longEx,
                    next_funding1: formatNextFunding(available[e1].next_funding),
                    next_funding2: formatNextFunding(available[e2].next_funding),
                    price1,
                    price2,
                    price_diff: Math.round(priceDiff * 10_000) / 10_000,
                    spread_pct: Math.round(spreadPct * 10_000) / 10_000,
                });
            }
        }
    }

    // Sort by biggest difference first
    opportunities.sort((a, b) => b.diff - a.diff);

    const exchangeCounts: Record<string, number> = {
        Binance: Object.keys(exchangeData["Binance"]).length,
        Bybit: Object.keys(exchangeData["Bybit"]).length,
        CoinDCX: Object.keys(exchangeData["CoinDCX"]).length,
    };
    if (includeDelta) {
        exchangeCounts["Delta"] = Object.keys(exchangeData["Delta"]).length;
    }

    const now = new Date();
    const scanTime = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")} ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC`;

    return {
        scan_time: scanTime,
        threshold: formatFunding(minDiff),
        threshold_raw: minDiff,
        exchange_counts: exchangeCounts,
        total_symbols: allSymbols.size,
        opportunities,
        count: opportunities.length,
        include_delta: includeDelta,
    };
}
