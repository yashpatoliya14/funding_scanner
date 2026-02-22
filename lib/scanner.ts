// =============================================================================
// Funding Rate Scanner — CoinSwitch PRO, Delta Exchange India, CoinDCX
//
// Fetches funding rates from CoinSwitch, Delta Exchange India, and CoinDCX,
// normalises symbols across exchanges, and finds arbitrage opportunities where
// the funding-rate difference exceeds a configurable threshold.
// =============================================================================

import crypto from "crypto";
// Ed25519 signing is done via Node's built-in crypto module (no external deps needed)

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
    exchange_status: Record<string, { connected: boolean; error?: string }>;
}

// ---------------------------------------------------------------------------
// Fetch helpers (with timeout)
// ---------------------------------------------------------------------------

async function fetchJSON(
    url: string,
    options?: {
        params?: Record<string, string>;
        headers?: Record<string, string>;
        timeoutMs?: number;
    }
) {
    const { params, headers = {}, timeoutMs = 10_000 } = options || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const fullUrl = params
            ? `${url}?${new URLSearchParams(params).toString()}`
            : url;

        const res = await fetch(fullUrl, {
            signal: controller.signal,
            headers,
        });
        if (!res.ok) {
            let body = "";
            try { body = await res.text(); } catch { /* ignore */ }
            throw new Error(`HTTP ${res.status} from ${url} — ${body.slice(0, 300)}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// CoinSwitch PRO Authentication
// ---------------------------------------------------------------------------

function generateCoinSwitchSignature(
    secretKeyHex: string,
    method: string,
    urlPath: string,
    body: string,
    timestamp: string
): string {
    // CoinSwitch PRO uses Ed25519 digital signatures (updated July 2024)
    // Payload format: {timestamp}{HTTP_METHOD}{URL_Path_with_Query_Params}{Request_Body}
    // For GET requests with no body, body should be empty string ""
    const payload = `${timestamp}${method.toUpperCase()}${urlPath}${body}`;
    console.log(`[CoinSwitch] Signing payload (${payload.length} chars): "${payload}"`);

    try {
        const seed = Buffer.from(secretKeyHex, "hex");
        if (seed.length !== 32) {
            throw new Error(`Expected 32-byte Ed25519 seed, got ${seed.length} bytes`);
        }

        // Wrap the raw 32-byte seed into a PKCS8 DER structure so Node's crypto
        // module can load it as an Ed25519 private key.
        // DER = SEQUENCE { version=0, AlgorithmIdentifier{OID Ed25519}, OCTET_STRING{seed} }
        const derPrefix = Buffer.from("302e020100300506032b657004220420", "hex");
        const der = Buffer.concat([derPrefix, seed]);

        const privateKey = crypto.createPrivateKey({
            key: der,
            format: "der",
            type: "pkcs8",
        });

        const signature = crypto.sign(null, Buffer.from(payload), privateKey);
        return signature.toString("hex");
    } catch (e) {
        console.error("Error generating CoinSwitch signature:", e);
        return "";
    }
}

function getCoinSwitchHeaders(
    method: string,
    urlPathWithQuery: string,
    body: string = ""
): Record<string, string> {
    const apiKey = process.env.COINSWITCH_API_KEY || "";
    const secretKey = process.env.COINSWITCH_SECRET_KEY || "";

    if (!apiKey || !secretKey) {
        throw new Error("CoinSwitch API keys not configured");
    }

    const timestamp = Date.now().toString();

    // For GET/DELETE requests with no body, use empty string in the signature payload
    // (CoinSwitch docs: concatenate empty string when no body is present)
    const signatureBody = body || "";

    const signature = generateCoinSwitchSignature(
        secretKey,
        method,
        urlPathWithQuery,
        signatureBody,
        timestamp
    );

    return {
        "Content-Type": "application/json",
        "CSX-ACCESS-KEY": apiKey,
        "CSX-ACCESS-TIMESTAMP": timestamp,
        "CSX-SIGNATURE": signature,
    };
}

// ---------------------------------------------------------------------------
// Delta Exchange India Authentication
// ---------------------------------------------------------------------------

function generateDeltaSignature(
    secretKey: string,
    method: string,
    timestamp: string,
    path: string,
    queryString: string,
    body: string
): string {
    const payload = `${method}${timestamp}${path}${queryString}${body}`;
    return crypto
        .createHmac("sha256", secretKey)
        .update(payload)
        .digest("hex");
}

function getDeltaHeaders(
    method: string,
    path: string,
    queryString: string = "",
    body: string = ""
): Record<string, string> {
    const apiKey = process.env.DELTA_API_KEY || "";
    const secretKey = process.env.DELTA_API_SECRET || "";

    if (!apiKey || !secretKey) {
        return {}; // Delta public endpoints don't need auth
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = generateDeltaSignature(
        secretKey,
        method,
        timestamp,
        path,
        queryString,
        body
    );

    return {
        "Content-Type": "application/json",
        "api-key": apiKey,
        timestamp: timestamp,
        signature: signature,
    };
}

// ---------------------------------------------------------------------------
// CoinDCX Authentication
// ---------------------------------------------------------------------------

function getCoinDCXHeaders(
    body: string = ""
): Record<string, string> {
    const apiKey = process.env.COINDCX_API_KEY || "";
    const secretKey = process.env.COINDCX_API_SECRET || "";

    if (!apiKey || !secretKey) {
        throw new Error("CoinDCX API keys not configured");
    }

    const signature = crypto
        .createHmac("sha256", secretKey)
        .update(body)
        .digest("hex");

    return {
        "Content-Type": "application/json",
        "X-AUTH-APIKEY": apiKey,
        "X-AUTH-SIGNATURE": signature,
    };
}

// ---------------------------------------------------------------------------
// Load Funding Rates from each exchange
// ---------------------------------------------------------------------------

/**
 * CoinSwitch PRO — Futures Funding Rates
 *
 * Endpoint: GET /trade/api/v2/futures/ticker
 * Requires authenticated API access (CSX headers).
 *
 * Expected response format (assumed based on API docs):
 * {
 *   "data": [
 *     {
 *       "symbol": "BTCUSDT",
 *       "funding_rate": "0.0001",
 *       "mark_price": "45000.00",
 *       "next_funding_time": 1700000000000,
 *       ...
 *     }
 *   ]
 * }
 */
async function loadCoinSwitchFunding(): Promise<Record<string, FundingEntry>> {
    const apiKey = process.env.COINSWITCH_API_KEY;
    if (!apiKey) {
        console.warn("⚠️ CoinSwitch API key not configured — skipping");
        return {};
    }

    try {
        try {
            // CoinSwitch futures requires ?exchange=EXCHANGE_2 query param
            // Signature MUST include query params in the URL path
            const urlPathWithQuery = "/trade/api/v2/futures/all-pairs/ticker?exchange=EXCHANGE_2";
            const fullUrl = `https://coinswitch.co${urlPathWithQuery}`;
            const headers = getCoinSwitchHeaders("GET", urlPathWithQuery);

            const data = await fetchJSON(fullUrl, { headers, timeoutMs: 15_000 });
            const funding: Record<string, FundingEntry> = {};

            // Handle both array and object response formats
            const items = Array.isArray(data?.data)
                ? data.data
                : Array.isArray(data)
                    ? data
                    : data?.data
                        ? Object.values(data.data)
                        : [];

            for (const item of items) {
                // Try multiple field name patterns
                const sym =
                    item.symbol || item.pair || item.contract_name || "";
                const rateRaw =
                    item.funding_rate ??
                    item.fundingRate ??
                    item.fr ??
                    null;

                if (rateRaw == null || !sym) continue;

                const rate = parseFloat(String(rateRaw));
                const markPrice = parseFloat(
                    String(item.mark_price || item.markPrice || item.mp || "0")
                );
                const nextFunding = parseInt(
                    String(
                        item.next_funding_time ||
                        item.nextFundingTime ||
                        item.nft ||
                        "0"
                    ),
                    10
                );

                funding[sym] = {
                    rate,
                    next_funding: nextFunding,
                    mark_price: markPrice,
                    original_symbol: sym,
                };
            }

            console.log(`✅ CoinSwitch: loaded ${Object.keys(funding).length} pairs`);
            return funding;
        } catch (e) {
            console.error("❌ CoinSwitch fetch failed:", e);
            return {};
        }
    } catch (e) {
        console.error("❌ CoinSwitch outer error:", e);
        return {};
    }
}

