import os from "node:os";
import QRCode from "qrcode";
const DG_LAB_URL_BASE = "https://www.dungeon-lab.com/app-download.php";
const DG_LAB_SOCKET_TAG = "DGLAB-SOCKET";
export function buildPairingUrl(publicWsUrl, controlId) {
    const wsUrl = `${publicWsUrl.replace(/\/$/, "")}/${controlId}`;
    return [DG_LAB_URL_BASE, DG_LAB_SOCKET_TAG, wsUrl].join("#");
}
export async function buildPairingQrSvg(pairingUrl) {
    return QRCode.toString(pairingUrl, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
        width: 320
    });
}
export function detectLanIPv4() {
    const candidates = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === "IPv4" && !entry.internal) {
                candidates.push(entry.address);
            }
        }
    }
    const privateCandidate = candidates.find((address) => address.startsWith("192.168.") ||
        address.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(address));
    return privateCandidate ?? candidates[0] ?? "127.0.0.1";
}
