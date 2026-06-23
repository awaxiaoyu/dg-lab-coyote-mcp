export const MAX_MESSAGE_LENGTH = 1950;
export const MAX_PULSE_FRAMES_PER_SEND = 70;
export const FRAME_DURATION_MS = 100;

export type DgChannel = "A" | "B";
export type DgChannelSelector = DgChannel | "both";
export type ProtocolChannel = "1" | "2";
export type StrengthMode = "0" | "1" | "2";

export enum DgWsType {
  Heartbeat = "heartbeat",
  Bind = "bind",
  Msg = "msg",
  Break = "break",
  Error = "error"
}

export interface DgWsMessage {
  type: DgWsType;
  clientId: string;
  targetId?: string;
  message: string;
}

export interface StrengthFeedback {
  strengthA: number;
  strengthB: number;
  limitA: number;
  limitB: number;
  receivedAt: string;
}

export interface WavePoint {
  freqMs: number;
  level: number;
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function toProtocolChannel(channel: DgChannel): ProtocolChannel {
  return channel === "A" ? "1" : "2";
}

export function strengthCommand(channel: DgChannel, mode: StrengthMode, value: number): string {
  return `strength-${toProtocolChannel(channel)}+${mode}+${clampInt(value, 0, 200)}`;
}

export function clearQueueCommand(channel: DgChannel): string {
  return `clear-${toProtocolChannel(channel)}`;
}

export function pulseCommand(channel: DgChannel, frames: string[]): string {
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
export function compressFrequency(freqMs: number): number {
  const value = clampInt(freqMs, 10, 1000);
  if (value <= 100) return value;
  if (value <= 600) return Math.round((value - 100) / 5 + 100);
  return Math.round((value - 600) / 10 + 200);
}

export function waveFrameHex(points: [WavePoint, WavePoint, WavePoint, WavePoint]): string {
  const freqHex = points
    .map((point) => compressFrequency(point.freqMs).toString(16).padStart(2, "0"))
    .join("");
  const levelHex = points
    .map((point) => clampInt(point.level, 0, 100).toString(16).padStart(2, "0"))
    .join("");
  return `${freqHex}${levelHex}`.toUpperCase();
}

export function simpleWaveFrame(freqMs: number, level: number): string {
  const point = { freqMs, level };
  return waveFrameHex([point, point, point, point]);
}

export function isPulseFrameHex(value: string): boolean {
  return /^[0-9A-Fa-f]{16}$/.test(value);
}