/**
 * Delta Exchange India (api.india.delta.exchange)
 *
 * Symbols are in USD format (e.g., BTCUSD, ETHUSD)
 * funding_rate is in percentage form:
 *     e.g., 0.01 means 0.01%
 * We convert to raw decimal to match common scale:
 *     raw_decimal = delta_rate / 100
 * So 0.01 (Delta %) -> 0.0001 (raw decimal) = 0.01%
 *
 * Public endpoint — no auth needed for market data.
 * Auth required only for trading.
 */
async function loadDeltaFunding(): Promise<Record<string, FundingEntry>> {
    try {
        const data = await fetchJSON(
            "https://api.india.delta.exchange/v2/tickers"
        );

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

        console.log(`✅ Delta: loaded ${Object.keys(funding).length} pairs`);
        return funding;
    } catch (e) {
        console.error("❌ Delta fetch failed:", e);
        return {};
    }
}

/**
 * CoinDCX — Futures Funding Rates
 *
 * Endpoint: GET https://public.coindcx.com/market_data/v3/current_prices/futures/rt
 * Public endpoint — no authentication required for market data.
 *
 * Response format:
 * {
 *   "ts": 1720429586580,
 *   "vs": 54009972,
 *   "prices": {
 *     "B-BTC_USDT": {
 *       "fr": 0.0001,       // funding rate
 *       "mp": 45000.5,      // mark price
 *       "efr": 0.00005,     // estimated funding rate
 *       "ls": 45100,        // last price
 *       "h": 46000,         // 24h high
 *       "l": 44000,         // 24h low
 *       "v": 1000000,       // volume
 *       "pc": 1.5,          // price change %
 *       ...
 *     }
 *   }
 * }
 */
