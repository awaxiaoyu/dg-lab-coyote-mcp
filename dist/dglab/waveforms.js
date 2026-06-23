import { FRAME_DURATION_MS, MAX_PULSE_FRAMES_PER_SEND, clampInt, isPulseFrameHex, simpleWaveFrame } from "./protocol.js";
export function buildWaveform(options) {
    const frameCount = clampInt(Math.ceil(options.durationMs / FRAME_DURATION_MS), 1, MAX_PULSE_FRAMES_PER_SEND);
    const level = clampInt(options.level, 0, 100);
    const freqMs = clampInt(options.freqMs, 10, 1000);
    const frames = [];
    for (let index = 0; index < frameCount; index += 1) {
        if (options.preset === "breath") {
            const phase = frameCount <= 1 ? 1 : index / (frameCount - 1);
            const envelope = 0.2 + 0.8 * Math.sin(Math.PI * phase);
            frames.push(simpleWaveFrame(freqMs, level * envelope));
            continue;
        }
        if (options.preset === "ramp") {
            const phase = frameCount <= 1 ? 1 : (index + 1) / frameCount;
            frames.push(simpleWaveFrame(freqMs, level * phase));
            continue;
        }
        if (options.preset === "test") {
            const testLevels = [20, 35, 50, 35, 20];
            frames.push(simpleWaveFrame(100, Math.min(level, testLevels[index % testLevels.length] ?? 20)));
            continue;
        }
        frames.push(simpleWaveFrame(freqMs, level));
    }
    return frames;
}
export function normalizeCustomFrames(frames, maxFrames = MAX_PULSE_FRAMES_PER_SEND) {
    if (frames.length === 0) {
        throw new Error("customFrames cannot be empty");
    }
    const normalized = frames.slice(0, maxFrames).map((frame) => frame.trim().toUpperCase());
    const invalid = normalized.find((frame) => !isPulseFrameHex(frame));
    if (invalid) {
        throw new Error(`invalid pulse frame "${invalid}"; each frame must be 16 hex chars`);
    }
    return normalized;
}
