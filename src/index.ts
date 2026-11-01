#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DeviceConfig, DeviceRegistry, loadDevices } from "./config.js";
import { checkConnection } from "./diagnose.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.2.0";

function load(): { devices: DeviceConfig[]; error?: Error } {
  try {
    return { devices: loadDevices() };
  } catch (e) {
    return { devices: [], error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** `mikrotik-mcp --check`: test every configured router from a terminal and explain failures. */
async function check(): Promise<number> {
  const { devices, error } = load();
  if (error) {
    console.error(`Invalid configuration: ${error.message}`);
    return 1;
  }
  if (devices.length === 0) {
    console.error("No router configured. Set MIKROTIK_HOST (and MIKROTIK_PORT, MIKROTIK_USERNAME, MIKROTIK_PASSWORD).");
    return 1;
  }
  const registry = new DeviceRegistry(devices);
  let failed = 0;
  for (const d of devices) {
    const r = await checkConnection(d, () => registry.resolve(d.name).client);
    const target = `${r.device} (${r.host}:${r.port}, ${r.transport})`;
    if (r.ok) {
      console.log(`OK    ${target}: "${r.identity}", RouterOS ${r.version}${r.board ? `, ${r.board}` : ""}`);
    } else {
      failed++;
      console.log(`FAIL  ${target}: ${r.error}`);
      if (r.howToFix) console.log(`      ${r.howToFix}`);
    }
  }
  await registry.closeAll();
  return failed ? 1 : 0;
}

async function serve() {
  const { devices, error } = load();
  const registry = new DeviceRegistry(devices);
  if (error) {
    // Keep running so Claude can show the problem instead of a bare "server disconnected".
    registry.configError = error;
    console.error(`mikrotik-mcp: invalid configuration: ${error.message}`);
  }
  const server = new McpServer(
    { name: "mikrotik-mcp", version: VERSION },
    {
      instructions:
        "Tools for managing MikroTik RouterOS devices. Prefer the dedicated tools; use mikrotik_print / mikrotik_add / mikrotik_set / " +
        "mikrotik_remove for any other menu path. If a tool cannot connect, run mikrotik_check_connection and relay its " +
        "plain-language fix to the user. Before changing firewall, routing, addressing or bridge configuration, read the " +
        "current state and confirm the change with the user, since a mistake can cut off access to the router.",
    },
  );
  registerTools(server, registry);

  const shutdown = async () => {
    await registry.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  const summary = devices.map((d) => `${d.name}=${d.host}:${d.port}/${d.transport}${d.tls ? "+tls" : ""}`).join(", ");
  console.error(`mikrotik-mcp ${VERSION} ready (${devices.length} device(s)${summary ? `: ${summary}` : ""})`);
}

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
} else if (args.includes("--check")) {
  check().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
} else {
  serve().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
