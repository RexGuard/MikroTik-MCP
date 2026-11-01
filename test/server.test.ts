import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient, encodeLength, encodeSentence, SentenceDecoder } from "../src/clients/api.js";
import { readFileSync } from "node:fs";
import net from "node:net";
import { AddressInfo } from "node:net";
import { configProblem, DeviceRegistry, loadDevices, parseAddress } from "../src/config.js";
import { checkConnection, explainError } from "../src/diagnose.js";
import { registerTools } from "../src/tools.js";
import { MockRouter } from "./mock-router.js";

describe("binary API wire format", () => {
  it("round-trips words of every length class", () => {
    const words = [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 0x1fffff, 0x200000].map((n) => "x".repeat(n)).filter(Boolean);
    const encoded = encodeSentence(words);
    const dec = new SentenceDecoder();
    // feed byte-by-byte chunks to exercise partial reads
    const out: string[][] = [];
    for (let i = 0; i < encoded.length; i += 7777) out.push(...dec.push(encoded.subarray(i, i + 7777)));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].map((w) => w.length), words.map((w) => w.length));
  });

  it("encodes lengths per the RouterOS spec", () => {
    assert.deepEqual([...encodeLength(0x7f)], [0x7f]);
    assert.deepEqual([...encodeLength(0x80)], [0x80, 0x80]);
    assert.deepEqual([...encodeLength(0x4000)], [0xc0, 0x40, 0x00]);
    assert.deepEqual([...encodeLength(0x200000)], [0xe0, 0x20, 0x00, 0x00]);
    assert.deepEqual([...encodeLength(0x10000000)], [0xf0, 0x10, 0x00, 0x00, 0x00]);
  });
});

describe("config", () => {
  it("builds a single device from env vars", () => {
    const [d] = loadDevices({ MIKROTIK_HOST: "10.0.0.1", MIKROTIK_USERNAME: "u", MIKROTIK_PASSWORD: "p", MIKROTIK_TRANSPORT: "API" });
    assert.equal(d.name, "default");
    assert.equal(d.transport, "api");
    assert.equal(d.readOnly, false);
  });

  it("parses MIKROTIK_DEVICES and forces read-only", () => {
    const devices = loadDevices({
      MIKROTIK_DEVICES: JSON.stringify([{ name: "a", host: "h1" }, { name: "b", host: "h2", transport: "api" }]),
      MIKROTIK_READ_ONLY: "true",
    });
    assert.deepEqual(devices.map((d) => [d.name, d.readOnly]), [["a", true], ["b", true]]);
  });

  it("picks the transport and TLS from the port", () => {
    const pick = (env: Record<string, string>) => {
      const [d] = loadDevices({ MIKROTIK_HOST: "r", ...env });
      return [d.transport, d.port, d.tls];
    };
    assert.deepEqual(pick({ MIKROTIK_PORT: "8728" }), ["api", 8728, false]);
    assert.deepEqual(pick({ MIKROTIK_PORT: "8729" }), ["api", 8729, true]);
    assert.deepEqual(pick({ MIKROTIK_PORT: "443" }), ["rest", 443, true]);
    assert.deepEqual(pick({ MIKROTIK_PORT: "80" }), ["rest", 80, false]);
    assert.deepEqual(pick({}), ["rest", 443, true]);
    assert.deepEqual(pick({ MIKROTIK_PORT: "18728" }), ["api", 18728, false]);
    assert.deepEqual(pick({ MIKROTIK_TRANSPORT: "api" }), ["api", 8728, false]);
    assert.deepEqual(pick({ MIKROTIK_TRANSPORT: "api", MIKROTIK_TLS: "true" }), ["api", 8729, true]);
    assert.deepEqual(pick({ MIKROTIK_PORT: "8443", MIKROTIK_TRANSPORT: "rest" }), ["rest", 8443, true]);
  });

  it("accepts addresses pasted as URLs or host:port", () => {
    assert.deepEqual(parseAddress("192.168.88.1"), { host: "192.168.88.1", port: undefined, scheme: undefined });
    assert.deepEqual(parseAddress(" router.example.com:8729 "), { host: "router.example.com", port: 8729, scheme: undefined });
    assert.deepEqual(parseAddress("https://10.0.0.1/webfig/"), { host: "10.0.0.1", port: undefined, scheme: "https" });
    assert.deepEqual(parseAddress("[fe80::1]:8728"), { host: "fe80::1", port: 8728, scheme: undefined });
    assert.deepEqual(parseAddress("fe80::1"), { host: "fe80::1", port: undefined, scheme: undefined });
    assert.throws(() => parseAddress("ssh://r"));
    const [d] = loadDevices({ MIKROTIK_HOST: "api-ssl://r.example.com", MIKROTIK_PORT: "8728" });
    assert.deepEqual([d.host, d.transport, d.tls, d.port], ["r.example.com", "api", true, 8728]);
    const [e] = loadDevices({ MIKROTIK_HOST: "r.example.com:443", MIKROTIK_PORT: "8728" });
    assert.deepEqual([e.transport, e.port], ["rest", 443]);
  });

  it("ignores unfilled bundle placeholders", () => {
    const [d] = loadDevices({
      MIKROTIK_HOST: "10.0.0.1",
      MIKROTIK_PORT: "${user_config.port}",
      MIKROTIK_USERNAME: "${user_config.username}",
      MIKROTIK_PASSWORD: "${user_config.password}",
      MIKROTIK_INSECURE: "",
    });
    assert.deepEqual([d.port, d.username, d.password, d.insecure], [443, "admin", "", false]);
    assert.deepEqual(loadDevices({ MIKROTIK_HOST: "${user_config.host}" }), []);
  });

  it("explains that WinBox's port cannot be used", () => {
    const [d] = loadDevices({ MIKROTIK_HOST: "r:8291" });
    assert.match(configProblem(d)!.message, /WinBox.*8728/s);
    const registry = new DeviceRegistry([d]);
    assert.throws(() => registry.resolve(), /WinBox/);
  });

  it("rejects duplicate names", () => {
    assert.throws(() => loadDevices({ MIKROTIK_DEVICES: JSON.stringify([{ name: "a", host: "x" }, { name: "a", host: "y" }]) }));
  });
});

