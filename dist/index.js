#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DgLabController, configFromEnv } from "./dglab/controller.js";
const controller = new DgLabController(configFromEnv());
const server = new McpServer({
    name: "dg-lab-coyote-mcp",
    version: "1.0.0"
});
function jsonResult(value) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(value, null, 2)
            }
        ]
    };
}
async function runTool(fn) {
    try {
        return jsonResult(await fn());
    }
    catch (error) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: error instanceof Error ? error.message : String(error)
                }
            ]
        };
    }
}
server.registerTool("dg_status", {
    title: "DG-Lab Status",
    description: "Read socket, binding, arm, strength, and hard-cap state. Does not change output.",
    inputSchema: {}
}, async () => runTool(() => controller.status()));
server.registerTool("dg_pairing", {
    title: "DG-Lab Pairing",
    description: "Start the local DG-Lab WebSocket bridge and return a pairing URL plus optional SVG QR code for the official DG-Lab App.",
    inputSchema: {
        host: z.string().optional().describe("WebSocket listen host. Default: DG_LAB_WS_HOST or 0.0.0.0."),
        port: z.number().int().min(1).max(65535).optional().describe("WebSocket listen port. Default: DG_LAB_WS_PORT or 18888."),
        publicWsUrl: z.string().optional().describe("Phone-reachable ws://host:port URL. Default: DG_LAB_PUBLIC_WS_URL or detected LAN IPv4."),
        includeQrSvg: z.boolean().optional().describe("Return qrSvg in the tool output. Default: true.")
    }
}, async (args) => runTool(() => controller.createPairing(args)));
server.registerTool("dg_arm", {
    title: "DG-Lab Arm",
    description: "Temporarily unlock non-zero stimulation commands. Keep ttlMs short. If DG_LAB_ARM_TOKEN is configured, armToken must match it.",
    inputSchema: {
        maxStrengthA: z.number().int().min(0).max(200).optional().describe("Session cap for channel A; also clamped by env and App/device cap."),
        maxStrengthB: z.number().int().min(0).max(200).optional().describe("Session cap for channel B; also clamped by env and App/device cap."),
        ttlMs: z.number().int().min(1000).optional().describe("Arm lifetime in milliseconds; clamped by DG_LAB_MAX_ARM_TTL_MS."),
        armToken: z.string().optional().describe("Must match DG_LAB_ARM_TOKEN when that env var is set."),
        reason: z.string().max(200).optional().describe("Short operator note for status output.")
    }
}, async (args) => runTool(() => controller.arm(args)));
server.registerTool("dg_disarm", {
    title: "DG-Lab Disarm",
    description: "Lock non-zero output. By default also clears queues and sets both channels to zero.",
    inputSchema: {
        zero: z.boolean().optional().describe("Clear pulse queues and zero both channels. Default: true.")
    }
}, async (args) => runTool(() => controller.disarm(args.zero ?? true)));
server.registerTool("dg_emergency_stop", {
    title: "DG-Lab Emergency Stop",
    description: "Immediately disarm, clear both pulse queues, and set both channels to zero. Does not require dg_arm.",
    inputSchema: {}
}, async () => runTool(() => controller.emergencyStop()));
server.registerTool("dg_set_strength", {
    title: "DG-Lab Set Strength",
    description: "Set, increase, decrease, or zero A/B strength. Non-zero output requires dg_arm and is clamped by all configured caps.",
    inputSchema: {
        channel: z.enum(["A", "B", "both"]).describe("Output channel."),
        mode: z.enum(["set", "increase", "decrease", "zero"]).describe("Strength operation."),
        value: z.number().int().min(0).max(200).optional().describe("Strength value for set/increase/decrease. Ignored for zero.")
    }
}, async (args) => runTool(() => controller.setStrength(args)));
server.registerTool("dg_pulse", {
    title: "DG-Lab Pulse",
    description: "Send a waveform to one channel. Requires dg_arm. The device strength is still controlled separately through dg_set_strength.",
    inputSchema: {
        channel: z.enum(["A", "B"]).describe("Pulse output channel."),
        preset: z.enum(["test", "constant", "breath", "ramp"]).optional().describe("Built-in waveform preset. Default: test."),
        durationMs: z.number().int().min(100).optional().describe("Waveform duration; clamped by DG_LAB_MAX_PULSE_DURATION_MS."),
        level: z.number().int().min(1).max(100).optional().describe("Waveform envelope level 1-100. Default: 40."),
        freqMs: z.number().int().min(10).max(1000).optional().describe("Waveform frequency period in ms. Default: 100."),
        customFrames: z.array(z.string()).optional().describe("Optional raw Coyote V3 frames, each 16 hex chars. Max 70 frames.")
    }
}, async (args) => runTool(() => controller.pulse(args)));
server.registerTool("dg_clear_pulse", {
    title: "DG-Lab Clear Pulse Queue",
    description: "Clear queued waveform data for A, B, or both channels. Does not require dg_arm.",
    inputSchema: {
        channel: z.enum(["A", "B", "both"]).describe("Channel queue to clear.")
    }
}, async (args) => runTool(() => controller.clearPulse(args.channel)));
server.registerTool("dg_shutdown", {
    title: "DG-Lab Shutdown",
    description: "Emergency stop, close WebSocket connections, and stop the DG-Lab bridge.",
    inputSchema: {}
}, async () => runTool(() => controller.shutdown()));
const transport = new StdioServerTransport();
await server.connect(transport);
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        try {
            await controller.shutdown();
        }
        finally {
            process.exit(0);
        }
    });
}
