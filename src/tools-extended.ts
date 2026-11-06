/**
 * Higher-level tools for jobs that take several RouterOS commands: reading a config export back as text,
 * restoring backups, onboarding WireGuard clients, setting up a DHCP server or a baseline firewall, ...
 *
 * Several of these were inspired by the tool set of wiresage/mikrotik-mcp
 * (https://github.com/wiresage/mikrotik-mcp, Copyright (c) 2024 Jeff Nasseri, MIT License),
 * reimplemented for this server's REST/binary API clients.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { z } from "zod";
import type { DeviceConfig } from "./config.js";
import { assertCommand, RosClient, RosError, RosRecord } from "./clients/types.js";
import { assertWritable, resolveId, rowsResult, toQuery, tryRun, valueSchema } from "./tools.js";

type Value = string | number | boolean;

/** The `tool()` helper from registerTools: registers a tool with the shared device argument and error handling. */
export type RegisterTool = <S extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: S; write?: boolean; destructive?: boolean },
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>, device: DeviceConfig, client: RosClient) => Promise<unknown>,
) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- IPv4 helpers ------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipToInt(ip: string): number {
  const m = IPV4_RE.exec(ip);
  if (!m || m.slice(1).some((o) => Number(o) > 255)) throw new RosError(`Invalid IPv4 address "${ip}"`);
  return m.slice(1).reduce((acc, o) => acc * 256 + Number(o), 0);
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
}

/** Parse "10.0.0.1/24" into the network, broadcast and host addresses. */
export function parseCidr(cidr: string): { ip: number; prefix: number; network: number; broadcast: number } {
  const [addr, len = "32"] = cidr.trim().split("/");
  const prefix = Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new RosError(`Invalid prefix in "${cidr}"`);
  const ip = ipToInt(addr);
  const size = 2 ** (32 - prefix);
  const network = Math.floor(ip / size) * size;
  return { ip, prefix, network, broadcast: network + size - 1 };
}

// ---- WireGuard keys -------------------------------------------------------------

/** Generate a WireGuard (Curve25519) key pair, base64 encoded like `wg genkey | wg pubkey`. */
export function wireguardKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const raw = (der: Buffer) => der.subarray(der.length - 32).toString("base64");
  return {
    privateKey: raw(privateKey.export({ type: "pkcs8", format: "der" })),
    publicKey: raw(publicKey.export({ type: "spki", format: "der" })),
  };
}

// ---- Firewall baseline ----------------------------------------------------------

export interface PlannedRule {
  table: "filter" | "nat";
  args: Record<string, string>;
}

const BASELINE_TAG = "mcp-baseline";

export function baselineFirewall(opts: {
  wanInterface: string;
  allowFrom?: string[];
  allowTcpPorts?: number[];
  allowUdpPorts?: number[];
  masquerade?: boolean;
}): PlannedRule[] {
  const f = (args: Record<string, string>): PlannedRule => ({ table: "filter", args });
  const tag = (s: string) => `${BASELINE_TAG}: ${s}`;
  const wan = opts.wanInterface;
  const rules: PlannedRule[] = [
    f({ chain: "input", action: "accept", "connection-state": "established,related,untracked", comment: tag("accept established, related, untracked") }),
    f({ chain: "input", action: "drop", "connection-state": "invalid", comment: tag("drop invalid") }),
    f({ chain: "input", action: "accept", protocol: "icmp", comment: tag("accept ICMP") }),
  ];
  for (const src of opts.allowFrom ?? []) {
    rules.push(f({ chain: "input", action: "accept", "src-address": src, comment: tag(`accept management from ${src}`) }));
  }
  if (opts.allowTcpPorts?.length) {
    const ports = opts.allowTcpPorts.join(",");
    rules.push(f({ chain: "input", action: "accept", protocol: "tcp", "dst-port": ports, comment: tag(`accept tcp ${ports}`) }));
  }
  if (opts.allowUdpPorts?.length) {
    const ports = opts.allowUdpPorts.join(",");
    rules.push(f({ chain: "input", action: "accept", protocol: "udp", "dst-port": ports, comment: tag(`accept udp ${ports}`) }));
  }
  rules.push(
    f({ chain: "input", action: "drop", "in-interface": wan, comment: tag(`drop everything else from ${wan}`) }),
    f({ chain: "forward", action: "accept", "connection-state": "established,related,untracked", comment: tag("accept established, related, untracked") }),
    f({ chain: "forward", action: "drop", "connection-state": "invalid", comment: tag("drop invalid") }),
    f({
      chain: "forward",
      action: "drop",
      "in-interface": wan,
      "connection-state": "new",
      "connection-nat-state": "!dstnat",
      comment: tag(`drop new connections from ${wan} that are not port-forwarded`),
    }),
  );
  if (opts.masquerade) {
    rules.push({ table: "nat", args: { chain: "srcnat", action: "masquerade", "out-interface": wan, comment: tag(`masquerade out ${wan}`) } });
  }
  return rules;
}

