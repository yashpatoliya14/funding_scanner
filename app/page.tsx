"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast, Toaster } from "sonner";

// ======================
// Types
// ======================
interface Opportunity {
  symbol: string;
  exchange1: string;
  exchange2: string;
  original_symbol1: string;
  original_symbol2: string;
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

interface ScanResult {
  scan_time: string;
  threshold: string;
  threshold_raw: number;
  exchange_counts: Record<string, number>;
  total_symbols: number;
  opportunities: Opportunity[];
  count: number;
  include_delta: boolean;
}

// ======================
// Icons (Lucide-style SVGs)
// ======================
function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
    </svg>
  );
}

function LoaderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function TrendingUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}

function TrendingDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
      <polyline points="16 17 22 17 22 11" />
    </svg>
  );
}

function DollarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </svg>
  );
}

function ChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ======================
// Helpers
// ======================
function getExchangeColor(exchange: string) {
  switch (exchange) {
    case "Binance":
      return "text-yellow-400";
    case "Bybit":
      return "text-orange-400";
    case "Delta":
      return "text-cyan-400";
    case "CoinDCX":
      return "text-blue-400";
    default:
      return "text-muted-foreground";
  }
}

// ======================
// Main Page
// ======================
export default function Home() {
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedSymbol, setCopiedSymbol] = useState<string | null>(null);
  const [usdt, setUsdt] = useState<string>("1000");
  const [leverage, setLeverage] = useState<string>("10");
  const [threshold, setThreshold] = useState<string>("0.3");
  const [includeDelta, setIncludeDelta] = useState(true);

  const usdtNum = parseFloat(usdt) || 0;
  const leverageNum = parseFloat(leverage) || 0;
  const positionSize = usdtNum * leverageNum;

  // Calculate estimated profit per funding period
  // Profit = position_size × funding_rate_diff
  const calcProfit = (diff: number) => {
    const profit = positionSize * diff;
    return profit;
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      // Convert percentage threshold to raw decimal for API
      const thresholdDecimal = (parseFloat(threshold) || 0.3) / 100;
      const params = new URLSearchParams({
        threshold: thresholdDecimal.toString(),
        delta: includeDelta ? "true" : "false",
      });
      const res = await fetch(`/api/scan?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch scan results");
      const result: ScanResult = await res.json();
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  // Initial scan on mount
  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Reset page when data changes
  useEffect(() => {
    setCurrentPage(1);
  }, [data]);

  const currentItems = data
    ? data.opportunities.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)
    : [];
  const totalPages = data ? Math.ceil(data.opportunities.length / itemsPerPage) : 0;

  const copySymbol = (symbol: string) => {
    navigator.clipboard.writeText(symbol).then(() => {
      setCopiedSymbol(symbol);
      toast.success(`Copied "${symbol}" to clipboard`);
      setTimeout(() => setCopiedSymbol(null), 2000);
    });
  };

  return (
    <div className="min-h-screen bg-background relative overflow-x-hidden">
      {/* Background gradient glow */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[500px] bg-[radial-gradient(ellipse_at_50%_0%,rgba(99,102,241,0.08)_0%,transparent_70%)]" />

      <div className="relative z-10 mx-auto max-w-[1500px] px-4 py-8 sm:px-6 lg:px-8">

        {/* ──────────────── HEADER ──────────────── */}
        <header className="relative flex flex-col items-center justify-center mb-6 sm:mb-8 animate-fade-in-up">
          {data && (
            <div className="absolute top-0 right-0 hidden sm:flex items-center gap-2 text-xs font-medium text-muted-foreground bg-muted/30 px-3 py-1.5 rounded-full border border-border/50">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span>Last scan: {data.scan_time}</span>
            </div>
          )}

          <div className="text-center mb-4 sm:mb-6">
            <div className="inline-flex items-center gap-2 sm:gap-3 mb-2">
              <div className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-xl sm:text-2xl shadow-lg shadow-indigo-500/30 animate-glow">
                ⚡
              </div>
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight bg-gradient-to-r from-white to-indigo-300 bg-clip-text text-transparent">
                Funding Rate Scanner
              </h1>
            </div>
            <p className="text-muted-foreground text-xs sm:text-sm">
              Real-time funding rate arbitrage — Binance · Bybit · Delta · CoinDCX
            </p>
            {data && (
              <div className="sm:hidden flex items-center justify-center gap-2 text-[11px] font-medium text-muted-foreground mt-2">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                <span>{data.scan_time}</span>
              </div>
            )}
          </div>
        </header>

        {/* ──────────────── STATS ──────────────── */}
        {
          data && (
            <div className={`grid grid-cols-2 sm:grid-cols-3 ${data.include_delta ? 'lg:grid-cols-3 xl:grid-cols-6' : 'lg:grid-cols-5'} gap-3 mb-8 animate-fade-in-up`} style={{ animationDelay: "0.1s" }}>
              {[
                { label: "Opportunities", value: data.count, color: "text-emerald-400" },
                { label: "Binance Pairs", value: data.exchange_counts.Binance ?? 0, color: "text-yellow-400" },
                { label: "Bybit Pairs", value: data.exchange_counts.Bybit ?? 0, color: "text-orange-400" },
                { label: "CoinDCX Pairs", value: data.exchange_counts.CoinDCX ?? 0, color: "text-blue-400" },
                ...(data.include_delta ? [{ label: "Delta Pairs", value: data.exchange_counts.Delta ?? 0, color: "text-cyan-400" }] : []),
                { label: "Total Symbols", value: data.total_symbols, color: "text-indigo-400" },
              ].map((stat) => (
                <Card key={stat.label} className="border-border/50 bg-card/50 backdrop-blur-sm">
                  <CardContent className="p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      {stat.label}
                    </p>
                    <p className={`text-2xl font-bold tabular-nums ${stat.color}`}>
                      {stat.value.toLocaleString()}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )
        }

        {/* ──────────────── CONTROLS & SETTINGS ──────────────── */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm mb-6 animate-fade-in-up" style={{ animationDelay: "0.25s" }}>
          <CardContent className="p-5">
            <div className="flex flex-col xl:flex-row items-end justify-between gap-6 xl:gap-10">

              {/* Left Group: Threshold + Scan Button */}
              <div className="flex flex-col sm:flex-row items-end gap-4 w-full xl:w-auto justify-center xl:justify-start">

                {/* Threshold Stepper */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Threshold (%)
                  </label>
                  <div className="flex items-center">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-10 w-10 rounded-r-none border-r-0 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                      onClick={() => {
                        const v = Math.max(0, (parseFloat(threshold) || 0) - 0.1);
                        setThreshold(v.toFixed(1));
                      }}
                    >
                      <ChevronDownIcon />
                    </Button>
                    <div className="h-10 w-20 border-y border-border bg-background flex items-center justify-center">
                      <input
                        type="text"
                        value={threshold}
                        onChange={(e) => setThreshold(e.target.value)}
                        className="w-full h-full bg-transparent text-center text-sm font-bold text-foreground tabular-nums focus:outline-none"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-10 w-10 rounded-l-none border-l-0 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                      onClick={() => {
                        const v = (parseFloat(threshold) || 0) + 0.1;
                        setThreshold(v.toFixed(1));
                      }}
                    >
                      <ChevronUpIcon />
                    </Button>
                  </div>
                </div>

                {/* Scan Button (Right side of Threshold) */}
                <Button
                  onClick={fetchData}
                  disabled={loading}
                  className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white shadow-lg shadow-indigo-500/25 transition-all hover:shadow-indigo-500/40 hover:-translate-y-0.5 disabled:opacity-60 h-10 px-6 font-bold"
                >
                  {loading ? (
                    <>
                      <LoaderIcon className="animate-spin mr-2" />
                      Scanning
                    </>
                  ) : (
                    <>
                      <GlobeIcon className="mr-2" />
                      Scan Now
                    </>
                  )}
                </Button>
              </div>

              {/* Right Group: Capital */}
              <div className="flex flex-wrap items-end justify-center xl:justify-end gap-5 w-full xl:w-auto border-t xl:border-t-0 border-border/30 pt-4 xl:pt-0">

                {/* Capital Label */}
                <div className="flex items-center gap-2 mb-2 lg:mb-3">
                  <DollarIcon className="text-emerald-400 h-5 w-5" />
                  <span className="text-base font-bold text-foreground">Capital</span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    USDT Amount
                  </label>
                  <input
                    type="text"
                    value={usdt}
                    onChange={(e) => setUsdt(e.target.value)}
                    placeholder="1000"
                    className="h-10 w-32 rounded-md border border-border bg-background px-3 text-sm font-bold text-foreground tabular-nums placeholder:text-muted-foreground focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Leverage
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={leverage}
                      onChange={(e) => setLeverage(e.target.value)}
                      placeholder="10"
                      className="h-10 w-20 rounded-md border border-border bg-background px-3 text-sm font-bold text-foreground tabular-nums placeholder:text-muted-foreground focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all"
                    />
                    <span className="text-sm text-muted-foreground font-medium">×</span>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Position Size
                  </span>
                  <div className="h-10 flex items-center px-4 rounded-md border border-indigo-500/30 bg-indigo-500/10">
                    <span className="text-base font-bold tabular-nums text-indigo-400">
                      ${positionSize.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ──────────────── LOADING STATE ──────────────── */}
        {
          loading && !data && (
            <div className="flex flex-col items-center justify-center py-24 animate-fade-in-up">
              <LoaderIcon className="h-12 w-12 animate-spin text-indigo-400 mb-5" />
              <p className="text-lg font-medium text-foreground">Scanning exchanges...</p>
              <p className="text-sm text-muted-foreground mt-1">
                Fetching rates from Binance, Bybit &amp; Delta Exchange
              </p>
            </div>
          )
        }

        {/* ──────────────── ERROR STATE ──────────────── */}
        {
          error && (
            <Card className="border-destructive/30 bg-destructive/5 animate-fade-in-up">
              <CardContent className="flex flex-col items-center py-16">
                <span className="text-5xl mb-4">⚠️</span>
                <h2 className="text-lg font-bold text-destructive mb-2">Scan Failed</h2>
                <p className="text-sm text-muted-foreground max-w-md text-center mb-5">{error}</p>
                <Button onClick={fetchData} variant="outline" className="border-destructive/30 hover:bg-destructive/10">
                  <GlobeIcon /> Retry
                </Button>
              </CardContent>
            </Card>
          )
        }

        {/* ──────────────── MOBILE CARDS (< lg) ──────────────── */}
        {
          data && data.opportunities.length > 0 && (
            <div className="lg:hidden space-y-3 mb-4 animate-fade-in-up" style={{ animationDelay: "0.3s" }}>
              {currentItems.map((opp, idx) => {
                const globalIndex = (currentPage - 1) * itemsPerPage + idx;
                return (
                  <Card
                    key={`m-${opp.symbol}-${opp.exchange1}-${opp.exchange2}`}
                    className="border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden animate-fade-in-up"
                    style={{ animationDelay: `${0.3 + idx * 0.04}s` }}
                  >
                    <CardContent className="p-4">
                      {/* Top row: rank + symbol + diff badge */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2.5">
                          <span className={`font-extrabold text-lg tabular-nums ${globalIndex < 3 ? "text-amber-400 drop-shadow-[0_0_6px_rgba(251,191,36,0.4)]" : "text-muted-foreground"}`}>
                            #{globalIndex + 1}
                          </span>
                          <span className="font-bold text-base text-foreground tracking-wide">{opp.symbol}</span>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className={`transition-all ${copiedSymbol === opp.symbol ? "text-emerald-400 bg-emerald-500/10" : "text-muted-foreground hover:text-foreground"}`}
                            onClick={() => copySymbol(opp.symbol)}
                          >
                            {copiedSymbol === opp.symbol ? <CheckIcon /> : <CopyIcon />}
                          </Button>
                        </div>
                        <Badge
                          variant="outline"
                          className={`tabular-nums text-xs font-bold gap-1 ${opp.diff >= 0.01 ? "border-red-500/30 bg-red-500/10 text-red-400" : "border-amber-500/30 bg-amber-500/10 text-amber-400"}`}
                        >
                          🔥 {opp.diff_fmt}
                        </Badge>
                      </div>

                      {/* Exchange rates row */}
                      <div className="grid grid-cols-2 gap-3 mb-3">
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-2.5">
                          <p className={`text-xs font-semibold mb-0.5 ${getExchangeColor(opp.exchange1)}`}>{opp.exchange1}</p>
                          <p className="text-[10px] text-muted-foreground font-mono mb-1">{opp.original_symbol1}</p>
                          <p className={`text-sm font-bold tabular-nums ${opp.rate1 > 0 ? "text-emerald-400" : opp.rate1 < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                            {opp.rate1_fmt}
                          </p>
                          <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">{opp.next_funding1}</p>
                        </div>
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-2.5">
                          <p className={`text-xs font-semibold mb-0.5 ${getExchangeColor(opp.exchange2)}`}>{opp.exchange2}</p>
                          <p className="text-[10px] text-muted-foreground font-mono mb-1">{opp.original_symbol2}</p>
                          <p className={`text-sm font-bold tabular-nums ${opp.rate2 > 0 ? "text-emerald-400" : opp.rate2 < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                            {opp.rate2_fmt}
                          </p>
                          <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">{opp.next_funding2}</p>
                        </div>
                      </div>

                      {/* Strategy + Profit row */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="outline" className="border-red-500/20 bg-red-500/5 text-red-400 text-[10px] font-semibold gap-1">
                            <TrendingDownIcon className="h-3 w-3" />
                            Short {opp.short_exchange}
                          </Badge>
                          <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/5 text-emerald-400 text-[10px] font-semibold gap-1">
                            <TrendingUpIcon className="h-3 w-3" />
                            Long {opp.long_exchange}
                          </Badge>
                        </div>
                        {positionSize > 0 && (
                          <div className="text-right">
                            <span className="text-sm font-bold tabular-nums text-emerald-400">
                              +${calcProfit(opp.diff).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                            <p className="text-[10px] text-muted-foreground">per funding</p>
                          </div>
                        )}
                      </div>

                      {/* Spread */}
                      <div className="flex items-center">
                        <span className={`text-[11px] font-semibold tabular-nums ${opp.spread_pct > 0.1 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                          Spread: {opp.spread_pct.toFixed(4)}% (${opp.price_diff.toFixed(2)})
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}

              {/* Mobile Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-2">
                  <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}>
                    ‹ Prev
                  </Button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Page <span className="text-foreground font-medium">{currentPage}</span> / <span className="text-foreground font-medium">{totalPages}</span>
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
                    Next ›
                  </Button>
                </div>
              )}
            </div>
          )
        }

        {/* ──────────────── DESKTOP TABLE (lg+) ──────────────── */}
        {
          data && data.opportunities.length > 0 && (
            <Card className="hidden lg:block border-border/50 bg-card/80 backdrop-blur-sm shadow-2xl shadow-black/20 overflow-hidden animate-fade-in-up" style={{ animationDelay: "0.3s" }}>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border/50 bg-muted/30 hover:bg-muted/30">
                      <TableHead className="w-12 text-center text-xs font-bold uppercase tracking-wider text-muted-foreground">#</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Symbol</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Exchange 1</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Rate 1</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Exchange 2</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Rate 2</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Difference</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Spread</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Strategy</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Next Funding</TableHead>
                      <TableHead className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Est. Profit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currentItems.map((opp, idx) => {
                      const globalIndex = (currentPage - 1) * itemsPerPage + idx;
                      return (
                        <TableRow
                          key={`${opp.symbol}-${opp.exchange1}-${opp.exchange2}`}
                          className="border-border/30 hover:bg-indigo-500/[0.03] animate-fade-in-up"
                          style={{ animationDelay: `${0.3 + idx * 0.03}s` }}
                        >
                          {/* Rank */}
                          <TableCell className="text-center">
                            <span className={`font-extrabold text-base tabular-nums ${globalIndex < 3 ? "text-amber-400 drop-shadow-[0_0_6px_rgba(251,191,36,0.4)]" : "text-muted-foreground"}`}>
                              {globalIndex + 1}
                            </span>
                          </TableCell>

                          {/* Symbol + Copy */}
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-[15px] text-foreground tracking-wide">
                                {opp.symbol}
                              </span>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className={`transition-all ${copiedSymbol === opp.symbol
                                      ? "text-emerald-400 bg-emerald-500/10"
                                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                                      }`}
                                    onClick={() => copySymbol(opp.symbol)}
                                  >
                                    {copiedSymbol === opp.symbol ? <CheckIcon /> : <CopyIcon />}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {copiedSymbol === opp.symbol ? "Copied!" : `Copy ${opp.symbol}`}
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </TableCell>

                          {/* Exchange 1 */}
                          <TableCell>
                            <div className="flex flex-col gap-0.5">
                              <span className={`font-semibold text-sm ${getExchangeColor(opp.exchange1)}`}>
                                {opp.exchange1}
                              </span>
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {opp.original_symbol1}
                              </span>
                            </div>
                          </TableCell>

                          {/* Rate 1 */}
                          <TableCell>
                            <span className={`font-semibold tabular-nums text-sm ${opp.rate1 > 0 ? "text-emerald-400" : opp.rate1 < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                              {opp.rate1_fmt}
                            </span>
                          </TableCell>

                          {/* Exchange 2 */}
                          <TableCell>
                            <div className="flex flex-col gap-0.5">
                              <span className={`font-semibold text-sm ${getExchangeColor(opp.exchange2)}`}>
                                {opp.exchange2}
                              </span>
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {opp.original_symbol2}
                              </span>
                            </div>
                          </TableCell>

                          {/* Rate 2 */}
                          <TableCell>
                            <span className={`font-semibold tabular-nums text-sm ${opp.rate2 > 0 ? "text-emerald-400" : opp.rate2 < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                              {opp.rate2_fmt}
                            </span>
                          </TableCell>

                          {/* Difference */}
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={`tabular-nums text-xs font-bold gap-1 ${opp.diff >= 0.01
                                ? "border-red-500/30 bg-red-500/10 text-red-400"
                                : "border-amber-500/30 bg-amber-500/10 text-amber-400"
                                }`}
                            >
                              🔥 {opp.diff_fmt}
                            </Badge>
                          </TableCell>

                          {/* Price Spread */}
                          <TableCell>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex flex-col gap-0.5">
                                  <span className={`text-xs font-bold tabular-nums ${opp.spread_pct > 0.1 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                                    {opp.spread_pct.toFixed(4)}%
                                  </span>
                                  <span className="text-[10px] text-muted-foreground tabular-nums">
                                    ${opp.price_diff.toFixed(2)}
                                  </span>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">
                                <p className="font-semibold mb-1">Price Spread</p>
                                <p>{opp.exchange1}: ${opp.price1.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                <p>{opp.exchange2}: ${opp.price2.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                <p className="mt-1">Diff: ${opp.price_diff.toFixed(2)} ({opp.spread_pct.toFixed(4)}%)</p>
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>

                          {/* Strategy */}
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <Badge variant="outline" className="border-red-500/20 bg-red-500/5 text-red-400 text-[11px] font-semibold gap-1 w-fit">
                                <TrendingDownIcon className="h-3 w-3" />
                                Short {opp.short_exchange}
                              </Badge>
                              <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/5 text-emerald-400 text-[11px] font-semibold gap-1 w-fit">
                                <TrendingUpIcon className="h-3 w-3" />
                                Long {opp.long_exchange}
                              </Badge>
                            </div>
                          </TableCell>

                          {/* Next Funding */}
                          <TableCell>
                            <div className="flex flex-col gap-0.5 text-xs text-muted-foreground tabular-nums">
                              <span>{opp.exchange1}: {opp.next_funding1}</span>
                              <span>{opp.exchange2}: {opp.next_funding2}</span>
                            </div>
                          </TableCell>

                          {/* Estimated Profit */}
                          <TableCell>
                            {positionSize > 0 ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="flex flex-col gap-0.5">
                                    <span className="text-sm font-bold tabular-nums text-emerald-400">
                                      +${calcProfit(opp.diff).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground tabular-nums">
                                      per funding
                                    </span>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs text-xs">
                                  <p className="font-semibold mb-1">Profit Breakdown</p>
                                  <p>Position: ${positionSize.toLocaleString()} ({usdt} USDT × {leverage}x)</p>
                                  <p>Rate diff: {opp.diff_fmt}</p>
                                  <p className="font-bold text-emerald-400">= ${calcProfit(opp.diff).toFixed(2)} per funding period</p>
                                  <p className="mt-1 text-muted-foreground">~${(calcProfit(opp.diff) * 3).toFixed(2)}/day (3 fundings)</p>
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="text-xs text-muted-foreground">Enter values</span>
                            )}
                          </TableCell>


                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-border/50 px-4 py-3 sm:px-6 bg-muted/20">
                  <div className="flex flex-1 justify-between sm:hidden">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                    >
                      Next
                    </Button>
                  </div>
                  <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">
                        Showing <span className="font-medium tabular-nums text-foreground">{(currentPage - 1) * itemsPerPage + 1}</span> to <span className="font-medium tabular-nums text-foreground">{Math.min(currentPage * itemsPerPage, data.opportunities.length)}</span> of <span className="font-medium tabular-nums text-foreground">{data.opportunities.length}</span> results
                      </p>
                    </div>
                    <div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setCurrentPage(1)}
                          disabled={currentPage === 1}
                        >
                          <span className="sr-only">First</span>
                          «
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                          disabled={currentPage === 1}
                        >
                          <span className="sr-only">Previous</span>
                          ‹
                        </Button>
                        <div className="flex items-center justify-center text-sm font-medium w-24 tabular-nums text-muted-foreground">
                          Page <span className="text-foreground mx-1">{currentPage}</span> of <span className="text-foreground mx-1">{totalPages}</span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                          disabled={currentPage === totalPages}
                        >
                          <span className="sr-only">Next</span>
                          ›
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setCurrentPage(totalPages)}
                          disabled={currentPage === totalPages}
                        >
                          <span className="sr-only">Last</span>
                          »
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </Card>
          )
        }

        {/* ──────────────── EMPTY STATE ──────────────── */}
        {
          data && data.opportunities.length === 0 && (
            <Card className="border-border/50 animate-fade-in-up">
              <CardContent className="flex flex-col items-center py-20">
                <span className="text-6xl mb-4">🔍</span>
                <h2 className="text-xl font-bold text-foreground mb-2">No Arbitrage Opportunities</h2>
                <p className="text-sm text-muted-foreground">
                  No funding rate differences found above the {data.threshold} threshold. Try scanning again later.
                </p>
              </CardContent>
            </Card>
          )
        }
      </div >

      <Toaster theme="dark" position="bottom-right" richColors />
    </div >
  );
}
