export const MAX_MESSAGE_LENGTH = 1950;
export const MAX_PULSE_FRAMES_PER_SEND = 70;
export const FRAME_DURATION_MS = 100;
export var DgWsType;
(function (DgWsType) {
    DgWsType["Heartbeat"] = "heartbeat";
    DgWsType["Bind"] = "bind";
    DgWsType["Msg"] = "msg";
    DgWsType["Break"] = "break";
    DgWsType["Error"] = "error";
})(DgWsType || (DgWsType = {}));
export function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.max(min, Math.min(max, Math.round(value)));
}
export function toProtocolChannel(channel) {
    return channel === "A" ? "1" : "2";
}
export function strengthCommand(channel, mode, value) {
    return `strength-${toProtocolChannel(channel)}+${mode}+${clampInt(value, 0, 200)}`;
}
export function clearQueueCommand(channel) {
    return `clear-${toProtocolChannel(channel)}`;
}
export function pulseCommand(channel, frames) {
    const capped = frames.slice(0, MAX_PULSE_FRAMES_PER_SEND);
    let payload = JSON.stringify(capped);
    let command = `pulse-${channel}:${payload}`;
    while (command.length > MAX_MESSAGE_LENGTH && capped.length > 1) {
        capped.pop();
        payload = JSON.stringify(capped);
        command = `pulse-${channel}:${payload}`;
    }
    if (command.length > MAX_MESSAGE_LENGTH) {
        throw new Error(`pulse command still exceeds ${MAX_MESSAGE_LENGTH} chars after truncation`);
    }
    return command;
}
// Protocol maintenance note: DG-Lab Coyote V3 compresses user-facing 10-1000 ms
// frequency values to protocol bytes 10-240. Re-check this function when DG-Lab
// changes the Coyote waveform spec or releases a non-V3 transport.
export function compressFrequency(freqMs) {
    const value = clampInt(freqMs, 10, 1000);
    if (value <= 100)
        return value;
    if (value <= 600)
        return Math.round((value - 100) / 5 + 100);
    return Math.round((value - 600) / 10 + 200);
}
export function waveFrameHex(points) {
    const freqHex = points
        .map((point) => compressFrequency(point.freqMs).toString(16).padStart(2, "0"))
        .join("");
    const levelHex = points
        .map((point) => clampInt(point.level, 0, 100).toString(16).padStart(2, "0"))
        .join("");
    return `${freqHex}${levelHex}`.toUpperCase();
}
export function simpleWaveFrame(freqMs, level) {
    const point = { freqMs, level };
    return waveFrameHex([point, point, point, point]);
}
export function isPulseFrameHex(value) {
    return /^[0-9A-Fa-f]{16}$/.test(value);
}
