import { NextResponse, type NextRequest } from "next/server";
import { exec } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    const botPath = path.join(process.cwd(), "bot.py");

    // Read query params for threshold and delta toggle
    const searchParams = request.nextUrl.searchParams;
    const threshold = searchParams.get("threshold") || "0.003";
    const includeDelta = searchParams.get("delta") !== "false";

    let cmd = `python "${botPath}" --json --threshold ${threshold}`;
    if (!includeDelta) {
        cmd += " --no-delta";
    }

    return new Promise<NextResponse>((resolve) => {
        exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("Bot error:", stderr || error.message);
                resolve(
                    NextResponse.json(
                        { error: "Failed to run scanner", details: stderr || error.message },
                        { status: 500 }
                    )
                );
                return;
            }

            try {
                const data = JSON.parse(stdout.trim());
                resolve(NextResponse.json(data));
            } catch (parseError) {
                console.error("Parse error:", stdout);
                resolve(
                    NextResponse.json(
                        { error: "Failed to parse scanner output" },
                        { status: 500 }
                    )
                );
            }
        });
    });
}
