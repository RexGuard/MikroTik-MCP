import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeviceRegistry, loadDevices } from "../src/config.js";
import { redact, redactText } from "../src/redact.js";
import { baselineFirewall, parseCidr, wireguardKeyPair } from "../src/tools-extended.js";
import { registerTools } from "../src/tools.js";
import { MockRouter } from "./mock-router.js";

describe("helpers", () => {
  it("parses CIDRs", () => {
    const n = parseCidr("10.7.0.1/24");
    assert.equal(n.prefix, 24);
    assert.equal(n.broadcast - n.network, 255);
    assert.throws(() => parseCidr("10.0.0.300/24"));
  });

  it("generates matching WireGuard keys", () => {
    const a = wireguardKeyPair();
    const b = wireguardKeyPair();
    assert.equal(Buffer.from(a.privateKey, "base64").length, 32);
    // A key pair is valid if both sides derive the same shared secret.
    const der = (pub: string) => Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(pub, "base64")]);
    const priv = (k: string) => Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(k, "base64")]);
    const s1 = diffieHellman({
      privateKey: createPrivateKey({ key: priv(a.privateKey), format: "der", type: "pkcs8" }),
      publicKey: createPublicKey({ key: der(b.publicKey), format: "der", type: "spki" }),
    });
    const s2 = diffieHellman({
      privateKey: createPrivateKey({ key: priv(b.privateKey), format: "der", type: "pkcs8" }),
      publicKey: createPublicKey({ key: der(a.publicKey), format: "der", type: "spki" }),
    });
    assert.deepEqual(s1, s2);
  });

  it("hides secrets in records and text", () => {
    assert.deepEqual(redact({ name: "home", "wpa2-pre-shared-key": "pa55word", "private-key": "abc=", comment: "" }), {
      name: "home",
      "wpa2-pre-shared-key": "***",
      "private-key": "***",
      comment: "",
    });
    assert.equal(redactText('add name=ops password="hunter 2" group=full'), 'add name=ops password="***" group=full');
    assert.equal(redactText("PrivateKey = aGVsbG8=\nAddress = 10.7.0.2/24"), "PrivateKey = ***\nAddress = 10.7.0.2/24");
    assert.equal(redactText("set secret=abc123 interface=ether1"), "set secret=*** interface=ether1");
    assert.equal(redactText("set wifi1 security.wpa2-pre-shared-key=pa55word ssid=home"), "set wifi1 security.wpa2-pre-shared-key=*** ssid=home");
  });

  it("plans a baseline firewall that drops only on the WAN", () => {
    const rules = baselineFirewall({ wanInterface: "ether1", allowUdpPorts: [51820], masquerade: true });
    const drops = rules.filter((r) => r.args.action === "drop" && !r.args["connection-state"]?.includes("invalid"));
    assert.ok(drops.every((r) => r.args["in-interface"] === "ether1"));
    assert.equal(rules.at(-1)?.table, "nat");
    assert.ok(rules.some((r) => r.args["dst-port"] === "51820"));
  });
});

