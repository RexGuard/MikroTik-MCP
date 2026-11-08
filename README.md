# MikroTik MCP Server: manage RouterOS routers with Claude and AI assistants

[![CI](https://github.com/RexGuard/MikroTik-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/RexGuard/MikroTik-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-5c4ee5)](https://modelcontextprotocol.io)
[![RouterOS](https://img.shields.io/badge/RouterOS-v6_%7C_v7-293239)](https://help.mikrotik.com/docs/display/ROS/RouterOS)

**MikroTik MCP** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects Claude, and any other MCP-compatible AI assistant, to **MikroTik RouterOS** routers and switches. In plain language you can check router status, list interfaces, routes, firewall rules, DHCP leases and Wi-Fi clients, read logs, ping and traceroute, block IP addresses, back up the configuration, and change any RouterOS setting.

**Quick facts**

- **What it is:** an MCP server (stdio) written in TypeScript for Node.js 20+, also packaged as a one-click Claude Desktop extension (`.mcpb`).
- **Works with:** Claude Desktop, Claude Code, Cursor, VS Code, Windsurf and any MCP client.
- **Supports:** RouterOS v7 through the REST API, and RouterOS v6 and v7 through the binary API (ports 8728/8729).
- **Hardware:** any MikroTik device running RouterOS, including hAP, hEX, RB, CCR, CRS, cAP, wAP and Cloud Hosted Router (CHR).
- **Safety:** read-only mode, per-device permissions, and confirmation hints on destructive tools.
- **No WinBox needed:** it uses MikroTik's documented APIs, which expose the same configuration as WinBox and the terminal.
- **License:** MIT.

It talks to the router over RouterOS's own documented interfaces:

| Transport | RouterOS | Port | Service to enable |
|-----------|----------|------|-------------------|
| `rest` (default) | v7.1+ | 443 (HTTPS) / 80 | `www-ssl` (or `www`) |
| `api` | v6 and v7 | 8728 / 8729 (TLS) | `api` / `api-ssl` |

Both expose the full configuration tree that WinBox and the terminal use, so every menu (`/ip/...`, `/interface/...`, `/routing/...`, `/queue/...`, ...) is reachable.

## Tools

**Generic (any menu path)**

| Tool | What it does |
|------|--------------|
| `mikrotik_print` | Read any menu, with filters and property selection |
| `mikrotik_add` | Add an item to any menu |
| `mikrotik_set` | Change an item (by `.id` or filter) or a singleton setting such as `/system/identity` |
| `mikrotik_remove` | Remove an item |
| `mikrotik_set_enabled` | Enable or disable an item |
| `mikrotik_run_command` | Run any command (`/system/script/run`, `/interface/monitor-traffic once=yes`, ...) |

**Curated**

| Tool | What it does |
|------|--------------|
| `mikrotik_list_devices` | Configured routers |
| `mikrotik_check_connection` | Test the connection and explain how to fix it if it fails |
| `mikrotik_system_overview` | Identity, version, board, CPU/RAM/disk, uptime, clock, health, packages |
| `mikrotik_interfaces` | Interfaces with state and counters |
| `mikrotik_ip_addresses` | IPv4/IPv6 addresses |
| `mikrotik_routes` | Routing table |
| `mikrotik_firewall_rules` | filter / nat / mangle / raw rules with counters |
| `mikrotik_dhcp_leases` | DHCP leases |
| `mikrotik_wireless_clients` | Wi-Fi registration table (wifi, wifiwave2, wireless, CAPsMAN) |
| `mikrotik_arp_table` | ARP entries and discovered neighbors |
| `mikrotik_export_config` | Configuration (or one section) as an `/export` script, secrets hidden by default |
| `mikrotik_files` | List router files or read a text file |
| `mikrotik_restore_backup` | Load a `.backup` and reboot (requires `confirm: true`) |
| `mikrotik_import_config` | Run an `.rsc` script file (requires `confirm: true`) |
| `mikrotik_move_rule` | Reorder a firewall rule |
| `mikrotik_baseline_firewall` | Plan, then apply, a default-config style firewall for a WAN interface |
| `mikrotik_wireguard_add_client` | Generate keys, add a WireGuard peer and return the client config |
| `mikrotik_dhcp_server_setup` | Pool, DHCP network and server in one step |
| `mikrotik_dns_resolve`, `mikrotik_dns_flush_cache` | Test DNS from the router, clear the cache |
| `mikrotik_logs` | Recent log entries, filterable by topic or text |
| `mikrotik_ping`, `mikrotik_traceroute` | Diagnostics from the router |
| `mikrotik_firewall_add_rule` | Add a firewall rule, optionally above an existing one |
| `mikrotik_address_list` | Add/remove addresses in firewall address lists (block/allow hosts) |
| `mikrotik_backup` | Save a `.backup` and `.rsc` export on the router |
| `mikrotik_reboot` | Reboot (requires `confirm: true`) |

Write tools carry MCP `readOnlyHint: false` / `destructiveHint` annotations so clients can ask before running them.

## Install

### Claude Desktop: one-click extension (recommended)

1. **Download** [`mikrotik-mcp.mcpb`](https://github.com/RexGuard/MikroTik-MCP/releases/latest/download/mikrotik-mcp.mcpb) from the [latest release](https://github.com/RexGuard/MikroTik-MCP/releases/latest).
2. **Double-click it** (or drag it onto Claude Desktop's **Settings → Extensions** page) and click **Install**.
3. **Fill in the form**: router address, port, user name and password. Then turn the extension on.

That's it. There is no Node.js to install, no `git clone`, and no JSON to edit: Claude Desktop runs the extension with its built-in Node.js and keeps the password in your system's credential store. Ask Claude **"Check the router connection"** to confirm it works; if it doesn't, the answer says what is wrong and how to fix it (see [Troubleshooting](#troubleshooting)).

| Setting | What to enter |
|---------|---------------|
| Router address | The router's IP or DNS name, e.g. `192.168.88.1`. You can also paste `192.168.88.1:8729` or `https://192.168.88.1`. |
| Port | `8728` (API, default), `8729` (API over TLS) or `443` (REST over HTTPS, RouterOS 7.1+). **Not** `8291`, which is WinBox. |
| User name / Password | A RouterOS user whose group has the `api` policy (plus `rest-api` for port 443). |
| Accept self-signed certificate | Leave on unless the router has a certificate your computer trusts. Only matters for 8729 and 443. |
| Read-only mode | Turn on to let Claude look but not change anything. |

The connector picks the protocol from the port, so you never choose between "API" and "REST" yourself.

### Claude Code

```bash
claude mcp add mikrotik \
  -e MIKROTIK_HOST=192.168.88.1 -e MIKROTIK_PORT=8728 \
  -e MIKROTIK_USERNAME=mcp -e MIKROTIK_PASSWORD=CHANGE-ME \
  -- npx -y github:RexGuard/MikroTik-MCP
```

This needs Node.js 20+ and git. On Windows, replace `-- npx` with `-- cmd /c npx`. Use `github:RexGuard/MikroTik-MCP`, not `npx mikrotik-mcp`: the `mikrotik-mcp` name on npm belongs to an unrelated project.

To test the connection from a terminal before adding it to Claude:

```bash
MIKROTIK_HOST=192.168.88.1 MIKROTIK_PORT=8728 MIKROTIK_USERNAME=mcp MIKROTIK_PASSWORD=CHANGE-ME \
  npx -y github:RexGuard/MikroTik-MCP --check
```

### Other MCP clients (Cursor, VS Code, Windsurf, manual Claude Desktop setup)

Use `npx` as the command, so there is no file path to get right (on Windows, if the client cannot start `npx`, use `"command": "cmd"` and put `"/c", "npx"` at the start of `args`):

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "npx",
      "args": ["-y", "github:RexGuard/MikroTik-MCP"],
      "env": {
        "MIKROTIK_HOST": "192.168.88.1",
        "MIKROTIK_PORT": "8728",
        "MIKROTIK_USERNAME": "mcp",
        "MIKROTIK_PASSWORD": "CHANGE-ME"
      }
    }
  }
}
```

### From source

```bash
git clone https://github.com/RexGuard/MikroTik-MCP.git
cd MikroTik-MCP
npm install            # also builds into dist/
npm run build:mcpb     # optional: builds build/mikrotik-mcp.mcpb
```

Then point your client at `node /full/path/to/MikroTik-MCP/dist/src/index.js`. On Windows, write the path in JSON with double backslashes (`C:\\Users\\you\\MikroTik-MCP\\dist\\src\\index.js`) or forward slashes.

## Prepare the router

The connector uses the RouterOS API service, which is separate from WinBox. Check it in the router terminal:

```routeros
/ip service print
```

The `api` line (port 8728) must not be disabled (`X`), and its `available-from` must be empty or include the address your computer connects from. Note that if you connect using a DNS name that points at your public IP, the router sees your public IP, not your LAN address.

```routeros
# turn the API on, allowing only your LAN (adjust to your network)
/ip service set api disabled=no available-from=192.168.88.0/24

# a dedicated user (use group=read for a read-only assistant)
/user group add name=mcp policy=read,write,api,rest-api,test,ping,reboot,policy,sensitive
/user add name=mcp group=mcp password=CHANGE-ME
```

Encrypted options, for anything outside a trusted LAN:

```routeros
# API over TLS (port 8729)
/certificate add name=api common-name=router
/certificate sign api
/ip service set api-ssl certificate=api disabled=no

# or the REST API over HTTPS (port 443, RouterOS 7.1+)
/ip service set www-ssl certificate=api disabled=no
```

Don't expose port 8728 to the internet: the plain API sends the password unencrypted. To reach a router remotely, use a VPN (WireGuard, Tailscale) and the router's private address.

## Troubleshooting

Every connection error comes with a plain-language cause and fix. You can also ask Claude to "check the router connection", or run the server with `--check` in a terminal. The common cases:

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Port 8291 is the WinBox port" | WinBox's port was entered | Use 8728 (or 8729 / 443) |
| "refused the connection" | The API service is off or on another port | `/ip service set api disabled=no`, check `/ip service print` |
| "accepted the connection and closed it straight away" | Your IP is not in the service's `available-from` | Add your address, or connect via the LAN/VPN address instead of a public DNS name |
| "No answer from ..." | Address unreachable from this computer, or a firewall drops it | `Test-NetConnection <ip> -Port 8728` (Windows) / `nc -vz <ip> 8728` |
| "rejected the user name or password" | Wrong credentials, or the group lacks the `api` policy | `/user print`, `/user group print` |
| "certificate is not trusted" | Self-signed certificate on 8729/443 | Turn on "Accept self-signed certificate" |

## Configure (environment variables)

The extension form fills these in for you. For other clients:

| Variable | Default | Meaning |
|----------|---------|---------|
| `MIKROTIK_HOST` | — | Router IP or hostname (also accepts `host:port`, `https://host`, `api-ssl://host`) |
| `MIKROTIK_PORT` | 443 | Port; also selects the protocol (8728 API, 8729 API-SSL, 443 HTTPS REST, 80 HTTP REST, any other port: API) |
| `MIKROTIK_USERNAME` | `admin` | User name |
| `MIKROTIK_PASSWORD` | empty | Password |
| `MIKROTIK_TRANSPORT` | `auto` | Force `rest` or `api` (only needed for unusual custom ports) |
| `MIKROTIK_TLS` | from the port | Force TLS on or off |
| `MIKROTIK_INSECURE` | `false` | Accept self-signed certificates |
| `MIKROTIK_READ_ONLY` | `false` | Block every write tool |
| `MIKROTIK_TIMEOUT_MS` | `30000` | Request timeout |

### Several routers

Point `MIKROTIK_CONFIG` at a JSON file (see [`examples/devices.example.json`](examples/devices.example.json)) or put the same array in `MIKROTIK_DEVICES`. Every tool then takes an optional `device` argument; the first device is the default. Each device can set `"readOnly": true`.

## What to ask

Once connected, ask things like:

- "What's the CPU load and uptime on my router?"
- "Which devices are on Wi-Fi right now?"
- "Block 203.0.113.5 for one day."
- "Show me the NAT rules and explain what each one does."
- "Make a backup before we change anything."

## Safety

- Start with `MIKROTIK_READ_ONLY=true` until you trust the setup.
- Use a dedicated RouterOS user with only the policies you need.
- Firewall, bridge and address changes can lock you out. Consider [Safe Mode](https://help.mikrotik.com/docs/display/ROS/Configuration+Management#ConfigurationManagement-SafeMode) or run `mikrotik_backup` first.
- Set `MIKROTIK_HIDE_SENSITIVE=true` to replace passwords, Wi-Fi passphrases, WireGuard/IPsec keys and similar secrets with `***` in every tool result, so they never reach the AI model. (This also hides the private key in `mikrotik_wireguard_add_client` output.)
- The plain binary API (8728) sends the password unencrypted; prefer REST over HTTPS or API-SSL (8729) outside a trusted LAN.

## Development

```bash
npm test     # builds and runs the test suite against an in-memory mock RouterOS (REST and binary API)
```

## Why not reverse engineer WinBox?

WinBox, the mobile app and the web UI all drive the same RouterOS configuration tree that the REST API and the binary API expose, and those APIs are documented and stable across versions. Using them gives the same feature coverage without depending on undocumented, encrypted WinBox protocol details that can change between releases.

## FAQ

### How do I connect Claude to a MikroTik router?

Download `mikrotik-mcp.mcpb` from the [latest release](https://github.com/RexGuard/MikroTik-MCP/releases/latest), double-click it, and enter the router's address, port (8728), user name and password. Make sure the router's `api` service is on (see [Prepare the router](#prepare-the-router)). Claude can then query and configure the router in plain language.

### Can I use the WinBox port (8291)?

No. WinBox uses its own private protocol. The connector uses MikroTik's documented API on 8728 (or 8729 with TLS, or the REST API on 443), which gives the same control. WinBox keeps working on 8291 alongside it.

### Does it work with RouterOS 6?

Yes. Use port 8728 (or 8729 for TLS); the connector then uses the binary API, which works on RouterOS v6 and v7. The REST API transport needs RouterOS v7.1 or newer.

### Does it work with ChatGPT, Cursor or other AI tools?

It works with any client that supports the Model Context Protocol, including Claude Desktop, Claude Code, Cursor, VS Code (GitHub Copilot agent mode) and Windsurf. Use the `npx` configuration shown under [Other MCP clients](#other-mcp-clients-cursor-vs-code-windsurf-manual-claude-desktop-setup).

### Can it run on the MikroTik router itself?

Not from the RouterOS console. It runs on your computer (or any machine that can reach the router) and connects to the router over the network. Running it inside a RouterOS 7 container is possible on ARM, ARM64 and x86 models but is not packaged yet.

### Is it safe to let an AI change my router configuration?

Use a dedicated RouterOS user with limited policies, start with `MIKROTIK_READ_ONLY=true`, and make a backup with `mikrotik_backup` before changes. Write and destructive tools are marked so MCP clients can ask for confirmation, and `mikrotik_reboot` requires an explicit `confirm: true`.

### Can it manage more than one router?

Yes. List several devices in `MIKROTIK_CONFIG` or `MIKROTIK_DEVICES` and pass `device` to any tool. Each device can be read-only or read-write.

### What can I ask it?

Examples: "Why is my internet slow?", "Which devices are using the most bandwidth?", "Show the firewall rules and find anything risky", "Block this IP for a day", "Add a port forward for 8080 to 192.168.88.10", "Which Wi-Fi clients have a weak signal?", "Back up the config".

## Related

- [MikroTik RouterOS REST API documentation](https://help.mikrotik.com/docs/display/ROS/REST+API)
- [MikroTik RouterOS API documentation](https://help.mikrotik.com/docs/display/ROS/API)
- [Model Context Protocol](https://modelcontextprotocol.io)

## Acknowledgements

Several tools (config export, backup restore and import, rule moving, baseline firewall, WireGuard client configs, DNS tests and secret hiding) were inspired by [wiresage/mikrotik-mcp](https://github.com/wiresage/mikrotik-mcp) by Jeff Nasseri and contributors, MIT License. They were reimplemented here for the REST and binary APIs; `src/redact.ts` adapts its list of sensitive key names.

## License

MIT. MikroTik and RouterOS are trademarks of MikroTik SIA. This project is not affiliated with or endorsed by MikroTik.
