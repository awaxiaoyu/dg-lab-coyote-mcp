import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  DgWsMessage,
  DgWsType,
  MAX_MESSAGE_LENGTH,
  StrengthFeedback
} from "./protocol.js";

export interface SocketServerOptions {
  host: string;
  port: number;
}

export interface ActiveBinding {
  controlId: string;
  appId: string;
  boundAt: string;
}

export interface SocketServerStatus {
  listening: boolean;
  host: string;
  port: number;
  clients: number;
  authorizedControlIds: number;
  activeBinding: ActiveBinding | null;
  lastStrengthFeedback: StrengthFeedback | null;
}

export class DgLabSocketServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly clients = new Map<string, WebSocket>();
  private readonly controlIds = new Set<string>();
  private activeBinding: ActiveBinding | null = null;
  private lastStrengthFeedback: StrengthFeedback | null = null;

  constructor(private readonly options: SocketServerOptions) {
    super();
  }

  get host(): string {
    return this.options.host;
  }

  get port(): number {
    return this.options.port;
  }

  get isListening(): boolean {
    return this.wss !== null;
  }

  async start(): Promise<void> {
    if (this.wss) return;

    this.wss = new WebSocketServer({
      host: this.options.host,
      port: this.options.port
    });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));

    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        this.wss = null;
        reject(error);
      };
      const cleanup = () => {
        this.wss?.off("listening", onListening);
        this.wss?.off("error", onError);
      };
      this.wss?.once("listening", onListening);
      this.wss?.once("error", onError);
    });

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 20_000);
    this.heartbeatTimer.unref();
  }

  generateControlId(): string {
    const controlId = `control-${randomUUID()}`;
    this.controlIds.add(controlId);
    return controlId;
  }

  status(): SocketServerStatus {
    return {
      listening: this.isListening,
      host: this.options.host,
      port: this.options.port,
      clients: this.clients.size,
      authorizedControlIds: this.controlIds.size,
      activeBinding: this.activeBinding,
      lastStrengthFeedback: this.lastStrengthFeedback
    };
  }

  sendCommand(command: string): number {
    if (!this.activeBinding) {
      throw new Error("DG-Lab App is not bound yet; run dg_pairing and scan the QR first");
    }

    const ws = this.clients.get(this.activeBinding.appId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("bound DG-Lab App socket is not open");
    }

    const msg: DgWsMessage = {
      type: DgWsType.Msg,
      clientId: this.activeBinding.controlId,
      targetId: this.activeBinding.appId,
      message: command
    };
    const json = JSON.stringify(msg);
    if (json.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`DG-Lab JSON message exceeds ${MAX_MESSAGE_LENGTH} chars`);
    }

    ws.send(json);
    return 1;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const ws of this.clients.values()) {
      try {
        ws.close();
      } catch {
        // best effort shutdown
      }
    }
    this.clients.clear();
    this.controlIds.clear();
    this.activeBinding = null;
    this.lastStrengthFeedback = null;

    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      const wss = this.wss;
      this.wss = null;
      wss.close(() => resolve());
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const pathId = (req.url ?? "").replace(/^\//, "").split("?")[0] ?? "";
    const requestedControlId = this.controlIds.has(pathId) ? pathId : null;
    const appId = randomUUID();
    this.clients.set(appId, ws);

    const bindPrompt: DgWsMessage = {
      type: DgWsType.Bind,
      clientId: appId,
      targetId: "",
      message: "targetId"
    };
    ws.send(JSON.stringify(bindPrompt));

    if (requestedControlId) {
      this.activeBinding = {
        controlId: requestedControlId,
        appId,
        boundAt: new Date().toISOString()
      };
      const success: DgWsMessage = {
        type: DgWsType.Bind,
        clientId: requestedControlId,
        targetId: appId,
        message: "200"
      };
      ws.send(JSON.stringify(success));
      this.emit("bind", this.activeBinding);
    }

    ws.on("message", (data) => this.handleMessage(data.toString(), appId));
    ws.on("close", () => this.handleDisconnect(appId));
  }

  private handleMessage(jsonData: string, senderAppId: string): void {
    const parsed = safeParseMessage(jsonData);
    if (!parsed) return;
    if (parsed.type === DgWsType.Heartbeat) return;

    if (parsed.type === DgWsType.Bind && parsed.message === "DGLAB" && parsed.clientId && parsed.targetId) {
      if (!this.controlIds.has(parsed.clientId)) return;
      if (!this.clients.has(parsed.targetId)) return;
      this.activeBinding = {
        controlId: parsed.clientId,
        appId: parsed.targetId,
        boundAt: new Date().toISOString()
      };
      this.clients.get(parsed.targetId)?.send(JSON.stringify({
        type: DgWsType.Bind,
        clientId: parsed.clientId,
        targetId: parsed.targetId,
        message: "200"
      } satisfies DgWsMessage));
      this.emit("bind", this.activeBinding);
      return;
    }

    if (parsed.type === DgWsType.Msg) {
      const strengthMatch = parsed.message.match(/^strength-(\d+)\+(\d+)\+(\d+)\+(\d+)$/);
      if (strengthMatch) {
        this.lastStrengthFeedback = {
          strengthA: Number(strengthMatch[1]),
          strengthB: Number(strengthMatch[2]),
          limitA: Number(strengthMatch[3]),
          limitB: Number(strengthMatch[4]),
          receivedAt: new Date().toISOString()
        };
        this.emit("strength-feedback", this.lastStrengthFeedback);
      }

      const feedbackMatch = parsed.message.match(/^feedback-(\d)$/);
      if (feedbackMatch) {
        this.emit("feedback", {
          index: Number(feedbackMatch[1]),
          appId: senderAppId,
          receivedAt: new Date().toISOString()
        });
      }
    }
  }

  private handleDisconnect(appId: string): void {
    this.clients.delete(appId);
    if (this.activeBinding?.appId === appId) {
      const oldBinding = this.activeBinding;
      this.activeBinding = null;
      this.emit("disconnect", oldBinding);
    }
  }

  private sendHeartbeat(): void {
    for (const [clientId, ws] of this.clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const heartbeat: DgWsMessage = {
        type: DgWsType.Heartbeat,
        clientId,
        targetId: "",
        message: "heartbeat"
      };
      ws.send(JSON.stringify(heartbeat));
    }
  }
}

function safeParseMessage(jsonData: string): DgWsMessage | null {
  try {
    return JSON.parse(jsonData) as DgWsMessage;
  } catch {
    return null;
  }
}
