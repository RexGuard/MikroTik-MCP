import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DeviceRegistry, DeviceConfig } from "./config.js";
import { assertCommand, RosClient, RosError, RosRecord } from "./clients/types.js";

type Value = string | number | boolean;

// ---------------------------------------------------------------------------
// Shared schemas and helpers
// ---------------------------------------------------------------------------

const deviceArg = z
  .string()
  .optional()
  .describe("Name of the configured device. Defaults to the first device (see mikrotik_list_devices).");

const pathArg = z
  .string()
  .describe('RouterOS menu path, e.g. "/ip/address", "/interface/bridge/port" or "ip firewall filter".');

const valueSchema = z.union([z.string(), z.number(), z.boolean()]);

const propsArg = z
  .record(valueSchema)
  .describe('Item properties as in the CLI, e.g. {"address": "10.0.0.1/24", "interface": "ether2"}.');

const whereArg = z
  .record(valueSchema)
  .optional()
  .describe('Equality filters, e.g. {"type": "ether", "disabled": false}.');

const limitArg = z.number().int().positive().max(5000).optional().describe("Maximum rows to return (default 200).");

const DEFAULT_LIMIT = 200;

/** Commands that only read state and are allowed on read-only devices. */
const READ_ONLY_VERBS = new Set(["print", "getall", "get", "monitor", "monitor-traffic", "ping", "traceroute", "export"]);

function toArg(v: Value): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

function toArgs(props: Record<string, Value> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(props ?? {}).map(([k, v]) => [k, toArg(v)]));
}

function toQuery(where: Record<string, Value> | undefined): string[] {
  return Object.entries(where ?? {}).map(([k, v]) => `${k}=${typeof v === "boolean" ? String(v) : v}`);
}

function menu(path: string): string {
  return assertCommand(path);
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: `MikroTik error: ${message}` }] };
}

function rowsResult(rows: RosRecord[], limit = DEFAULT_LIMIT, fromEnd = false) {
  const total = rows.length;
  const slice = fromEnd ? rows.slice(-limit) : rows.slice(0, limit);
  return total > slice.length ? { total, returned: slice.length, truncated: true, rows: slice } : { total, rows: slice };
}

function assertWritable(device: DeviceConfig) {
  if (device.readOnly) {
    throw new RosError(`Device "${device.name}" is configured read-only`, "write operations are disabled");
  }
}

/** Resolve an item `.id` either directly or from a filter that must match exactly one item. */
async function resolveId(
  client: RosClient,
  path: string,
  id: string | undefined,
  where: Record<string, Value> | undefined,
): Promise<string> {
  if (id) return id;
  if (!where || Object.keys(where).length === 0) throw new RosError("Provide either `id` or `where`");
  const { rows } = await client.run(`${path}/print`, { query: toQuery(where), proplist: [".id"] });
  if (rows.length !== 1) {
    throw new RosError(`Filter matched ${rows.length} items in ${path}`, "it must match exactly one; pass `id` instead");
  }
  return rows[0][".id"];
}

