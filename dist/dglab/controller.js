import { clearQueueCommand, clampInt, pulseCommand, strengthCommand } from "./protocol.js";
import { buildWaveform, normalizeCustomFrames } from "./waveforms.js";
import { buildPairingQrSvg, buildPairingUrl, detectLanIPv4 } from "./qr.js";
import { DgLabSocketServer } from "./socket-server.js";
export class DgLabController {
    config;
    socketServer = null;
    armState = null;
    currentStrength = { A: 0, B: 0 };
    deviceLimit = { A: 200, B: 200 };
    lastCommandAt = 0;
    constructor(config) {
        this.config = config;
    }
    async createPairing(options) {
        const server = await this.ensureServer(options);
        const controlId = server.generateControlId();
        const publicWsUrl = this.resolvePublicWsUrl(options.publicWsUrl);
        const pairingUrl = buildPairingUrl(publicWsUrl, controlId);
        const qrSvg = options.includeQrSvg === false ? undefined : await buildPairingQrSvg(pairingUrl);
        return {
            controlId,
            publicWsUrl,
            pairingUrl,
            qrSvg,
            socket: server.status(),
            note: "Scan pairingUrl/qrSvg in the DG-Lab App. Phone must be able to reach publicWsUrl."
        };
    }
    status() {
        const armed = this.getValidArmState();
        return {
            socket: this.socketServer?.status() ?? null,
            armed: armed
                ? {
                    until: new Date(armed.armedUntil).toISOString(),
                    ttlRemainingMs: Math.max(0, armed.armedUntil - Date.now()),
                    maxStrengthA: armed.maxStrengthA,
                    maxStrengthB: armed.maxStrengthB,
                    reason: armed.reason ?? null
                }
                : null,
            currentStrength: this.currentStrength,
            deviceLimit: this.deviceLimit,
            hardCaps: {
                maxStrengthA: this.config.maxStrengthA,
                maxStrengthB: this.config.maxStrengthB,
                maxPulseDurationMs: this.config.maxPulseDurationMs,
                maxArmTtlMs: this.config.maxArmTtlMs,
                minCommandGapMs: this.config.minCommandGapMs,
                armTokenConfigured: Boolean(this.config.armToken)
            }
        };
    }
    arm(options) {
        if (this.config.armToken && options.armToken !== this.config.armToken) {
            throw new Error("invalid DG_LAB_ARM_TOKEN");
        }
        const ttlMs = clampInt(options.ttlMs ?? 60_000, 1_000, this.config.maxArmTtlMs);
        const maxStrengthA = Math.min(clampInt(options.maxStrengthA ?? this.config.maxStrengthA, 0, 200), this.config.maxStrengthA, this.deviceLimit.A);
        const maxStrengthB = Math.min(clampInt(options.maxStrengthB ?? this.config.maxStrengthB, 0, 200), this.config.maxStrengthB, this.deviceLimit.B);
        this.armState = {
            armedUntil: Date.now() + ttlMs,
            maxStrengthA,
            maxStrengthB,
            reason: options.reason
        };
        return this.status();
    }
    async disarm(zero = true) {
        this.armState = null;
        if (zero) {
            await this.emergencyStop();
        }
        return this.status();
    }
    async emergencyStop() {
        this.armState = null;
        this.currentStrength = { A: 0, B: 0 };
        const attempted = [];
        const sent = [];
        for (const channel of ["A", "B"]) {
            try {
                const command = clearQueueCommand(channel);
                attempted.push(command);
                this.sendNow(command);
                sent.push(command);
            }
            catch {
                // Keep going: zeroing should be best-effort across both channels.
            }
            try {
                const command = strengthCommand(channel, "2", 0);
                attempted.push(command);
                this.sendNow(command);
                sent.push(command);
            }
            catch {
                // Best effort if the socket is already gone.
            }
        }
        return {
            attempted,
            sent,
            status: this.status()
        };
    }
    async clearPulse(channel) {
        const channels = expandChannels(channel);
        const commands = [];
        for (const ch of channels) {
            const command = clearQueueCommand(ch);
            await this.waitForCommandGap();
            this.sendNow(command);
            commands.push(command);
        }
        return { commands, status: this.status() };
    }
    async setStrength(options) {
        const channels = expandChannels(options.channel);
        const isZeroOnly = options.mode === "zero" || (options.mode === "set" && (options.value ?? 0) <= 0);
        if (!isZeroOnly)
            this.requireArmed();
        const commands = [];
        const results = [];
        for (const channel of channels) {
            const previous = this.currentStrength[channel];
            const target = this.computeTargetStrength(channel, options);
            const delta = target - previous;
            let command = null;
            if (target === 0 && previous !== 0) {
                command = strengthCommand(channel, "2", 0);
            }
            else if (delta > 0) {
                command = strengthCommand(channel, "1", delta);
            }
            else if (delta < 0) {
                command = strengthCommand(channel, "0", Math.abs(delta));
            }
            this.currentStrength[channel] = target;
            if (command) {
                await this.waitForCommandGap();
                this.sendNow(command);
                commands.push(command);
            }
            results.push({ channel, previous, target, command });
        }
        return { commands, results, status: this.status() };
    }
    async pulse(options) {
        this.requireArmed();
        const durationMs = clampInt(options.durationMs ?? 1000, 100, this.config.maxPulseDurationMs);
        const level = clampInt(options.level ?? 40, 1, 100);
        const freqMs = clampInt(options.freqMs ?? 100, 10, 1000);
        const frames = options.customFrames
            ? normalizeCustomFrames(options.customFrames)
            : buildWaveform({
                preset: options.preset ?? "test",
                durationMs,
                level,
                freqMs
            });
        const command = pulseCommand(options.channel, frames);
        await this.waitForCommandGap();
        this.sendNow(command);
        return {
            channel: options.channel,
            frames: frames.length,
            durationMs: frames.length * 100,
            commandLength: command.length,
            status: this.status()
        };
    }
    async shutdown() {
        await this.emergencyStop();
        await this.socketServer?.stop();
        this.socketServer = null;
        return this.status();
    }
    async ensureServer(options) {
        const host = options.host ?? this.config.host;
        const port = options.port ?? this.config.port;
        if (this.socketServer) {
            if (this.socketServer.host !== host || this.socketServer.port !== port) {
                throw new Error(`server already listening on ${this.socketServer.host}:${this.socketServer.port}; restart MCP to change host/port`);
            }
            return this.socketServer;
        }
        const server = new DgLabSocketServer({ host, port });
        server.on("strength-feedback", (feedback) => this.applyStrengthFeedback(feedback));
        await server.start();
        this.socketServer = server;
        return server;
    }
    resolvePublicWsUrl(override) {
        if (override)
            return override;
        if (this.config.publicWsUrl)
            return this.config.publicWsUrl;
        return `ws://${detectLanIPv4()}:${this.config.port}`;
    }
    applyStrengthFeedback(feedback) {
        this.currentStrength = {
            A: clampInt(feedback.strengthA, 0, 200),
            B: clampInt(feedback.strengthB, 0, 200)
        };
        this.deviceLimit = {
            A: clampInt(feedback.limitA, 0, 200),
            B: clampInt(feedback.limitB, 0, 200)
        };
    }
    computeTargetStrength(channel, options) {
        if (options.mode === "zero")
            return 0;
        const value = clampInt(options.value ?? 0, 0, 200);
        const current = this.currentStrength[channel];
        const armed = this.getValidArmState();
        const sessionLimit = channel === "A" ? armed?.maxStrengthA ?? 0 : armed?.maxStrengthB ?? 0;
        const hardLimit = channel === "A" ? this.config.maxStrengthA : this.config.maxStrengthB;
        const effectiveLimit = Math.min(hardLimit, sessionLimit, this.deviceLimit[channel]);
        if (options.mode === "increase")
            return Math.min(current + value, effectiveLimit);
        if (options.mode === "decrease")
            return Math.max(current - value, 0);
        return Math.min(value, effectiveLimit);
    }
    getValidArmState() {
        if (!this.armState)
            return null;
        if (Date.now() <= this.armState.armedUntil)
            return this.armState;
        this.armState = null;
        return null;
    }
    requireArmed() {
        const armed = this.getValidArmState();
        if (!armed) {
            throw new Error("stimulation output is locked; call dg_arm with a short ttl first");
        }
        return armed;
    }
    async waitForCommandGap() {
        const elapsed = Date.now() - this.lastCommandAt;
        const remaining = this.config.minCommandGapMs - elapsed;
        if (remaining > 0) {
            await new Promise((resolve) => setTimeout(resolve, remaining));
        }
    }
    sendNow(command) {
        if (!this.socketServer) {
            throw new Error("DG-Lab WebSocket server is not started; run dg_pairing first");
        }
        this.socketServer.sendCommand(command);
        this.lastCommandAt = Date.now();
    }
}
export function configFromEnv(env = process.env) {
    return {
        host: env.DG_LAB_WS_HOST ?? "0.0.0.0",
        port: parseIntEnv(env.DG_LAB_WS_PORT, 18888),
        publicWsUrl: env.DG_LAB_PUBLIC_WS_URL,
        maxStrengthA: parseIntEnv(env.DG_LAB_MAX_STRENGTH_A, 30),
        maxStrengthB: parseIntEnv(env.DG_LAB_MAX_STRENGTH_B, 30),
        maxPulseDurationMs: parseIntEnv(env.DG_LAB_MAX_PULSE_DURATION_MS, 7000),
        maxArmTtlMs: parseIntEnv(env.DG_LAB_MAX_ARM_TTL_MS, 10 * 60 * 1000),
        minCommandGapMs: parseIntEnv(env.DG_LAB_MIN_COMMAND_GAP_MS, 350),
        armToken: env.DG_LAB_ARM_TOKEN
    };
}
function parseIntEnv(value, fallback) {
    if (!value)
        return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}
function expandChannels(channel) {
    return channel === "both" ? ["A", "B"] : [channel];
}
