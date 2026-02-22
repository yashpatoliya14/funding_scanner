import { NextResponse, type NextRequest } from "next/server";
import { scan } from "@/lib/scanner";

export const dynamic = "force-dynamic";

// Vercel serverless functions default to 10s; bump to 60s for exchange APIs (Pro plan)
export const maxDuration = 60;

export async function GET(request: NextRequest) {
    console.log("Starting funding rate scan...");
    try {
        // Read query params for threshold
        const searchParams = request.nextUrl.searchParams;
        const threshold = parseFloat(searchParams.get("threshold") || "0.003");

        const data = await scan(threshold);

        return NextResponse.json(data);
    } catch (error) {
        console.error("Scanner error:", error);
        return NextResponse.json(
            {
                error: "Failed to run scanner",
                details: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}