async function loadCoinDCXFunding(): Promise<Record<string, FundingEntry>> {
    try {
        const url = "https://public.coindcx.com/market_data/v3/current_prices/futures/rt";
        const data = await fetchJSON(url, { timeoutMs: 25_000 });
        const funding: Record<string, FundingEntry> = {};

        const prices = data?.prices;
        if (!prices || typeof prices !== "object") {
            console.warn("⚠️ CoinDCX: unexpected response format");
            return {};
        }

        for (const [pair, info] of Object.entries(prices)) {
            const item = info as Record<string, unknown>;
            const rateRaw = item.fr ?? item.efr ?? null;

            if (rateRaw == null) continue;

            const rate = parseFloat(String(rateRaw));
            const markPrice = parseFloat(String(item.mp || item.ls || "0"));

            funding[pair] = {
                rate,
                next_funding: 0, // CoinDCX doesn't expose next funding time in this endpoint
                mark_price: markPrice,
                original_symbol: pair,
            };
        }

        console.log(`✅ CoinDCX: loaded ${Object.keys(funding).length} pairs`);
        return funding;
    } catch (e) {
        console.error("❌ CoinDCX fetch failed:", e);
        return {};
    }
}

// ---------------------------------------------------------------------------
// Symbol Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalize symbol names across exchanges to find common pairs.
 *
 * CoinSwitch: BTCUSDT format
 * Delta India: BTCUSD format (USD suffix) -> normalize to BTCUSDT
 * CoinDCX: B-BTC_USDT format -> strip prefix, remove separators -> BTCUSDT
 */
