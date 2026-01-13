/**
 * Slack Webhook Handler
 *
 * This is the entry point when an alert fires and hits Slack.
 * It:
 * 1. Parses the incoming alert
 * 2. Fetches service context from the catalog
 * 3. Runs Claude via Agent SDK to diagnose
 * 4. Posts the diagnosis back to Slack
 *
 * The Agent SDK is what makes this "agentic" - Claude runs in a loop,
 * calling tools (via MCP) until it has enough info to diagnose.
 */

import { App } from "@slack/bolt";
import { queryOne } from "../lib/db.js";
import type { Alert, ServiceCatalog, Diagnosis } from "../lib/types.js";

// ─────────────────────────────────────────────────────────────
// ALERT PARSING
// ─────────────────────────────────────────────────────────────

/**
 * Parse an alert from a Slack message.
 *
 * Alerts typically come from PagerDuty/AlertManager with a format like:
 * ":alert: FIRING: HighErrorRate for user-service in prod-us-east-1"
 *
 * This parser extracts structured data from the message.
 */
export function parseAlert(message: string, slackContext: {
    channel: string;
    thread_ts?: string;
    user?: string;
}): Partial<Alert> | null {
    // Common alert patterns
    const patterns = [
        // PagerDuty format: "[FIRING] AlertName for service"
        /\[(FIRING|RESOLVED)\]\s*(?<name>\w+)\s+for\s+(?<service>[\w-]+)/i,

        // AlertManager format: "FIRING: AlertName service=xxx"
        /(?<status>FIRING|RESOLVED):\s*(?<name>\w+).*service[=:]"?(?<service>[\w-]+)"?/i,

        // Simple format: "Alert: service-name is down"
        /alert:?\s*(?<service>[\w-]+)\s+(?<name>.*)/i,
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match?.groups) {
            return {
                id: `alert-${Date.now()}`,
                service: match.groups.service,
                name: match.groups.name || "Unknown",
                message: message,
                severity: message.toLowerCase().includes("critical") ? "P0" : "P1",
                slack: slackContext,
                fired_at: new Date(),
            };
        }
    }

    return null;
}

// ─────────────────────────────────────────────────────────────
// AGENT SDK INTEGRATION
// ─────────────────────────────────────────────────────────────

/**
 * Run the diagnostic agent using Claude Agent SDK.
 *
 * This is where the magic happens:
 * 1. We give Claude a prompt with the alert context
 * 2. Claude decides which tools to use (from our MCP server)
 * 3. Claude calls tools, analyzes results, repeats
 * 4. Claude returns a diagnosis
 *
 * NOTE: The Agent SDK package may not be publicly available yet.
 * This code shows the intended integration pattern.
 * For now, you can test with the MCP server directly via Claude CLI.
 */
export async function runDiagnosticAgent(
    alert: Partial<Alert>,
    serviceContext: ServiceCatalog
): Promise<string> {
    // Build the diagnostic prompt
    const prompt = buildDiagnosticPrompt(alert, serviceContext);

    // ─────────────────────────────────────────────────────────
    // OPTION 1: Using Agent SDK (when available)
    // ─────────────────────────────────────────────────────────
    //
    // import { query } from "@anthropic-ai/claude-agent-sdk";
    //
    // let diagnosis = "";
    //
    // for await (const message of query({
    //     prompt: prompt,
    //     options: {
    //         allowedTools: [
    //             "get_service_catalog",
    //             "get_service_health",
    //             "get_recent_deploys",
    //             "query_logs",
    //             "get_pod_status",
    //             "check_dependency_health",
    //             "get_escalation_path",
    //         ],
    //         mcpServers: ["oncall-assistant"],
    //     }
    // })) {
    //     if (message.type === "text") {
    //         // Stream output (optional)
    //         process.stdout.write(message.content);
    //     }
    //     if (message.type === "result") {
    //         diagnosis = message.result;
    //     }
    // }
    //
    // return diagnosis;

    // ─────────────────────────────────────────────────────────
    // OPTION 2: Using Claude API directly (fallback)
    // ─────────────────────────────────────────────────────────
    //
    // This is a simpler approach that doesn't use the full agent loop.
    // It calls Claude once with all context pre-loaded.

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();

    // Pre-fetch context that Claude would normally get via tools
    // This is less powerful but works without Agent SDK
    const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{
            role: "user",
            content: prompt,
        }],
    });

    // Extract text from response
    const textBlock = response.content.find(block => block.type === "text");
    return textBlock?.text || "Unable to generate diagnosis";
}

/**
 * Build the diagnostic prompt with all context.
 */
