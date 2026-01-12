/**
 * Simple MCP test client to verify the server works.
 *
 * Run with: npx tsx scripts/test-mcp.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";

async function main() {
    console.log("Starting MCP server test...\n");

    // Start the MCP server as a child process
    const serverProcess = spawn("node", ["dist/index.js"], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
    });

    // Capture stderr for debug output
    serverProcess.stderr?.on("data", (data) => {
        console.error(`[Server] ${data.toString().trim()}`);
    });

    // Create transport using the server's stdin/stdout
    const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/index.js"],
        env: {
            ...process.env,
            BACKEND_MODE: "mock",
        },
    });

    // Create MCP client
    const client = new Client(
        { name: "test-client", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        // Connect to server
        console.log("Connecting to MCP server...");
        await client.connect(transport);
        console.log("Connected!\n");

        // List available tools
        console.log("=== Available Tools ===");
        const tools = await client.listTools();
        for (const tool of tools.tools) {
            console.log(`  - ${tool.name}: ${tool.description?.substring(0, 60)}...`);
        }
        console.log(`\nTotal tools: ${tools.tools.length}\n`);

        // List available prompts
        console.log("=== Available Prompts ===");
        const prompts = await client.listPrompts();
        for (const prompt of prompts.prompts) {
            console.log(`  - ${prompt.name}: ${prompt.description}`);
        }
        console.log(`\nTotal prompts: ${prompts.prompts.length}\n`);

        // List available resources
        console.log("=== Available Resources ===");
        const resources = await client.listResources();
        for (const resource of resources.resources) {
            console.log(`  - ${resource.uri}: ${resource.description}`);
        }
        console.log(`\nTotal resources: ${resources.resources.length}\n`);

        // Test calling a tool - list_services
        console.log("=== Testing list_services Tool ===");
        const listResult = await client.callTool({
            name: "list_services",
            arguments: {},
        });

        if (listResult.content && listResult.content.length > 0) {
            const content = listResult.content[0];
            if ("text" in content && content.text) {
                try {
                    const parsed = JSON.parse(content.text);
                    console.log("Result:", JSON.stringify(parsed, null, 2));
                } catch {
                    console.log("Raw result:", content.text);
                }
            } else {
                console.log("Content:", JSON.stringify(content, null, 2));
            }
        } else {
            console.log("No content returned");
        }

        console.log("\n✅ MCP server is working correctly!");

    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    } finally {
        await client.close();
        serverProcess.kill();
    }
}

main().catch(console.error);
