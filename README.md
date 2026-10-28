# mikrotik-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) manage **MikroTik RouterOS** devices: read status, inspect interfaces, routes, firewall, DHCP and Wi-Fi clients, run diagnostics, and change configuration.

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

## License

MIT