function buildDiagnosticPrompt(
    alert: Partial<Alert>,
    context: ServiceCatalog
): string {
    const deps = context.dependencies?.map(d => d.name).join(", ") || "none";

    return `Alert fired on ${alert.service}: ${alert.name}
Severity: ${alert.severity}
Message: ${alert.message}
Team: ${context.team} (${context.slack_channel})
Dependencies: ${deps}

Diagnose and recommend actions. Be concise - this is for an on-call engineer at 3am.`;
}

// ─────────────────────────────────────────────────────────────
// SLACK BOT
// ─────────────────────────────────────────────────────────────

/**
 * Create and configure the Slack bot.
 */
export function createSlackBot() {
    const app = new App({
        token: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: true,
        appToken: process.env.SLACK_APP_TOKEN,
    });

    // ─────────────────────────────────────────────────────────
    // Listen for messages in alert channels
    // ─────────────────────────────────────────────────────────

    app.message(async ({ message, say, client }) => {
        // Only process bot messages (from PagerDuty, AlertManager, etc.)
        // or messages that look like alerts
        if (message.subtype && message.subtype !== "bot_message") {
            return;
        }

        const text = (message as { text?: string }).text || "";

        // Check if this looks like an alert
        if (!text.toLowerCase().includes("firing") &&
            !text.toLowerCase().includes("alert")) {
            return;
        }

        // Parse the alert
        const alert = parseAlert(text, {
            channel: message.channel,
            thread_ts: (message as { ts?: string }).ts,
        });

        if (!alert || !alert.service) {
            return;  // Not a recognizable alert
        }

        console.log(`[Slack] Alert detected: ${alert.name} for ${alert.service}`);

        // Post "analyzing" message
        const analyzing = await say({
            text: `:robot_face: Analyzing alert for *${alert.service}*...`,
            thread_ts: (message as { ts?: string }).ts,
        });

        try {
            // Fetch service context
            const context = await queryOne<ServiceCatalog>(
                "SELECT * FROM services WHERE name = $1",
                [alert.service]
            );

            if (!context) {
                await client.chat.update({
                    channel: message.channel,
                    ts: analyzing.ts!,
                    text: `:warning: Service *${alert.service}* not found in catalog. Cannot auto-diagnose.`,
                });
                return;
            }

            // Run diagnostic agent
            const diagnosis = await runDiagnosticAgent(alert, context);

            // Post diagnosis
            await client.chat.update({
                channel: message.channel,
                ts: analyzing.ts!,
                text: `:white_check_mark: *On-Call Assistant Diagnosis*\n\n${diagnosis}`,
            });

        } catch (error) {
            console.error("[Slack] Diagnosis failed:", error);
            await client.chat.update({
                channel: message.channel,
                ts: analyzing.ts!,
                text: `:x: Failed to generate diagnosis. Error: ${error}`,
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // Slash command: /diagnose <service>
    // ─────────────────────────────────────────────────────────

    app.command("/diagnose", async ({ command, ack, respond }) => {
        await ack();

        const service = command.text.trim();
        if (!service) {
            await respond("Usage: `/diagnose <service-name>`");
            return;
        }

        await respond(`:robot_face: Running diagnostics for *${service}*...`);

        try {
            const context = await queryOne<ServiceCatalog>(
                "SELECT * FROM services WHERE name = $1",
                [service]
            );

            if (!context) {
                await respond(`:warning: Service *${service}* not found in catalog.`);
                return;
            }

            // Create a synthetic "health check" alert
            const alert: Partial<Alert> = {
                id: `manual-${Date.now()}`,
                service: service,
                name: "ManualDiagnostic",
                message: `Manual diagnostic requested by ${command.user_name}`,
                severity: "P2",
                fired_at: new Date(),
            };

            const diagnosis = await runDiagnosticAgent(alert, context);
            await respond(`:white_check_mark: *Diagnostic Results for ${service}*\n\n${diagnosis}`);

        } catch (error) {
            await respond(`:x: Diagnostic failed: ${error}`);
        }
    });

    return app;
}

// ─────────────────────────────────────────────────────────────
// STANDALONE RUNNER
// ─────────────────────────────────────────────────────────────

/**
 * Run the Slack bot as a standalone service.
 *
 * Usage: npx tsx src/handlers/slack.ts
 */
async function main() {
    console.log("🤖 Starting On-Call Assistant Slack Bot...");

    const app = createSlackBot();
    await app.start();

    console.log("✅ Slack bot is running!");
    console.log("   Listening for alerts in configured channels");
    console.log("   Slash command: /diagnose <service>");
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
