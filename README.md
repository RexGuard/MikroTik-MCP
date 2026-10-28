# MikroTik MCP Server: manage RouterOS routers with Claude and AI assistants

[![CI](https://github.com/RexGuard/MikroTik-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/RexGuard/MikroTik-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-5c4ee5)](https://modelcontextprotocol.io)
[![RouterOS](https://img.shields.io/badge/RouterOS-v6_%7C_v7-293239)](https://help.mikrotik.com/docs/display/ROS/RouterOS)

**MikroTik MCP** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects Claude, and any other MCP-compatible AI assistant, to **MikroTik RouterOS** routers and switches. In plain language you can check router status, list interfaces, routes, firewall rules, DHCP leases and Wi-Fi clients, read logs, ping and traceroute, block IP addresses, back up the configuration, and change any RouterOS setting.

**Quick facts**

- **What it is:** an MCP server (stdio) written in TypeScript for Node.js 20+.
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
| `mikrotik_system_overview` | Identity, version, board, CPU/RAM/disk, uptime, clock, health, packages |
| `mikrotik_interfaces` | Interfaces with state and counters |
| `mikrotik_ip_addresses` | IPv4/IPv6 addresses |
| `mikrotik_routes` | Routing table |
| `mikrotik_firewall_rules` | filter / nat / mangle / raw rules with counters |
| `mikrotik_dhcp_leases` | DHCP leases |
| `mikrotik_wireless_clients` | Wi-Fi registration table (wifi, wifiwave2, wireless, CAPsMAN) |
| `mikrotik_arp_table` | ARP entries and discovered neighbors |
| `mikrotik_logs` | Recent log entries, filterable by topic or text |
| `mikrotik_ping`, `mikrotik_traceroute` | Diagnostics from the router |
| `mikrotik_firewall_add_rule` | Add a firewall rule, optionally above an existing one |
| `mikrotik_address_list` | Add/remove addresses in firewall address lists (block/allow hosts) |
| `mikrotik_backup` | Save a `.backup` and `.rsc` export on the router |
| `mikrotik_reboot` | Reboot (requires `confirm: true`) |

Write tools carry MCP `readOnlyHint: false` / `destructiveHint` annotations so clients can ask before running them.

## Install

Requires Node.js 20+.

```bash
git clone https://github.com/RexGuard/MikroTik-MCP.git
cd mikrotik-mcp
npm install        # also builds into dist/
```

## Prepare the router

Create a dedicated user rather than using `admin`. For a read-only assistant use the built-in `read` group; for changes use `full` (or a custom group).

```routeros
/user group add name=mcp policy=read,write,api,rest-api,test,ping,reboot,policy,sensitive
/user add name=mcp group=mcp password=CHANGE-ME

# RouterOS v7 REST API (HTTPS needs a certificate on www-ssl)
/certificate add name=self common-name=router
/certificate sign self
/ip service set www-ssl certificate=self disabled=no

# or the binary API (v6/v7)
/ip service set api disabled=no address=192.168.88.0/24
```

Restrict the service `address=` to the network the MCP server runs on.

## Configure

### One router (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `MIKROTIK_HOST` | — | Router IP or hostname |
| `MIKROTIK_USERNAME` | `admin` | User name |
| `MIKROTIK_PASSWORD` | empty | Password |
| `MIKROTIK_TRANSPORT` | `rest` | `rest` or `api` |
| `MIKROTIK_PORT` | 443 / 80 / 8728 / 8729 | Override the port |
| `MIKROTIK_TLS` | `true` for rest, `false` for api | Use HTTPS / API-SSL |
| `MIKROTIK_INSECURE` | `false` | Accept self-signed certificates |
| `MIKROTIK_READ_ONLY` | `false` | Block every write tool |
| `MIKROTIK_TIMEOUT_MS` | `30000` | Request timeout |

### Several routers

Point `MIKROTIK_CONFIG` at a JSON file (see [`examples/devices.example.json`](examples/devices.example.json)) or put the same array in `MIKROTIK_DEVICES`. Every tool then takes an optional `device` argument; the first device is the default. Each device can set `"readOnly": true`.

## Use with Claude

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mikrotik": {
      "command": "node",
      "args": ["/path/to/mikrotik-mcp/dist/src/index.js"],
      "env": {
        "MIKROTIK_HOST": "192.168.88.1",
        "MIKROTIK_USERNAME": "mcp",
        "MIKROTIK_PASSWORD": "CHANGE-ME",
        "MIKROTIK_INSECURE": "true"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add mikrotik \
  -e MIKROTIK_HOST=192.168.88.1 -e MIKROTIK_USERNAME=mcp -e MIKROTIK_PASSWORD=CHANGE-ME -e MIKROTIK_INSECURE=true \
  -- node /path/to/mikrotik-mcp/dist/src/index.js
```

Then ask things like:

- "What's the CPU load and uptime on my router?"
- "Which devices are on Wi-Fi right now?"
- "Block 203.0.113.5 for one day."
- "Show me the NAT rules and explain what each one does."
- "Make a backup before we change anything."

## Safety

- Start with `MIKROTIK_READ_ONLY=true` until you trust the setup.
- Use a dedicated RouterOS user with only the policies you need.
- Firewall, bridge and address changes can lock you out. Consider [Safe Mode](https://help.mikrotik.com/docs/display/ROS/Configuration+Management#ConfigurationManagement-SafeMode) or run `mikrotik_backup` first.
- The plain binary API (8728) sends the password unencrypted; prefer REST over HTTPS or API-SSL (8729) outside a trusted LAN.

## Development

```bash
npm test     # builds and runs the test suite against an in-memory mock RouterOS (REST and binary API)
```

## Why not reverse engineer WinBox?

WinBox, the mobile app and the web UI all drive the same RouterOS configuration tree that the REST API and the binary API expose, and those APIs are documented and stable across versions. Using them gives the same feature coverage without depending on undocumented, encrypted WinBox protocol details that can change between releases.

## FAQ

### How do I connect Claude to a MikroTik router?

Install this server, enable the REST API (`www-ssl`) or the API service on the router, and add the server to Claude Desktop or Claude Code with the router's address and a RouterOS user (see [Use with Claude](#use-with-claude)). Claude can then query and configure the router in plain language.

### Does it work with RouterOS 6?

Yes. Set `MIKROTIK_TRANSPORT=api` to use the binary API, which works on RouterOS v6 and v7. The REST API transport needs RouterOS v7.1 or newer.

### Does it work with ChatGPT, Cursor or other AI tools?

It works with any client that supports the Model Context Protocol, including Claude Desktop, Claude Code, Cursor, VS Code (GitHub Copilot agent mode) and Windsurf. Use the same `command`, `args` and `env` settings shown for Claude Desktop.

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

## License

MIT. MikroTik and RouterOS are trademarks of MikroTik SIA. This project is not affiliated with or endorsed by MikroTik.
