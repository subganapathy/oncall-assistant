#!/usr/bin/env npx tsx
/**
 * E2E Agent Test
 *
 * Simulates the full diagnostic flow using Anthropic SDK with tool use.
 * This is what happens when someone types "Debug ord-1234" - Claude
 * calls tools in a loop until it has enough info to diagnose.
 *
 * Usage:
 *   # Start mock resource API first
 *   npx tsx scripts/mock-resource-api.ts
 *
 *   # In another terminal
 *   ANTHROPIC_API_KEY=... npx tsx scripts/test-e2e-agent.ts
 *
 *   # Or with a specific resource
 *   ANTHROPIC_API_KEY=... npx tsx scripts/test-e2e-agent.ts ord-1234
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Tool, ToolUseBlock, TextBlock, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";

// Import our tool implementations
import {
    getServiceCatalog,
    listServices,
    getDependencies,
    getResource,
    findResourceOwner,
} from "../src/tools/catalog.js";

// Force mock mode
process.env.BACKEND_MODE = "mock";

// ─────────────────────────────────────────────────────────────
// TOOL DEFINITIONS (what Claude sees)
// ─────────────────────────────────────────────────────────────

const tools: Tool[] = [
    {
        name: "get_resource",
        description: "Get resource status and information. Use this to debug a specific resource like ord-1234, usr-5678, etc. Returns live status from handler_url if configured, plus service catalog context (owner, dependencies, observability).",
        input_schema: {
            type: "object" as const,
            properties: {
                resource_id: {
                    type: "string",
                    description: "Resource ID to look up (e.g., 'ord-1234', 'usr-5678')",
                },
                include_context: {
                    type: "boolean",
                    description: "Include service catalog context (owner, dependencies). Default true.",
                },
            },
            required: ["resource_id"],
        },
    },
    {
        name: "find_resource_owner",
        description: "Find which service owns a resource. Quick lookup without fetching full resource data.",
        input_schema: {
            type: "object" as const,
            properties: {
                resource_id: {
                    type: "string",
                    description: "Resource ID to find owner for",
                },
            },
            required: ["resource_id"],
        },
    },
    {
        name: "get_service_catalog",
        description: "Get full catalog entry for a service including team, dependencies, observability config, and resources it owns.",
        input_schema: {
            type: "object" as const,
            properties: {
                service: {
                    type: "string",
                    description: "Service name to look up",
                },
            },
            required: ["service"],
        },
    },
    {
        name: "list_services",
        description: "List all services in the catalog, optionally filtered by team.",
        input_schema: {
            type: "object" as const,
            properties: {
                team: {
                    type: "string",
                    description: "Filter by team name (optional)",
                },
            },
            required: [],
        },
    },
    {
        name: "get_dependencies",
        description: "Get dependencies for a service. Critical for understanding blast radius during incidents.",
        input_schema: {
            type: "object" as const,
            properties: {
                service: {
                    type: "string",
                    description: "Service name",
                },
                include_transitive: {
                    type: "boolean",
                    description: "Include dependencies of dependencies (one level deep)",
                },
            },
            required: ["service"],
        },
    },
];

// ─────────────────────────────────────────────────────────────
// TOOL EXECUTION
// ─────────────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    console.log(`\n  [Tool] ${name}(${JSON.stringify(input)})`);

    switch (name) {
        case "get_resource":
            return await getResource({
                resource_id: input.resource_id as string,
                include_context: input.include_context as boolean ?? true,
            });
        case "find_resource_owner":
            return await findResourceOwner({
                resource_id: input.resource_id as string,
            });
        case "get_service_catalog":
            return await getServiceCatalog({
                service: input.service as string,
            });
        case "list_services":
            return await listServices({
                team: input.team as string | undefined,
            });
        case "get_dependencies":
            return await getDependencies({
                service: input.service as string,
                include_transitive: input.include_transitive as boolean,
            });
        default:
            return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
}

// ─────────────────────────────────────────────────────────────
// AGENT LOOP
// ─────────────────────────────────────────────────────────────

async function runAgent(prompt: string): Promise<string> {
    const client = new Anthropic();

    console.log("\n" + "=".repeat(60));
    console.log("PROMPT:", prompt);
    console.log("=".repeat(60));

    const messages: Anthropic.MessageParam[] = [
        { role: "user", content: prompt },
    ];

    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
        iterations++;
        console.log(`\n--- Iteration ${iterations} ---`);

        const response = await client.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            tools,
            messages,
        });

        console.log(`  Stop reason: ${response.stop_reason}`);

        // Collect tool uses and text
        const toolUses: ToolUseBlock[] = [];
        let textContent = "";

        for (const block of response.content) {
            if (block.type === "tool_use") {
                toolUses.push(block);
            } else if (block.type === "text") {
                textContent += block.text;
            }
        }

        // If there's text, show it
        if (textContent) {
            console.log(`\n  [Claude] ${textContent.substring(0, 200)}${textContent.length > 200 ? "..." : ""}`);
        }

        // If no tool use, we're done
        if (response.stop_reason === "end_turn" || toolUses.length === 0) {
            console.log("\n" + "=".repeat(60));
            console.log("FINAL RESPONSE:");
            console.log("=".repeat(60));
            return textContent;
        }

        // Execute tools and collect results
        const toolResults: ToolResultBlockParam[] = [];

        for (const toolUse of toolUses) {
            const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
            console.log(`  [Result] ${result.substring(0, 100)}${result.length > 100 ? "..." : ""}`);
            toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: result,
            });
        }

        // Add assistant response and tool results to messages
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
    }

    return "Max iterations reached";
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
    const resourceId = process.argv[2] || "ord-1234";

    console.log(`
╔════════════════════════════════════════════════════════════╗
║  On-Call Assistant - E2E Agent Test                        ║
║                                                            ║
║  This simulates the full diagnostic flow:                  ║
║  1. User asks "Debug ${resourceId}"                          ║
║  2. Claude calls tools to gather info                      ║
║  3. Claude returns diagnosis                               ║
║                                                            ║
║  Make sure mock-resource-api.ts is running on port 4000    ║
╚════════════════════════════════════════════════════════════╝
`);

    const prompt = `Debug ${resourceId}

You are an on-call assistant. Investigate this resource and provide a diagnosis.
Use the available tools to:
1. Look up the resource status
2. Understand the owning service
3. Check dependencies if relevant

Then provide a concise diagnosis with:
- Current status
- Root cause (if identifiable)
- Recommended actions`;

    try {
        const diagnosis = await runAgent(prompt);
        console.log(diagnosis);
    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    }
}

main();
