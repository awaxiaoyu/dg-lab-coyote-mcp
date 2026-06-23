# DG-Lab Coyote MCP

本项目是一个本地 stdio MCP server，让 AI client 通过 DG-Lab 官方 WebSocket Socket API 控制 Coyote V3。它默认只开放本机 MCP，不提供 remote HTTP MCP。

## 功能

- `dg_pairing`: 启动 WebSocket bridge，返回 DG-Lab App 可扫的 pairing URL 和 SVG QR。
- `dg_status`: 查看 socket/bind/arm/strength/cap 状态。
- `dg_arm`: 短时间解锁非零输出，支持 `DG_LAB_ARM_TOKEN`。
- `dg_set_strength`: 对 A/B/both 执行 set/increase/decrease/zero。
- `dg_pulse`: 发送 V3 waveform frames，内置 `test`、`constant`、`breath`、`ramp`。
- `dg_clear_pulse`: 清空 A/B/both waveform queue。
- `dg_emergency_stop`: disarm、clear queue、双通道归零。
- `dg_shutdown`: emergency stop 后关闭 WebSocket bridge。

所有非零输出都必须先 `dg_arm`，且会被以下上限同时限制：MCP hard cap、`dg_arm` session cap、DG-Lab App/device 上报 cap。归零和 clear/emergency stop 不需要 arm。

## 安装

```powershell
npm install
npm run build
```

## MCP 配置示例

把 `args` 改成你机器上的绝对路径：

```json
{
  "mcpServers": {
    "dg-lab-coyote": {
      "command": "node",
      "args": [
        "C:\\Users\\13112\\Documents\\Codex\\2026-06-23\\ban-2\\outputs\\dg-lab-coyote-mcp\\dist\\index.js"
      ],
      "env": {
        "DG_LAB_WS_HOST": "0.0.0.0",
        "DG_LAB_WS_PORT": "18888",
        "DG_LAB_MAX_STRENGTH_A": "30",
        "DG_LAB_MAX_STRENGTH_B": "30",
        "DG_LAB_MAX_PULSE_DURATION_MS": "7000",
        "DG_LAB_MAX_ARM_TTL_MS": "600000",
        "DG_LAB_MIN_COMMAND_GAP_MS": "350",
        "DG_LAB_ARM_TOKEN": "change-this-token"
      }
    }
  }
}
```

如果手机和电脑在同一 LAN，通常不用手动设置 `DG_LAB_PUBLIC_WS_URL`，MCP 会自动探测 LAN IPv4。探测不准时设置：

```json
"DG_LAB_PUBLIC_WS_URL": "ws://192.168.1.100:18888"
```

Windows 防火墙需要允许 TCP `18888` 入站；手机必须能访问这个 `ws://host:port`。

## 使用流程

1. 在 AI client 里调用 `dg_pairing`，拿到 `pairingUrl` 或 `qrSvg`。
2. 用 DG-Lab App 扫码绑定。
3. 调用 `dg_status`，确认 `activeBinding` 不为空。
4. 调用 `dg_arm`，传短 TTL 和较低 session cap，例如：

```json
{
  "ttlMs": 60000,
  "maxStrengthA": 20,
  "maxStrengthB": 20,
  "armToken": "change-this-token",
  "reason": "manual test"
}
```

5. 先小幅设置强度，再发测试 waveform：

```json
{
  "channel": "A",
  "mode": "set",
  "value": 5
}
```

```json
{
  "channel": "A",
  "preset": "test",
  "durationMs": 500,
  "level": 20,
  "freqMs": 100
}
```

6. 结束或异常时调用 `dg_emergency_stop`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DG_LAB_WS_HOST` | `0.0.0.0` | WebSocket listen host |
| `DG_LAB_WS_PORT` | `18888` | WebSocket listen port |
| `DG_LAB_PUBLIC_WS_URL` | 自动 LAN IP | App 能访问的 `ws://host:port` |
| `DG_LAB_MAX_STRENGTH_A` | `30` | A 通道 MCP hard cap |
| `DG_LAB_MAX_STRENGTH_B` | `30` | B 通道 MCP hard cap |
| `DG_LAB_MAX_PULSE_DURATION_MS` | `7000` | 单次 waveform 最大持续时间 |
| `DG_LAB_MAX_ARM_TTL_MS` | `600000` | 单次 arm 最大 TTL |
| `DG_LAB_MIN_COMMAND_GAP_MS` | `350` | 命令最小间隔 |
| `DG_LAB_ARM_TOKEN` | 未设置 | 设置后 `dg_arm` 必须传同值 |

## 协议维护

当前实现按 DG-Lab Coyote V3 Socket API：

- QR 格式：`https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://host:port/control-id`
- 强度命令：`strength-<1|2>+<0|1|2>+<value>`
- 清队列：`clear-<1|2>`
- 波形：`pulse-<A|B>:[hexFrame...]`
- 每个 hex frame 是 8 bytes / 16 hex chars，代表 100ms，前 4 bytes 是 compressed frequency，后 4 bytes 是 waveform level。

DG-Lab 如果更新非 V3 协议，优先检查 `src/dglab/protocol.ts` 里的 command builder、`compressFrequency()` 和 frame 长度，再检查 `src/dglab/socket-server.ts` 的 bind/heartbeat 逻辑。

## 参考

- DG-Lab official Socket API: <https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE/blob/main/socket/README.md>
- DG-Lab Coyote V3 waveform notes: <https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE/blob/main/coyote/extra/README.md>
- Model Context Protocol TypeScript SDK: <https://github.com/modelcontextprotocol/typescript-sdk>