// ---------------------------------------------------------------------------------

export function registerExtendedTools(tool: RegisterTool): void {
  const firewallTable = z.enum(["filter", "nat", "mangle", "raw"]).default("filter");

  // ---- Configuration export, files, restore ------------------------------------

  tool(
    "mikrotik_export_config",
    {
      title: "Show configuration export",
      description:
        "Return the configuration as a RouterOS script (`/export`), for the whole router or one section such as /ip/firewall or /interface/bridge. " +
        "Good for reviewing or diffing the setup. Secrets are hidden unless showSensitive is true. " +
        "Works by exporting to a temporary file on the router, reading it and deleting it again.",
      inputSchema: {
        section: z.string().optional().describe('Menu path to export, e.g. "/ip/firewall" or "/interface/wireguard". Omit for the whole configuration.'),
        showSensitive: z.boolean().optional().describe("Include passwords and keys (RouterOS v7 `show-sensitive`)."),
        verbose: z.boolean().optional().describe("Include default values too."),
      },
    },
    async ({ section, showSensitive, verbose }, _d, client) => {
      const prefix = section && section.trim() !== "/" ? assertCommand(section) : "";
      const base = `mcp-export-${Date.now()}`;
      const args: Record<string, string> = { file: base };
      if (showSensitive) args["show-sensitive"] = "";
      if (verbose) args.verbose = "";
      await client.run(`${prefix}/export`, { args });

      // The router writes the file asynchronously; wait for it to appear with its contents.
      let file: RosRecord | undefined;
      for (let i = 0; i < 10 && !file?.contents; i++) {
        if (i) await sleep(300);
        file = (await client.run("/file/print", { query: [`name=${base}.rsc`] })).rows[0];
      }
      if (!file) throw new RosError("Export file did not appear on the router");
      const contents = file.contents ?? "";
      const size = Number(file.size ?? contents.length);
      if (!contents || contents.length < size) {
        return {
          section: prefix || "/",
          file: file.name,
          size,
          note:
            "The export is too large to read back through the API, so it was left on the router. Export a smaller section, " +
            "or download the file with WinBox/FTP and remove it afterwards.",
        };
      }
      await client.run("/file/remove", { args: { ".id": file[".id"] ?? file.name } }).catch(() => undefined);
      return contents;
    },
  );

  tool(
    "mikrotik_files",
    {
      title: "List or read router files",
      description:
        "List files on the router (backups, exports, scripts, certificates) or, with `name`, read one text file such as an .rsc export. " +
        "Delete files with mikrotik_remove on /file.",
      inputSchema: {
        name: z.string().optional().describe('Exact file name to read, e.g. "flash/mcp-backup.rsc".'),
        type: z.string().optional().describe('Only list files of this type, e.g. "backup", "script", "directory".'),
        limit: z.number().int().positive().max(5000).optional(),
      },
    },
    async ({ name, type, limit }, _d, client) => {
      if (name) {
        const [file] = (await client.run("/file/print", { query: [`name=${name}`] })).rows;
        if (!file) throw new RosError(`No file named "${name}"`);
        return file;
      }
      const { rows } = await client.run("/file/print", { query: toQuery(type ? { type } : undefined) });
      return rowsResult(rows.map(({ contents: _c, ...rest }) => rest), limit);
    },
  );

  tool(
    "mikrotik_restore_backup",
    {
      title: "Restore a backup",
      description:
        "Load a .backup file from the router's file system (`/system/backup/load`). This replaces the whole configuration and reboots the router. " +
        "List backups with mikrotik_files type=backup. Always confirm with the user first.",
      inputSchema: {
        name: z.string().describe('Backup file name, e.g. "mcp-backup-2026-11-06.backup".'),
        password: z.string().optional().describe("Password the backup was encrypted with."),
        confirm: z.literal(true).describe("Must be true to confirm the restore and reboot"),
      },
      write: true,
      destructive: true,
    },
    async ({ name, password }, device, client) => {
      const [file] = (await client.run("/file/print", { query: [`name=${name}`], proplist: [".id", "name"] })).rows;
      if (!file) throw new RosError(`No file named "${name}"`, "list backups with mikrotik_files type=backup");
      // RouterOS 7 requires the password argument even for unencrypted backups.
      await client.run("/system/backup/load", { args: { name, password: password ?? "" } }).catch((e) => {
        // The router drops the session as it reboots; only a reply from RouterOS is a real failure.
        if (e instanceof RosError && !/reach|timed out|closed|reset/i.test(e.message)) throw e;
      });
      return { restoring: name, device: device.name, note: "The router is rebooting with the restored configuration." };
    },
  );

  tool(
    "mikrotik_import_config",
    {
      title: "Run an .rsc script file",
      description:
        "Execute a RouterOS script file (.rsc) that is on the router (`/import`), e.g. an export from another router. " +
        "Commands run immediately and are not rolled back on error. Always confirm with the user first.",
      inputSchema: {
        name: z.string().describe('Script file name, e.g. "firewall.rsc".'),
        verbose: z.boolean().optional().describe("Report each line as it runs, to locate the line that fails."),
        confirm: z.literal(true).describe("Must be true to confirm"),
      },
      write: true,
      destructive: true,
    },
    async ({ name, verbose }, _d, client) => {
      const args: Record<string, string> = { "file-name": name };
      if (verbose) args.verbose = "yes";
      const res = await client.run("/import", { args });
      return { imported: name, ...(res.ret ? { ret: res.ret } : {}), ...(res.rows.length ? { output: res.rows } : {}) };
    },
  );

  // ---- Firewall ---------------------------------------------------------------

  tool(
    "mikrotik_move_rule",
    {
      title: "Reorder a firewall rule",
      description:
        "Move a firewall rule (filter, nat, mangle or raw) so it sits directly above another rule, or to the end of the table. " +
        "Order matters: the first matching rule wins.",
      inputSchema: {
        table: firewallTable,
        ipv6: z.boolean().optional(),
        id: z.string().optional().describe('The rule to move, e.g. "*1F".'),
        where: z.record(valueSchema).optional().describe('Or a filter matching exactly one rule, e.g. {"comment": "drop blocked"}.'),
        before: z.string().optional().describe("The .id of the rule it should be placed above. Omit to move it to the end."),
      },
      write: true,
    },
    async ({ table, ipv6, id, where, before }, _d, client) => {
      const p = `/${ipv6 ? "ipv6" : "ip"}/firewall/${table}`;
      const target = await resolveId(client, p, id, where as Record<string, Value> | undefined);
      const args: Record<string, string> = { numbers: target };
      if (before) args.destination = before;
      await client.run(`${p}/move`, { args });
      return { moved: target, before: before ?? "end" };
    },
  );

  tool(
    "mikrotik_baseline_firewall",
    {
      title: "Baseline firewall",
      description:
        "Plan or apply a baseline IPv4 firewall modeled on MikroTik's default configuration: accept established/related, drop invalid, accept ICMP, " +
        "accept the given management sources and ports, drop everything else arriving on the WAN interface, and protect the LAN from unsolicited WAN traffic. " +
        "Runs as a dry run by default and returns the rules; call again with apply=true after the user agrees. Rules are appended after existing ones " +
        `and tagged "${BASELINE_TAG}" in their comment.`,
      inputSchema: {
        wanInterface: z.string().describe('Internet-facing interface or PPPoE client, e.g. "ether1" or "pppoe-out1".'),
        allowFrom: z.array(z.string()).optional().describe('Extra sources allowed to reach the router from the WAN side, e.g. ["203.0.113.10"].'),
        allowTcpPorts: z.array(z.number().int().min(1).max(65535)).optional().describe("TCP ports to open on the router, e.g. [8291] for WinBox."),
        allowUdpPorts: z.array(z.number().int().min(1).max(65535)).optional().describe("UDP ports to open on the router, e.g. [51820] for WireGuard."),
        masquerade: z.boolean().optional().describe("Also add a srcnat masquerade rule on the WAN interface."),
        apply: z.boolean().default(false).describe("false = only show the plan; true = add the rules."),
      },
    },
    async ({ wanInterface, allowFrom, allowTcpPorts, allowUdpPorts, masquerade, apply }, device, client) => {
      const plan = baselineFirewall({ wanInterface, allowFrom, allowTcpPorts, allowUdpPorts, masquerade });
      const [interfaces, existing] = await Promise.all([
        client.run("/interface/print", { query: [`name=${wanInterface}`], proplist: ["name"] }).then((r) => r.rows),
        client.run("/ip/firewall/filter/print", { proplist: [".id", "chain", "action", "comment"] }).then((r) => r.rows),
      ]);
      if (interfaces.length === 0) throw new RosError(`No interface named "${wanInterface}"`);
      const already = existing.filter((r) => (r.comment ?? "").startsWith(BASELINE_TAG));
      const summary = plan.map((r) => ({ table: r.table, ...r.args }));
      if (!apply) {
        return {
          dryRun: true,
          existingFilterRules: existing.length,
          ...(already.length ? { warning: `${already.length} ${BASELINE_TAG} rules already exist; applying again would duplicate them.` } : {}),
          rules: summary,
        };
      }
      assertWritable(device);
      if (already.length) throw new RosError(`${already.length} ${BASELINE_TAG} rules already exist`, "remove them first or keep them");
      const added: string[] = [];
      for (const r of plan) {
        const res = await client.run(`/ip/firewall/${r.table}/add`, { args: r.args });
        if (res.ret) added.push(res.ret);
      }
      return { applied: true, added: added.length, ids: added, rules: summary };
    },
  );

  // ---- WireGuard --------------------------------------------------------------

  tool(
    "mikrotik_wireguard_add_client",
    {
      title: "Add a WireGuard client",
      description:
        "Onboard a WireGuard client (phone, laptop) on an existing WireGuard interface: generates a key pair, picks the next free tunnel address, " +
        "adds the peer on the router and returns a ready-to-import client config (wg0.conf / QR-code text). The private key is only in this reply.",
      inputSchema: {
        interface: z.string().describe('WireGuard interface on the router, e.g. "wireguard1".'),
        name: z.string().describe('Label for the peer, e.g. "erick-phone". Stored as the peer comment.'),
        endpoint: z.string().optional().describe('Public host[:port] clients connect to. Defaults to the configured router host and the interface listen-port.'),
        clientAddress: z.string().optional().describe('Tunnel address for the client, e.g. "10.7.0.5". Defaults to the next free one in the interface subnet.'),
        allowedIps: z.string().default("0.0.0.0/0").describe('Traffic the client sends through the tunnel, e.g. "0.0.0.0/0" (everything) or "192.168.18.0/24, 10.7.0.0/24".'),
        dns: z.string().optional().describe('DNS server for the client, e.g. the router\'s tunnel address.'),
        presharedKey: z.boolean().default(false).describe("Add a preshared key for extra post-quantum resistance."),
        keepalive: z.number().int().min(0).max(3600).default(25).describe("PersistentKeepalive seconds (0 = off)."),
      },
      write: true,
    },
    async ({ interface: iface, name, endpoint, clientAddress, allowedIps, dns, presharedKey, keepalive }, device, client) => {
      const [wg] = (await client.run("/interface/wireguard/print", { query: [`name=${iface}`] })).rows;
      if (!wg) throw new RosError(`No WireGuard interface named "${iface}"`);
      const serverKey = wg["public-key"];
      if (!serverKey) throw new RosError(`Could not read the public key of "${iface}"`);

      const [addresses, peers] = await Promise.all([
        client.run("/ip/address/print", { query: [`interface=${iface}`] }).then((r) => r.rows),
        client.run("/interface/wireguard/peers/print", { query: [`interface=${iface}`] }).then((r) => r.rows),
      ]);
      const subnet = addresses[0]?.address;
      let address = clientAddress?.split("/")[0];
      if (!address) {
        if (!subnet) throw new RosError(`"${iface}" has no IP address`, "pass clientAddress or add an address to the interface");
        const net = parseCidr(subnet);
        const used = new Set<number>([net.ip, ...addresses.map((a) => parseCidr(a.address).ip)]);
        for (const p of peers) {
          for (const a of (p["allowed-address"] ?? "").split(",")) {
            if (IPV4_RE.test(a.trim().split("/")[0])) used.add(ipToInt(a.trim().split("/")[0]));
          }
        }
        let next = net.network + 1;
        while (next < net.broadcast && used.has(next)) next++;
        if (next >= net.broadcast) throw new RosError(`No free address left in ${subnet}`);
        address = intToIp(next);
      }
      const prefix = subnet ? parseCidr(subnet).prefix : 32;

      const keys = wireguardKeyPair();
      const psk = presharedKey ? randomBytes(32).toString("base64") : undefined;
      const args: Record<string, string> = {
        interface: iface,
        "public-key": keys.publicKey,
        "allowed-address": `${address}/32`,
        comment: name,
      };
      if (psk) args["preshared-key"] = psk;
      const res = await client.run("/interface/wireguard/peers/add", { args });

      const host = endpoint ?? device.host;
      const port = wg["listen-port"] ?? "51820";
      const hasPort = /^[^:]+:\d+$/.test(host) || /^\[.+\]:\d+$/.test(host);
      const endpointWithPort = hasPort ? host : host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
      const config = [
        "[Interface]",
        `PrivateKey = ${keys.privateKey}`,
        `Address = ${address}/${prefix}`,
        ...(dns ? [`DNS = ${dns}`] : []),
        "",
        "[Peer]",
        `PublicKey = ${serverKey}`,
        ...(psk ? [`PresharedKey = ${psk}`] : []),
        `Endpoint = ${endpointWithPort}`,
        `AllowedIPs = ${allowedIps}`,
        ...(keepalive ? [`PersistentKeepalive = ${keepalive}`] : []),
        "",
      ].join("\n");
      return {
        peerId: res.ret,
        clientAddress: address,
        clientPublicKey: keys.publicKey,
        config,
        note: "Import `config` into the WireGuard app (or turn it into a QR code). Make sure the firewall accepts UDP " + port + " on the WAN.",
      };
    },
  );

  // ---- DHCP -------------------------------------------------------------------

  tool(
    "mikrotik_dhcp_server_setup",
    {
      title: "Set up a DHCP server",
      description:
        "Create a complete DHCP server on an interface in one step: address pool, DHCP network (gateway, DNS) and the server itself. " +
        "The interface should already have an IP address in the network.",
      inputSchema: {
        interface: z.string().describe('e.g. "bridge" or "vlan20".'),
        network: z.string().describe('Subnet to serve, e.g. "192.168.50.0/24".'),
        gateway: z.string().optional().describe("Default: the router's address on the interface, else the first host."),
        poolRange: z.string().optional().describe('Default: from .10 to the last usable address, e.g. "192.168.50.10-192.168.50.254".'),
        dns: z.string().optional().describe("DNS servers handed out, comma separated. Default: the gateway."),
        leaseTime: z.string().default("1d"),
        name: z.string().optional().describe('Server name. Default: "dhcp-<interface>".'),
      },
      write: true,
    },
    async ({ interface: iface, network, gateway, poolRange, dns, leaseTime, name }, _d, client) => {
      const net = parseCidr(network);
      if (net.prefix > 30) throw new RosError(`${network} is too small for a DHCP pool`);
      const cidr = `${intToIp(net.network)}/${net.prefix}`;
      const addresses = (await client.run("/ip/address/print", { query: [`interface=${iface}`] })).rows;
      const own = addresses.map((a) => parseCidr(a.address)).find((a) => a.network === net.network && a.prefix === net.prefix);
      const gw = gateway ?? (own ? intToIp(own.ip) : intToIp(net.network + 1));
      const start = Math.min(net.network + 10, net.broadcast - 1);
      const range = poolRange ?? `${intToIp(start === ipToInt(gw) ? start + 1 : start)}-${intToIp(net.broadcast - 1)}`;
      const serverName = name ?? `dhcp-${iface}`;
      const poolName = `${serverName}-pool`;

      const pool = await client.run("/ip/pool/add", { args: { name: poolName, ranges: range } });
      const dhcpNet = await client.run("/ip/dhcp-server/network/add", {
        args: { address: cidr, gateway: gw, "dns-server": dns ?? gw, comment: serverName },
      });
      const server = await client.run("/ip/dhcp-server/add", {
        args: { name: serverName, interface: iface, "address-pool": poolName, "lease-time": leaseTime, disabled: "no" },
      });
      return {
        server: serverName,
        pool: { name: poolName, ranges: range, id: pool.ret },
        network: { address: cidr, gateway: gw, dns: dns ?? gw, id: dhcpNet.ret },
        id: server.ret,
        ...(own ? {} : { warning: `${iface} has no address in ${cidr}; add ${gw}/${net.prefix} to it or clients will not get leases.` }),
      };
    },
  );

  // ---- DNS --------------------------------------------------------------------

  tool(
    "mikrotik_dns_resolve",
    {
      title: "Resolve a name from the router",
      description: "Resolve a host name using the router's DNS (or a given server) to test DNS from the router's point of view. RouterOS v7.",
      inputSchema: {
        name: z.string().regex(/^[A-Za-z0-9_.-]+$/).describe('e.g. "example.com"'),
        server: z.string().regex(/^[0-9A-Fa-f:.]+$/).optional().describe("DNS server to ask instead of the router's resolver."),
        ipv6: z.boolean().optional().describe("Resolve an AAAA record."),
      },
    },
    async ({ name, server, ipv6 }, _d, client) => {
      // Fixed script with validated inputs, so it is safe on read-only devices too.
      const script = `:put [:resolve domain-name="${name}"${server ? ` server=${server}` : ""}${ipv6 ? " type=ipv6" : ""}]`;
      const res = await client.run("/execute", { args: { script, "as-string": "" } });
      const address = (res.ret ?? res.rows[0]?.ret ?? "").trim();
      if (!address) throw new RosError(`Could not resolve ${name}`);
      return { name, address, server: server ?? "router" };
    },
  );

  tool(
    "mikrotik_dns_flush_cache",
    {
      title: "Flush the DNS cache",
      description: "Clear the router's DNS cache, e.g. after changing static DNS entries.",
      inputSchema: {},
      write: true,
    },
    async (_a, _d, client) => {
      const before = await tryRun(client, "/ip/dns/cache/print", { proplist: [".id"] });
      await client.run("/ip/dns/cache/flush");
      return { flushed: true, ...(before ? { entriesBefore: before.length } : {}) };
    },
  );
}
