import { NextResponse, type NextRequest } from "next/server";
import { executeTrade, type TradeRequest } from "@/lib/scanner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
    console.log("Executing arbitrage trade...");
    try {
        const body: TradeRequest = await request.json();

        // Validate required fields
        if (
            !body.symbol ||
            !body.short_exchange ||
            !body.long_exchange ||
            !body.original_symbol_short ||
            !body.original_symbol_long ||
            !body.quantity ||
            !body.leverage
        ) {
            return NextResponse.json(
                { error: "Missing required trade parameters" },
                { status: 400 }
            );
        }

        if (body.quantity <= 0 || body.leverage <= 0) {
            return NextResponse.json(
                { error: "Quantity and leverage must be greater than 0" },
                { status: 400 }
            );
        }

        const result = await executeTrade(body);

        return NextResponse.json(result, {
            status: result.success ? 200 : 500,
        });
    } catch (error) {
        console.error("Trade execution error:", error);
        return NextResponse.json(
            {
                error: "Failed to execute trade",
                details:
                    error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}