for (const transport of ["rest", "api"] as const) {
  describe(`MCP tools over ${transport}`, () => {
    const router = new MockRouter();
    let close: () => Promise<void>;
    let client: Client;
    let registry: DeviceRegistry;

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      const text = res.content[0].text;
      return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
    };

    before(async () => {
      const srv = transport === "rest" ? await router.listenRest() : await router.listenApi();
      close = srv.close;
      registry = new DeviceRegistry(
        loadDevices({
          MIKROTIK_DEVICES: JSON.stringify([
            { name: "rw", host: "127.0.0.1", port: srv.port, username: "admin", password: "secret", transport, tls: false },
            { name: "ro", host: "127.0.0.1", port: srv.port, username: "admin", password: "secret", transport, tls: false, readOnly: true },
            { name: "badpw", host: "127.0.0.1", port: srv.port, username: "admin", password: "nope", transport, tls: false },
          ]),
        }),
      );
      const server = new McpServer({ name: "test", version: "0" });
      registerTools(server, registry);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      client = new Client({ name: "t", version: "0" });
      await client.connect(b);
    });

    after(async () => {
      await client.close();
      await registry.closeAll();
      await close();
    });

    it("lists every tool in the Claude Desktop extension manifest", async () => {
      const { tools } = await client.listTools();
      const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
      const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
      assert.deepEqual(manifest.tools.map((t: { name: string }) => t.name).sort(), tools.map((t) => t.name).sort());
      assert.equal(manifest.version, pkg.version);
    });

    it("lists tools with annotations", async () => {
      const { tools } = await client.listTools();
      const reboot = tools.find((t) => t.name === "mikrotik_reboot");
      assert.equal(reboot?.annotations?.destructiveHint, true);
      assert.ok(tools.length >= 20);
    });

    it("reads the system overview", async () => {
      const { json } = await call("mikrotik_system_overview");
      assert.equal(json.identity, "MockRouter");
      assert.equal(json.resource.version, "7.16 (stable)");
    });

    it("filters interfaces", async () => {
      const { json } = await call("mikrotik_interfaces", { type: "ether", running: true });
      assert.deepEqual(json.rows.map((r: { name: string }) => r.name), ["ether1"]);
    });

    it("prints any menu with a property list", async () => {
      const { json } = await call("mikrotik_print", { path: "ip address", properties: ["address"] });
      assert.deepEqual(json.rows, [{ address: "192.168.88.1/24" }]);
    });

    it("adds, changes, disables and removes items", async () => {
      const added = await call("mikrotik_add", { path: "/ip/address", properties: { address: "10.9.9.1/24", interface: "ether2" } });
      assert.match(added.json.id, /^\*/);
      await call("mikrotik_set", { path: "/ip/address", where: { address: "10.9.9.1/24" }, properties: { comment: "lab" } });
      await call("mikrotik_set_enabled", { path: "/ip/address", id: added.json.id, enabled: false });
      const item = router.menus.get("/ip/address")!.find((r) => r[".id"] === added.json.id)!;
      assert.equal(item.comment, "lab");
      assert.equal(item.disabled, "true");
      await call("mikrotik_remove", { path: "/ip/address", id: added.json.id });
      assert.equal(router.menus.get("/ip/address")!.length, 1);
    });

    it("sets singleton menus without an id", async () => {
      await call("mikrotik_set", { path: "/system/identity", properties: { name: "edge-1" } });
      const { json } = await call("mikrotik_system_overview");
      assert.equal(json.identity, "edge-1");
    });

    it("manages firewall rules and address lists", async () => {
      const rule = await call("mikrotik_firewall_add_rule", {
        chain: "input",
        action: "drop",
        properties: { "src-address-list": "blocked" },
        comment: "drop blocked",
      });
      assert.equal(rule.isError, false);
      await call("mikrotik_address_list", { action: "add", list: "blocked", address: "203.0.113.5", timeout: "1h" });
      const { json } = await call("mikrotik_firewall_rules", { chain: "input" });
      assert.equal(json.rows[0].action, "drop");
      const removed = await call("mikrotik_address_list", { action: "remove", list: "blocked", address: "203.0.113.5" });
      assert.equal(removed.json.removed, 1);
    });

    it("returns the newest log entries", async () => {
      const { json } = await call("mikrotik_logs", { topics: "firewall", limit: 5 });
      assert.equal(json.rows.length, 5);
      assert.equal(json.rows.at(-1).message, "entry 148");
    });

    it("pings", async () => {
      const { json } = await call("mikrotik_ping", { address: "1.1.1.1", count: 3 });
      assert.equal(json.length, 3);
    });

    it("blocks writes on read-only devices but allows reads", async () => {
      const w = await call("mikrotik_add", { device: "ro", path: "/ip/address", properties: { address: "1.2.3.4/32" } });
      assert.equal(w.isError, true);
      assert.match(w.text, /read-only/);
      const cmd = await call("mikrotik_run_command", { device: "ro", command: "/system/reboot" });
      assert.equal(cmd.isError, true);
      const r = await call("mikrotik_run_command", { device: "ro", command: "/interface/print" });
      assert.equal(r.json.total, 3);
    });

    it("reports router errors and bad input", async () => {
      const e = await call("mikrotik_remove", { path: "/ip/address", id: "*999" });
      assert.equal(e.isError, true);
      assert.match(e.text, /no such item/);
      const bad = await call("mikrotik_print", { path: "/ip/address; /system/reboot" });
      assert.match(bad.text, /Invalid RouterOS command path/);
      const unknown = await call("mikrotik_print", { device: "nope", path: "/ip/address" });
      assert.match(unknown.text, /Unknown device/);
    });

    it("reports bad credentials", async () => {
      const e = await call("mikrotik_interfaces", { device: "badpw" });
      assert.equal(e.isError, true);
      assert.match(e.text, transport === "rest" ? /Unauthorized/ : /Login failed/);
      assert.match(e.text, /Likely cause and fix: The router rejected the user name or password/);
    });

    it("checks the connection", async () => {
      const good = await call("mikrotik_check_connection");
      assert.equal(good.isError, false);
      assert.equal(good.json.ok, true);
      assert.equal(good.json.identity, router.menus.get("/system/identity")![0].name);
      const bad = await call("mikrotik_check_connection", { device: "badpw" });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /howToFix/);
    });
  });
}