function normalizeSymbol(sym: string, exchange?: string): string | null {
    sym = sym.toUpperCase().replace(/-/g, "").replace(/_/g, "");

    if (exchange === "Delta") {
        // Delta India: Convert XXXUSD -> XXXUSDT for matching
        if (
            sym.endsWith("USD") &&
            !sym.endsWith("USDT") &&
            !sym.endsWith("USDC")
        ) {
            sym = sym + "T"; // BTCUSD -> BTCUSDT
        }
    } else if (exchange === "CoinSwitch") {
        // CoinSwitch: symbols might have various prefixes/suffixes
        // Remove any non-standard prefix
        if (sym.startsWith("F") || sym.startsWith("B")) {
            sym = sym.replace(/^[FB]/, "");
        }
    } else if (exchange === "CoinDCX") {
        // CoinDCX futures: B-BTC_USDT -> after replace: BBTCUSDT
        // Remove the leading B prefix
        if (sym.startsWith("B")) {
            sym = sym.slice(1);
        }
        // Handle 1000SHIB-style multiplier prefixes
        // e.g. B-1000SHIB_USDT -> 1000SHIBUSDT (keep as-is after B removal)
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
    const withFirst = combinations(rest, k - 1).map((combo) => [
        first,
        ...combo,
    ]);
    const withoutFirst = combinations(rest, k);
    return [...withFirst, ...withoutFirst];
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export async function scan(
    minDiff: number = DEFAULT_MIN_FUNDING_DIFF
): Promise<ScanResult> {
    // Fetch all exchanges in parallel — use allSettled so one failure doesn't kill the scan
    const results = await Promise.allSettled([
        loadCoinSwitchFunding(),
        loadDeltaFunding(),
        loadCoinDCXFunding(),
    ]);

    const coinSwitchFunding =
        results[0].status === "fulfilled" ? results[0].value : {};
    const deltaFunding =
        results[1].status === "fulfilled" ? results[1].value : {};
    const coindcxFunding =
        results[2].status === "fulfilled" ? results[2].value : {};

    // Track exchange connection status
    const exchangeStatus: Record<
        string,
        { connected: boolean; error?: string }
    > = {
        CoinSwitch: {
            connected:
                results[0].status === "fulfilled" &&
                Object.keys(coinSwitchFunding).length > 0,
            error:
                results[0].status === "rejected"
                    ? String(results[0].reason)
                    : !process.env.COINSWITCH_API_KEY
                        ? "API key not configured"
                        : Object.keys(coinSwitchFunding).length === 0
                            ? "No data returned"
                            : undefined,
        },
        Delta: {
            connected:
                results[1].status === "fulfilled" &&
                Object.keys(deltaFunding).length > 0,
            error:
                results[1].status === "rejected"
                    ? String(results[1].reason)
                    : Object.keys(deltaFunding).length === 0
                        ? "No data returned"
                        : undefined,
        },
        CoinDCX: {
            connected:
                results[2].status === "fulfilled" &&
                Object.keys(coindcxFunding).length > 0,
            error:
                results[2].status === "rejected"
                    ? String(results[2].reason)
                    : Object.keys(coindcxFunding).length === 0
                        ? "No data returned"
                        : undefined,
        },
    };

    // Log any failures (visible in Vercel function logs)
    if (results[0].status === "rejected")
        console.error("CoinSwitch fetch failed:", results[0].reason);
    if (results[1].status === "rejected")
        console.error("Delta fetch failed:", results[1].reason);
    if (results[2].status === "rejected")
        console.error("CoinDCX fetch failed:", results[2].reason);

    // Build normalised maps
    const exchangeData: Record<string, Record<string, FundingEntry>> = {
        CoinSwitch: {},
        Delta: {},
        CoinDCX: {},
    };

    for (const [rawSym, data] of Object.entries(coinSwitchFunding)) {
        const norm = normalizeSymbol(rawSym, "CoinSwitch");
        if (norm) exchangeData["CoinSwitch"][norm] = data;
    }

    for (const [rawSym, data] of Object.entries(deltaFunding)) {
        const norm = normalizeSymbol(rawSym, "Delta");
        if (norm) exchangeData["Delta"][norm] = data;
    }

    for (const [rawSym, data] of Object.entries(coindcxFunding)) {
        const norm = normalizeSymbol(rawSym, "CoinDCX");
        if (norm) exchangeData["CoinDCX"][norm] = data;
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
                const avgPrice =
                    price1 > 0 && price2 > 0 ? (price1 + price2) / 2 : 0;
                const spreadPct =
                    avgPrice > 0 ? (priceDiff / avgPrice) * 100 : 0;

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
                    next_funding1: formatNextFunding(
                        available[e1].next_funding
                    ),
                    next_funding2: formatNextFunding(
                        available[e2].next_funding
                    ),
                    price1,
                    price2,
                    price_diff:
                        Math.round(priceDiff * 10_000) / 10_000,
                    spread_pct:
                        Math.round(spreadPct * 10_000) / 10_000,
                });
            }
        }
    }

    // Sort by biggest difference first
    opportunities.sort((a, b) => b.diff - a.diff);

    const exchangeCounts: Record<string, number> = {
        CoinSwitch: Object.keys(exchangeData["CoinSwitch"]).length,
        Delta: Object.keys(exchangeData["Delta"]).length,
        CoinDCX: Object.keys(exchangeData["CoinDCX"]).length,
    };

    const now = new Date();
    const scanTime = `${now.getUTCFullYear()}-${String(
        now.getUTCMonth() + 1
    ).padStart(2, "0")}-${String(now.getUTCDate()).padStart(
        2,
        "0"
    )} ${String(now.getUTCHours()).padStart(2, "0")}:${String(
        now.getUTCMinutes()
    ).padStart(2, "0")} UTC`;

    return {
        scan_time: scanTime,
        threshold: formatFunding(minDiff),
        threshold_raw: minDiff,
        exchange_counts: exchangeCounts,
        total_symbols: allSymbols.size,
        opportunities,
        count: opportunities.length,
        exchange_status: exchangeStatus,
    };
}

