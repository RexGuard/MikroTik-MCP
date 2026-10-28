#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DeviceRegistry, loadDevices } from "./config.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.1.0";

async function main() {
  const registry = new DeviceRegistry(loadDevices());
  const server = new McpServer(
    { name: "mikrotik-mcp", version: VERSION },
    {
      instructions:
        "Tools for managing MikroTik RouterOS devices. Prefer the dedicated tools; use mikrotik_print / mikrotik_add / mikrotik_set / " +
        "mikrotik_remove for any other menu path. Before changing firewall, routing, addressing or bridge configuration, read the " +
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
  console.error(`mikrotik-mcp ${VERSION} ready (${registry.devices.length} device(s) configured)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