describe("ApiClient", () => {
  it("multiplexes concurrent commands on one connection", async () => {
    const router = new MockRouter();
    const srv = await router.listenApi();
    const c = new ApiClient({ host: "127.0.0.1", port: srv.port, username: "admin", password: "secret" });
    const results = await Promise.all([c.run("/interface/print"), c.run("/ip/address/print"), c.run("/log/print")]);
    assert.deepEqual(results.map((r) => r.rows.length), [3, 1, 150]);
    await c.close();
    await srv.close();
  });
});

describe("connection diagnostics", () => {
  const device = (port: number, transport: "api" | "rest" = "api") =>
    loadDevices({
      MIKROTIK_HOST: "127.0.0.1",
      MIKROTIK_PORT: String(port),
      MIKROTIK_TRANSPORT: transport,
      MIKROTIK_TLS: "false",
      MIKROTIK_TIMEOUT_MS: "2000",
    })[0];

  const check = async (port: number, transport: "api" | "rest" = "api") => {
    const d = device(port, transport);
    const registry = new DeviceRegistry([d]);
    const r = await checkConnection(d, () => registry.resolve().client);
    await registry.closeAll();
    return r;
  };

  it("explains a closed port", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise((r) => srv.close(r));
    const r = await check(port);
    assert.equal(r.ok, false);
    assert.match(r.howToFix!, /refused.*\/ip service set api disabled=no/s);
  });

  it("explains a router that drops the connection (available-from)", async () => {
    const srv = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    for (const transport of ["api", "rest"] as const) {
      const r = await check(port, transport);
      assert.equal(r.ok, false, transport);
      assert.match(r.howToFix!, /available-from/, transport);
    }
    await new Promise((r) => srv.close(r));
  });

  it("explains a port that never answers the API login", async () => {
    const sockets: net.Socket[] = [];
    const srv = net.createServer((s) => sockets.push(s));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const r = await check(port);
    assert.match(r.howToFix!, /not the API service/);
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => srv.close(r));
  });

  it("explains DNS and certificate errors", () => {
    const d = device(8729);
    assert.match(explainError(new Error("getaddrinfo ENOTFOUND nope.invalid"), d)!, /DNS/);
    assert.match(explainError(new Error("self-signed certificate"), d)!, /Accept self-signed certificate/);
    assert.equal(explainError(new Error("no such item"), d), undefined);
  });
});
