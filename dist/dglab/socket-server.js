import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { DgWsType, MAX_MESSAGE_LENGTH } from "./protocol.js";
export class DgLabSocketServer extends EventEmitter {
    options;
    wss = null;
    heartbeatTimer = null;
    clients = new Map();
    controlIds = new Set();
    activeBinding = null;
    lastStrengthFeedback = null;
    constructor(options) {
        super();
        this.options = options;
    }
    get host() {
        return this.options.host;
    }
    get port() {
        return this.options.port;
    }
    get isListening() {
        return this.wss !== null;
    }
    async start() {
        if (this.wss)
            return;
        this.wss = new WebSocketServer({
            host: this.options.host,
            port: this.options.port
        });
        this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
        await new Promise((resolve, reject) => {
            const onListening = () => {
                cleanup();
                resolve();
            };
            const onError = (error) => {
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
    generateControlId() {
        const controlId = `control-${randomUUID()}`;
        this.controlIds.add(controlId);
        return controlId;
    }
    status() {
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
    sendCommand(command) {
        if (!this.activeBinding) {
            throw new Error("DG-Lab App is not bound yet; run dg_pairing and scan the QR first");
        }
        const ws = this.clients.get(this.activeBinding.appId);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error("bound DG-Lab App socket is not open");
        }
        const msg = {
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
    async stop() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const ws of this.clients.values()) {
            try {
                ws.close();
            }
            catch {
                // best effort shutdown
            }
        }
        this.clients.clear();
        this.controlIds.clear();
        this.activeBinding = null;
        this.lastStrengthFeedback = null;
        await new Promise((resolve) => {
            if (!this.wss) {
                resolve();
                return;
            }
            const wss = this.wss;
            this.wss = null;
            wss.close(() => resolve());
        });
    }
    handleConnection(ws, req) {
        const pathId = (req.url ?? "").replace(/^\//, "").split("?")[0] ?? "";
        const requestedControlId = this.controlIds.has(pathId) ? pathId : null;
        const appId = randomUUID();
        this.clients.set(appId, ws);
        const bindPrompt = {
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
            const success = {
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
    handleMessage(jsonData, senderAppId) {
        const parsed = safeParseMessage(jsonData);
        if (!parsed)
            return;
        if (parsed.type === DgWsType.Heartbeat)
            return;
        if (parsed.type === DgWsType.Bind && parsed.message === "DGLAB" && parsed.clientId && parsed.targetId) {
            if (!this.controlIds.has(parsed.clientId))
                return;
            if (!this.clients.has(parsed.targetId))
                return;
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
            }));
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
    handleDisconnect(appId) {
        this.clients.delete(appId);
        if (this.activeBinding?.appId === appId) {
            const oldBinding = this.activeBinding;
            this.activeBinding = null;
            this.emit("disconnect", oldBinding);
        }
    }
    sendHeartbeat() {
        for (const [clientId, ws] of this.clients.entries()) {
            if (ws.readyState !== WebSocket.OPEN)
                continue;
            const heartbeat = {
                type: DgWsType.Heartbeat,
                clientId,
                targetId: "",
                message: "heartbeat"
            };
            ws.send(JSON.stringify(heartbeat));
        }
    }
}
function safeParseMessage(jsonData) {
    try {
        return JSON.parse(jsonData);
    }
    catch {
        return null;
    }
}
