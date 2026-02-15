import { NextResponse, type NextRequest } from "next/server";
import { scan } from "@/lib/scanner";

export const dynamic = "force-dynamic";

// Vercel serverless functions default to 10s; bump to 30s for exchange APIs
export const maxDuration = 30;

export async function GET(request: NextRequest) {
    try {
        // Read query params for threshold and delta toggle
        const searchParams = request.nextUrl.searchParams;
        const threshold = parseFloat(searchParams.get("threshold") || "0.003");
        const includeDelta = searchParams.get("delta") !== "false";

        const data = await scan(threshold, includeDelta);

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