// ---------------------------------------------------------------------------
// Trade Execution — Exported for use by /api/trade
// ---------------------------------------------------------------------------

export interface TradeRequest {
    symbol: string;
    short_exchange: string;
    long_exchange: string;
    original_symbol_short: string;
    original_symbol_long: string;
    quantity: number;
    leverage: number;
}

export interface TradeResult {
    success: boolean;
    short_order?: OrderResult;
    long_order?: OrderResult;
    error?: string;
}

interface OrderResult {
    exchange: string;
    order_id?: string;
    status: "filled" | "placed" | "failed";
    symbol: string;
    side: "short" | "long";
    quantity: number;
    price?: number;
    error?: string;
}

/**
 * Place an order on CoinSwitch PRO
 */
async function placeCoinSwitchOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    leverage: number
): Promise<OrderResult> {
    try {
        const urlPath = "/trade/api/v2/futures/create_order";
        const body = JSON.stringify({
            symbol,
            side,
            type: "MARKET",
            quantity: quantity.toString(),
            leverage: leverage.toString(),
        });

        const headers = getCoinSwitchHeaders("POST", urlPath, body);
        const url = `https://coinswitch.co${urlPath}`;

        const res = await fetch(url, {
            method: "POST",
            headers,
            body,
        });

        const data = await res.json();

        if (!res.ok) {
            return {
                exchange: "CoinSwitch",
                status: "failed",
                symbol,
                side: side === "SELL" ? "short" : "long",
                quantity,
                error: data?.message || `HTTP ${res.status}`,
            };
        }

        return {
            exchange: "CoinSwitch",
            order_id: data?.data?.order_id || data?.order_id,
            status: "placed",
            symbol,
            side: side === "SELL" ? "short" : "long",
            quantity,
            price: parseFloat(data?.data?.price || "0"),
        };
    } catch (e) {
        return {
            exchange: "CoinSwitch",
            status: "failed",
            symbol,
            side: side === "SELL" ? "short" : "long",
            quantity,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

/**
 * Place an order on Delta Exchange India
 */
async function placeDeltaOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    leverage: number
): Promise<OrderResult> {
    try {
        const path = "/v2/orders";
        const body = JSON.stringify({
            product_symbol: symbol,
            size: quantity,
            side,
            order_type: "market_order",
            leverage: leverage.toString(),
        });

        const headers = getDeltaHeaders("POST", path, "", body);
        const url = `https://api.india.delta.exchange${path}`;

        const res = await fetch(url, {
            method: "POST",
            headers,
            body,
        });

        const data = await res.json();

        if (!res.ok) {
            return {
                exchange: "Delta",
                status: "failed",
                symbol,
                side: side === "sell" ? "short" : "long",
                quantity,
                error: data?.error?.message || data?.message || `HTTP ${res.status}`,
            };
        }

        return {
            exchange: "Delta",
            order_id: data?.result?.id?.toString(),
            status: "placed",
            symbol,
            side: side === "sell" ? "short" : "long",
            quantity,
            price: parseFloat(data?.result?.avg_fill_price || "0"),
        };
    } catch (e) {
        return {
            exchange: "Delta",
            status: "failed",
            symbol,
            side: side === "sell" ? "short" : "long",
            quantity,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

/**
 * Place an order on CoinDCX
 * Uses POST /api/v1/derivatives/futures/orders/create
 * Requires HMAC-SHA256 authentication
 */
async function placeCoinDCXOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    leverage: number
): Promise<OrderResult> {
    try {
        const timestamp = Math.floor(Date.now());
        const bodyObj = {
            timestamp,
            pair: symbol,
            side,
            order_type: "market_order",
            size: quantity,
            leverage,
        };
        const bodyStr = JSON.stringify(bodyObj);
        const headers = getCoinDCXHeaders(bodyStr);

        const url = "https://api.coindcx.com/api/v1/derivatives/futures/orders/create";

        const res = await fetch(url, {
            method: "POST",
            headers,
            body: bodyStr,
        });

        const data = await res.json();

        if (!res.ok) {
            return {
                exchange: "CoinDCX",
                status: "failed",
                symbol,
                side: side === "sell" ? "short" : "long",
                quantity,
                error: data?.message || `HTTP ${res.status}`,
            };
        }

        return {
            exchange: "CoinDCX",
            order_id: data?.data?.id || data?.id,
            status: "placed",
            symbol,
            side: side === "sell" ? "short" : "long",
            quantity,
            price: parseFloat(data?.data?.avg_price || data?.data?.price || "0"),
        };
    } catch (e) {
        return {
            exchange: "CoinDCX",
            status: "failed",
            symbol,
            side: side === "sell" ? "short" : "long",
            quantity,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

/**
 * Execute a two-legged arbitrage trade:
 *   1. SHORT on the exchange with higher funding rate
 *   2. LONG on the exchange with lower funding rate
 * Both orders are placed simultaneously.
 */
export async function executeTrade(req: TradeRequest): Promise<TradeResult> {
    const { short_exchange, long_exchange, original_symbol_short, original_symbol_long, quantity, leverage } = req;

    // Validate API keys are present for both exchanges
    const keyCheck: Record<string, boolean> = {
        CoinSwitch: !!(process.env.COINSWITCH_API_KEY && process.env.COINSWITCH_SECRET_KEY),
        Delta: !!(process.env.DELTA_API_KEY && process.env.DELTA_API_SECRET),
        CoinDCX: !!(process.env.COINDCX_API_KEY && process.env.COINDCX_API_SECRET),
    };

    if (!keyCheck[short_exchange]) {
        return { success: false, error: `${short_exchange} API keys not configured` };
    }
    if (!keyCheck[long_exchange]) {
        return { success: false, error: `${long_exchange} API keys not configured` };
    }

    // Place orders on exchange based on name
    const placeOrder = (
        exchange: string,
        symbol: string,
        side: "BUY" | "SELL" | "buy" | "sell"
    ): Promise<OrderResult> => {
        switch (exchange) {
            case "CoinSwitch":
                return placeCoinSwitchOrder(symbol, side === "BUY" || side === "buy" ? "BUY" : "SELL", quantity, leverage);
            case "Delta":
                return placeDeltaOrder(symbol, side === "BUY" || side === "buy" ? "buy" : "sell", quantity, leverage);
            case "CoinDCX":
                return placeCoinDCXOrder(symbol, side === "BUY" || side === "buy" ? "buy" : "sell", quantity, leverage);
            default:
                return Promise.resolve({
                    exchange,
                    status: "failed" as const,
                    symbol,
                    side: "short" as const,
                    quantity,
                    error: `Unknown exchange: ${exchange}`,
                });
        }
    };

    // Execute both orders simultaneously
    const [shortResult, longResult] = await Promise.all([
        placeOrder(short_exchange, original_symbol_short, "SELL"),
        placeOrder(long_exchange, original_symbol_long, "BUY"),
    ]);

    const bothSuccess =
        shortResult.status !== "failed" && longResult.status !== "failed";

    return {
        success: bothSuccess,
        short_order: shortResult,
        long_order: longResult,
        error: bothSuccess
            ? undefined
            : [
                shortResult.status === "failed"
                    ? `Short (${short_exchange}): ${shortResult.error}`
                    : null,
                longResult.status === "failed"
                    ? `Long (${long_exchange}): ${longResult.error}`
                    : null,
            ]
                .filter(Boolean)
                .join(" | "),
    };
}