/** Run a command and swallow "no such command" errors, so optional menus (wifi, health, ...) don't fail a whole tool. */
async function tryRun(client: RosClient, command: string, options = {}): Promise<RosRecord[] | undefined> {
  try {
    return (await client.run(command, options)).rows;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, registry: DeviceRegistry): void {
  const tool = <S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S; write?: boolean; destructive?: boolean },
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>, device: DeviceConfig, client: RosClient) => Promise<unknown>,
  ) => {
    const inputSchema = { device: deviceArg, ...config.inputSchema };
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema,
        annotations: {
          readOnlyHint: !config.write,
          destructiveHint: config.destructive ?? false,
          idempotentHint: !config.write,
          openWorldHint: true,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        try {
          const { device, client } = registry.resolve(args.device);
          if (config.write) assertWritable(device);
          return ok(await handler(args, device, client));
        } catch (e) {
          return fail(e);
        }
      }) as never,
    );
  };

  // ---- Devices ------------------------------------------------------------

  server.registerTool(
    "mikrotik_list_devices",
    {
      title: "List MikroTik devices",
      description: "List the MikroTik routers this server is configured to manage (no credentials are returned).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      ok(
        registry.devices.map((d, i) => ({
          name: d.name,
          host: d.host,
          transport: d.transport,
          readOnly: d.readOnly,
          default: i === 0,
        })),
      ),
  );

  // ---- Generic access to the whole configuration tree ---------------------

  tool(
    "mikrotik_print",
    {
      title: "Read any RouterOS menu",
      description:
        "Print items from any RouterOS menu path (the equivalent of `/<path> print` in the terminal or opening a window in WinBox). " +
        "Use this for anything without a dedicated tool, e.g. /ip/dns, /interface/bridge/port, /ip/ipsec/peer, /routing/ospf/neighbor, /queue/simple, /user.",
      inputSchema: {
        path: pathArg,
        where: whereArg,
        query: z
          .array(z.string())
          .optional()
          .describe('Raw RouterOS API query words for advanced filters, e.g. ["dynamic=false", "#!"] or [">rx-byte=1000"].'),
        properties: z.array(z.string()).optional().describe('Only return these properties, e.g. [".id", "name", "running"].'),
        limit: limitArg,
      },
    },
    async ({ path, where, query, properties, limit }, _d, client) => {
      const { rows } = await client.run(`${menu(path)}/print`, {
        query: [...toQuery(where), ...(query ?? [])],
        proplist: properties,
      });
      return rowsResult(rows, limit);
    },
  );

  tool(
    "mikrotik_add",
    {
      title: "Add a RouterOS item",
      description: "Add an item to any RouterOS menu (`/<path> add ...`). Returns the new item's .id.",
      inputSchema: { path: pathArg, properties: propsArg },
      write: true,
    },
    async ({ path, properties }, _d, client) => {
      const res = await client.run(`${menu(path)}/add`, { args: toArgs(properties) });
      return { added: true, id: res.ret };
    },
  );

  tool(
    "mikrotik_set",
    {
      title: "Change a RouterOS item or setting",
      description:
        "Change properties of an item (`/<path> set <id> ...`). Identify the item by `id` (e.g. \"*1F\") or a `where` filter matching exactly one item. " +
        "For singleton menus such as /system/identity, /ip/dns or /ip/cloud omit both.",
      inputSchema: {
        path: pathArg,
        properties: propsArg,
        id: z.string().optional().describe('Item .id, e.g. "*1F". For most menus the item name also works.'),
        where: whereArg,
      },
      write: true,
    },
    async ({ path, properties, id, where }, _d, client) => {
      const p = menu(path);
      const args = toArgs(properties);
      if (id || (where && Object.keys(where).length)) args[".id"] = await resolveId(client, p, id, where);
      await client.run(`${p}/set`, { args });
      return { updated: true, id: args[".id"] };
    },
  );

  tool(
    "mikrotik_remove",
    {
      title: "Remove a RouterOS item",
      description: "Remove an item (`/<path> remove <id>`), identified by `id` or a `where` filter matching exactly one item.",
      inputSchema: { path: pathArg, id: z.string().optional(), where: whereArg },
      write: true,
      destructive: true,
    },
    async ({ path, id, where }, _d, client) => {
      const p = menu(path);
      const target = await resolveId(client, p, id, where);
      await client.run(`${p}/remove`, { args: { ".id": target } });
      return { removed: true, id: target };
    },
  );

  tool(
    "mikrotik_set_enabled",
    {
      title: "Enable or disable a RouterOS item",
      description: "Enable or disable an interface, firewall rule, route, user, etc. Identify it by `id` or a `where` filter.",
      inputSchema: {
        path: pathArg,
        enabled: z.boolean(),
        id: z.string().optional(),
        where: whereArg,
      },
      write: true,
    },
    async ({ path, enabled, id, where }, _d, client) => {
      const p = menu(path);
      const target = await resolveId(client, p, id, where);
      await client.run(`${p}/${enabled ? "enable" : "disable"}`, { args: { ".id": target } });
      return { id: target, enabled };
    },
  );

  tool(
    "mikrotik_run_command",
    {
      title: "Run any RouterOS command",
      description:
        "Run an arbitrary RouterOS command, e.g. /system/script/run, /interface/ethernet/monitor (with once=yes), /ip/dhcp-server/lease/make-static, /tool/fetch. " +
        "Commands that never finish (monitor, torch, ping without count) must be given `once` or `count`/`duration` arguments. " +
        "On read-only devices only print/get/monitor/ping/traceroute style commands are allowed.",
      inputSchema: {
        command: z.string().describe('Full command path, e.g. "/system/script/run" or "/interface/monitor-traffic".'),
        args: z.record(valueSchema).optional().describe('Command arguments, e.g. {"interface": "ether1", "once": true}.'),
        query: z.array(z.string()).optional().describe("Raw API query words (for print-like commands)."),
        limit: limitArg,
      },
    },
    async ({ command, args, query, limit }, device, client) => {
      const cmd = menu(command);
      const verb = cmd.split("/").pop() ?? "";
      if (!READ_ONLY_VERBS.has(verb)) assertWritable(device);
      const res = await client.run(cmd, { args: toArgs(args), query });
      return { ...(res.ret !== undefined ? { ret: res.ret } : {}), ...rowsResult(res.rows, limit) };
    },
  );

  // ---- Curated read tools -------------------------------------------------

  tool(
    "mikrotik_system_overview",
    {
      title: "System overview",
      description: "Identity, RouterOS version, board, CPU/memory/disk usage, uptime, clock and health sensors in one call.",
      inputSchema: {},
    },
    async (_a, device, client) => {
      const [identity, resource, routerboard, clock, health, packages] = await Promise.all([
        tryRun(client, "/system/identity/print"),
        client.run("/system/resource/print").then((r) => r.rows),
        tryRun(client, "/system/routerboard/print"),
        tryRun(client, "/system/clock/print"),
        tryRun(client, "/system/health/print"),
        tryRun(client, "/system/package/print", { proplist: ["name", "version", "disabled"] }),
      ]);
      return {
        device: device.name,
        identity: identity?.[0]?.name,
        resource: resource[0],
        routerboard: routerboard?.[0],
        clock: clock?.[0],
        health,
        packages,
      };
    },
  );

  tool(
    "mikrotik_interfaces",
    {
      title: "List interfaces",
      description: "List interfaces with type, running/disabled state, MAC, MTU and traffic counters.",
      inputSchema: {
        type: z.string().optional().describe('Filter by type, e.g. "ether", "bridge", "vlan", "wlan", "wifi", "wg", "pppoe-out".'),
        running: z.boolean().optional(),
        limit: limitArg,
      },
    },
    async ({ type, running, limit }, _d, client) => {
      const { rows } = await client.run("/interface/print", {
        query: toQuery({ ...(type ? { type } : {}), ...(running !== undefined ? { running } : {}) }),
      });
      return rowsResult(rows, limit);
    },
  );

  tool(
    "mikrotik_ip_addresses",
    {
      title: "List IP addresses",
      description: "List IPv4 (or IPv6) addresses assigned to interfaces.",
      inputSchema: { ipv6: z.boolean().optional(), interface: z.string().optional(), limit: limitArg },
    },
    async ({ ipv6, interface: iface, limit }, _d, client) => {
      const { rows } = await client.run(`/${ipv6 ? "ipv6" : "ip"}/address/print`, {
        query: toQuery(iface ? { interface: iface } : undefined),
      });
      return rowsResult(rows, limit);
    },
  );

  tool(
    "mikrotik_routes",
    {
      title: "List routes",
      description: "List the IPv4 (or IPv6) routing table, optionally only active routes or a single destination.",
      inputSchema: {
        ipv6: z.boolean().optional(),
        activeOnly: z.boolean().optional(),
        dstAddress: z.string().optional().describe('e.g. "0.0.0.0/0" for default routes'),
        limit: limitArg,
      },
    },
    async ({ ipv6, activeOnly, dstAddress, limit }, _d, client) => {
      const { rows } = await client.run(`/${ipv6 ? "ipv6" : "ip"}/route/print`, {
        query: toQuery({ ...(activeOnly ? { active: true } : {}), ...(dstAddress ? { "dst-address": dstAddress } : {}) }),
      });
      return rowsResult(rows, limit);
    },
  );

  const firewallTable = z.enum(["filter", "nat", "mangle", "raw"]).default("filter");

  tool(
    "mikrotik_firewall_rules",
    {
      title: "List firewall rules",
      description: "List firewall rules in order (filter, nat, mangle or raw), including packet/byte counters.",
      inputSchema: {
        table: firewallTable,
        chain: z.string().optional().describe('e.g. "input", "forward", "srcnat", "dstnat"'),
        ipv6: z.boolean().optional(),
        limit: limitArg,
      },
    },
    async ({ table, chain, ipv6, limit }, _d, client) => {
      const { rows } = await client.run(`/${ipv6 ? "ipv6" : "ip"}/firewall/${table}/print`, {
        query: toQuery(chain ? { chain } : undefined),
      });
      return rowsResult(rows, limit);
    },
  );

  tool(
    "mikrotik_dhcp_leases",
    {
      title: "List DHCP leases",
      description: "List DHCP server leases (IP, MAC, hostname, status), optionally for one DHCP server.",
      inputSchema: { server: z.string().optional(), limit: limitArg },
    },
    async ({ server, limit }, _d, client) => {
      const { rows } = await client.run("/ip/dhcp-server/lease/print", { query: toQuery(server ? { server } : undefined) });
      return rowsResult(rows, limit);
    },
  );

  tool(
    "mikrotik_wireless_clients",
    {
      title: "List wireless clients",
      description: "List connected Wi-Fi clients from the registration table (supports the wifi, wifiwave2, legacy wireless and CAPsMAN packages).",
      inputSchema: { limit: limitArg },
    },
    async ({ limit }, _d, client) => {
      for (const menuPath of [
        "/interface/wifi/registration-table",
        "/interface/wifiwave2/registration-table",
        "/interface/wireless/registration-table",
        "/caps-man/registration-table",
      ]) {
        const rows = await tryRun(client, `${menuPath}/print`);
        if (rows) return { source: menuPath, ...rowsResult(rows, limit) };
      }
      throw new RosError("No wireless package found on this device");
    },
  );

  tool(
    "mikrotik_arp_table",
    {
      title: "ARP table and neighbors",
      description: "List ARP entries and discovered neighbors (MNDP/CDP/LLDP) to see which hosts are on the network.",
      inputSchema: { interface: z.string().optional(), limit: limitArg },
    },
    async ({ interface: iface, limit }, _d, client) => {
      const query = toQuery(iface ? { interface: iface } : undefined);
      const [arp, neighbors] = await Promise.all([
        client.run("/ip/arp/print", { query }).then((r) => r.rows),
        tryRun(client, "/ip/neighbor/print", { query }),
      ]);
      return { arp: rowsResult(arp, limit), neighbors: neighbors ? rowsResult(neighbors, limit) : undefined };
    },
  );

  tool(
    "mikrotik_logs",
    {
      title: "Read system log",
      description: "Read the most recent system log entries, optionally filtered by topic or text.",
      inputSchema: {
        topics: z.string().optional().describe('Only entries whose topics contain this, e.g. "firewall", "dhcp", "error".'),
        contains: z.string().optional().describe("Case-insensitive text search in the message."),
        limit: z.number().int().positive().max(5000).optional().describe("Number of newest entries (default 100)."),
      },
    },
    async ({ topics, contains, limit }, _d, client) => {
      let { rows } = await client.run("/log/print");
      if (topics) rows = rows.filter((r) => (r.topics ?? "").includes(topics));
      if (contains) rows = rows.filter((r) => (r.message ?? "").toLowerCase().includes(contains.toLowerCase()));
      return rowsResult(rows, limit ?? 100, true);
    },
  );

  tool(
    "mikrotik_ping",
    {
      title: "Ping from the router",
      description: "Ping a host from the router itself (useful to test connectivity from a specific interface or source address).",
      inputSchema: {
        address: z.string(),
        count: z.number().int().min(1).max(50).default(4),
        interface: z.string().optional(),
        srcAddress: z.string().optional(),
        vrf: z.string().optional().describe("VRF to ping from (RouterOS v7)"),
      },
    },
    async ({ address, count, interface: iface, srcAddress, vrf }, _d, client) => {
      const args: Record<string, string> = { address, count: String(count) };
      if (iface) args.interface = iface;
      if (srcAddress) args["src-address"] = srcAddress;
      if (vrf) args.vrf = vrf;
      const { rows } = await client.run("/ping", { args });
      return rows;
    },
  );

  tool(
    "mikrotik_traceroute",
    {
      title: "Traceroute from the router",
      description: "Trace the path from the router to a host.",
      inputSchema: { address: z.string(), maxHops: z.number().int().min(1).max(64).optional() },
    },
    async ({ address, maxHops }, _d, client) => {
      const args: Record<string, string> = { address, count: "1" };
      if (maxHops) args["max-hops"] = String(maxHops);
      const { rows } = await client.run("/tool/traceroute", { args });
      return rows;
    },
  );

  // ---- Curated write tools ------------------------------------------------

  tool(
    "mikrotik_firewall_add_rule",
    {
      title: "Add a firewall rule",
      description:
        "Add a firewall rule. `properties` takes any rule property (src-address, dst-port, protocol, in-interface, connection-state, to-addresses, ...). " +
        "Use `placeBefore` with a rule .id to insert it above an existing rule; otherwise it is appended to the end of the table.",
      inputSchema: {
        table: firewallTable,
        chain: z.string(),
        action: z.string().describe('e.g. "accept", "drop", "reject", "masquerade", "dst-nat", "add-src-to-address-list"'),
        properties: z.record(valueSchema).optional(),
        comment: z.string().optional(),
        placeBefore: z.string().optional(),
        ipv6: z.boolean().optional(),
      },
      write: true,
    },
    async ({ table, chain, action, properties, comment, placeBefore, ipv6 }, _d, client) => {
      const args = toArgs({ ...(properties ?? {}), chain, action });
      if (comment) args.comment = comment;
      if (placeBefore) args["place-before"] = placeBefore;
      const res = await client.run(`/${ipv6 ? "ipv6" : "ip"}/firewall/${table}/add`, { args });
      return { added: true, id: res.ret };
    },
  );

  tool(
    "mikrotik_address_list",
    {
      title: "Manage firewall address lists",
      description: "Add or remove an address in a firewall address list (commonly used to block or allow hosts).",
      inputSchema: {
        action: z.enum(["add", "remove"]),
        list: z.string(),
        address: z.string().describe("IP, range, subnet or DNS name"),
        comment: z.string().optional(),
        timeout: z.string().optional().describe('Auto-expire, e.g. "1h" or "1d"'),
        ipv6: z.boolean().optional(),
      },
      write: true,
    },
    async ({ action, list, address, comment, timeout, ipv6 }, _d, client) => {
      const p = `/${ipv6 ? "ipv6" : "ip"}/firewall/address-list`;
      if (action === "add") {
        const args: Record<string, string> = { list, address };
        if (comment) args.comment = comment;
        if (timeout) args.timeout = timeout;
        const res = await client.run(`${p}/add`, { args });
        return { added: true, id: res.ret };
      }
      const { rows } = await client.run(`${p}/print`, { query: toQuery({ list, address }), proplist: [".id"] });
      for (const r of rows) await client.run(`${p}/remove`, { args: { ".id": r[".id"] } });
      return { removed: rows.length };
    },
  );

  tool(
    "mikrotik_backup",
    {
      title: "Create a backup",
      description: "Save a binary backup (.backup) and/or a text export (.rsc) of the configuration to the router's file system.",
      inputSchema: {
        name: z.string().regex(/^[\w.-]+$/).optional().describe("Base file name (default: mcp-backup-<timestamp>)"),
        password: z.string().optional().describe("Encrypt the binary backup with this password"),
        exportScript: z.boolean().default(true).describe("Also write a text export (<name>.rsc)"),
      },
      write: true,
    },
    async ({ name, password, exportScript }, _d, client) => {
      const base = name ?? `mcp-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const args: Record<string, string> = { name: base };
      if (password) args.password = password;
      else args["dont-encrypt"] = "yes";
      await client.run("/system/backup/save", { args });
      const files = [`${base}.backup`];
      if (exportScript) {
        try {
          await client.run("/export", { args: { file: base } });
          files.push(`${base}.rsc`);
        } catch (e) {
          return { files, exportError: e instanceof Error ? e.message : String(e) };
        }
      }
      return { files };
    },
  );

  tool(
    "mikrotik_reboot",
    {
      title: "Reboot the router",
      description: "Reboot the router. The connection will drop for about a minute. Always confirm with the user first.",
      inputSchema: { confirm: z.literal(true).describe("Must be true to confirm the reboot") },
      write: true,
      destructive: true,
    },
    async (_a, device, client) => {
      // The router drops the session while rebooting, so a connection error here is expected.
      await client.run("/system/reboot").catch(() => undefined);
      return { rebooting: device.name };
    },
  );
}