for (const transport of ["rest", "api"] as const) {
  describe(`extended tools over ${transport}`, () => {
    const router = new MockRouter();
    router.menus.set("/file", [{ ".id": "*F1", name: "nightly.backup", type: "backup", size: "40000" }]);
    router.menus.set("/interface/wireguard", [{ ".id": "*W1", name: "wireguard1", "public-key": "U2VydmVyS2V5U2VydmVyS2V5U2VydmVyS2V5U2Vy=", "listen-port": "13231" }]);
    router.menus.set("/interface/wireguard/peers", [{ ".id": "*P1", interface: "wireguard1", "allowed-address": "10.7.0.2/32" }]);
    router.menus.get("/ip/address")!.push({ ".id": "*2", address: "10.7.0.1/24", interface: "wireguard1" });
    router.menus.set("/ip/pool", []);
    router.menus.set("/ip/dhcp-server", []);
    router.menus.set("/ip/dhcp-server/network", []);
    router.menus.set("/ip/dns/cache", [{ ".id": "*C1", name: "example.com" }]);
    router.menus.set("/ip/firewall/nat", []);

    let close: () => Promise<void>;
    let client: Client;
    let registry: DeviceRegistry;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      const text = res.content[0].text;
      let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: !!res.isError, text, json };
    };

    before(async () => {
      const srv = transport === "rest" ? await router.listenRest() : await router.listenApi();
      close = srv.close;
      registry = new DeviceRegistry(
        loadDevices({
          MIKROTIK_DEVICES: JSON.stringify([
            { name: "rw", host: "127.0.0.1", port: srv.port, username: "admin", password: "secret", transport, tls: false },
            { name: "ro", host: "127.0.0.1", port: srv.port, username: "admin", password: "secret", transport, tls: false, readOnly: true },
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

    it("returns a config export as text and cleans up", async () => {
      const r = await call("mikrotik_export_config", { section: "/user" });
      assert.equal(r.isError, false);
      assert.match(r.text, /# export of \/user/);
      assert.doesNotMatch(r.text, /hunter2/);
      assert.ok(!router.menus.get("/file")!.some((f) => f.name.startsWith("mcp-export-")));
      const sensitive = await call("mikrotik_export_config", { showSensitive: true });
      assert.match(sensitive.text, /hunter2/);
    });

    it("lists files without contents", async () => {
      const { json } = await call("mikrotik_files", { type: "backup" });
      assert.deepEqual(json.rows.map((f: { name: string }) => f.name), ["nightly.backup"]);
    });

    it("restores a backup only with confirm and an existing file", async () => {
      assert.equal((await call("mikrotik_restore_backup", { name: "nightly.backup" })).isError, true);
      const missing = await call("mikrotik_restore_backup", { name: "nope.backup", confirm: true });
      assert.match(missing.text, /No file named/);
      const ok = await call("mikrotik_restore_backup", { name: "nightly.backup", confirm: true });
      assert.equal(ok.json.restoring, "nightly.backup");
      const load = router.calls.filter((c) => c.command === "/system/backup/load").at(-1)!;
      assert.equal(load.args.password, "");
      const ro = await call("mikrotik_restore_backup", { device: "ro", name: "nightly.backup", confirm: true });
      assert.match(ro.text, /read-only/);
    });

    it("moves firewall rules", async () => {
      const a = await call("mikrotik_firewall_add_rule", { chain: "input", action: "accept", comment: "first" });
      const b = await call("mikrotik_firewall_add_rule", { chain: "input", action: "drop", comment: "second" });
      await call("mikrotik_move_rule", { where: { comment: "second" }, before: a.json.id });
      const order = router.menus.get("/ip/firewall/filter")!.map((r) => r.comment);
      assert.deepEqual(order.slice(-2), ["second", "first"]);
      assert.ok(b.json.id);
    });

    it("plans, then applies, a baseline firewall", async () => {
      const before = router.menus.get("/ip/firewall/filter")!.length;
      const plan = await call("mikrotik_baseline_firewall", { wanInterface: "ether1", masquerade: true });
      assert.equal(plan.json.dryRun, true);
      assert.equal(router.menus.get("/ip/firewall/filter")!.length, before);
      const bad = await call("mikrotik_baseline_firewall", { wanInterface: "ether9" });
      assert.match(bad.text, /No interface/);
      const roApply = await call("mikrotik_baseline_firewall", { device: "ro", wanInterface: "ether1", apply: true });
      assert.match(roApply.text, /read-only/);
      const applied = await call("mikrotik_baseline_firewall", { wanInterface: "ether1", masquerade: true, apply: true });
      assert.equal(applied.json.added, plan.json.rules.length);
      assert.equal(router.menus.get("/ip/firewall/nat")!.length, 1);
      const again = await call("mikrotik_baseline_firewall", { wanInterface: "ether1", apply: true });
      assert.match(again.text, /already exist/);
    });

    it("onboards a WireGuard client", async () => {
      const { json } = await call("mikrotik_wireguard_add_client", { interface: "wireguard1", name: "phone", dns: "10.7.0.1", presharedKey: true });
      assert.equal(json.clientAddress, "10.7.0.3");
      assert.match(json.config, /Endpoint = 127\.0\.0\.1:13231/);
      assert.match(json.config, /Address = 10\.7\.0\.3\/24/);
      assert.match(json.config, /PresharedKey = /);
      const peer = router.menus.get("/interface/wireguard/peers")!.at(-1)!;
      assert.equal(peer["public-key"], json.clientPublicKey);
      assert.equal(peer["allowed-address"], "10.7.0.3/32");
      const next = await call("mikrotik_wireguard_add_client", { interface: "wireguard1", name: "laptop", endpoint: "203.0.113.1:51820" });
      assert.equal(next.json.clientAddress, "10.7.0.4");
      assert.match(next.json.config, /Endpoint = 203\.0\.113\.1:51820/);
    });

    it("sets up a DHCP server", async () => {
      const { json } = await call("mikrotik_dhcp_server_setup", { interface: "bridge", network: "192.168.88.0/24" });
      assert.equal(json.network.gateway, "192.168.88.1");
      assert.equal(json.pool.ranges, "192.168.88.10-192.168.88.254");
      assert.equal(json.warning, undefined);
      assert.equal(router.menus.get("/ip/dhcp-server")![0]["address-pool"], "dhcp-bridge-pool");
      const warn = await call("mikrotik_dhcp_server_setup", { interface: "ether2", network: "10.20.0.0/24", name: "lab" });
      assert.match(warn.json.warning, /no address/);
    });

    it("resolves names and flushes the DNS cache", async () => {
      const r = await call("mikrotik_dns_resolve", { device: "ro", name: "example.com" });
      assert.equal(r.json.address, "93.184.215.14");
      const bad = await call("mikrotik_dns_resolve", { name: 'x"; /system/reboot' });
      assert.equal(bad.isError, true);
      const f = await call("mikrotik_dns_flush_cache");
      assert.equal(f.json.entriesBefore, 1);
      assert.equal(router.menus.get("/ip/dns/cache")!.length, 0);
    });
  });
}
