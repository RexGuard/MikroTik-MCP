import http from "node:http";
import net from "node:net";
import { AddressInfo } from "node:net";
import { encodeSentence, parseAttribute, SentenceDecoder } from "../src/clients/api.js";
import { RosRecord } from "../src/clients/types.js";

/** A tiny in-memory RouterOS that understands print/add/set/remove/enable/disable on any menu. */
export class MockRouter {
  menus = new Map<string, RosRecord[]>([
    ["/system/identity", [{ name: "MockRouter" }]],
    ["/system/resource", [{ version: "7.16 (stable)", "board-name": "CHR", uptime: "1d2h", "cpu-load": "3" }]],
    [
      "/interface",
      [
        { ".id": "*1", name: "ether1", type: "ether", running: "true", disabled: "false" },
        { ".id": "*2", name: "ether2", type: "ether", running: "false", disabled: "false" },
        { ".id": "*3", name: "bridge", type: "bridge", running: "true", disabled: "false" },
      ],
    ],
    ["/ip/address", [{ ".id": "*1", address: "192.168.88.1/24", interface: "bridge", disabled: "false" }]],
    ["/ip/firewall/filter", []],
    ["/ip/firewall/address-list", []],
    ["/log", Array.from({ length: 150 }, (_, i) => ({ ".id": `*${i}`, topics: i % 2 ? "system,info" : "firewall,info", message: `entry ${i}` }))],
  ]);
  calls: { command: string; args: Record<string, string>; query: string[] }[] = [];
  private nextId = 100;

  handle(command: string, args: Record<string, string>, query: string[]): { rows: RosRecord[]; ret?: string } {
    this.calls.push({ command, args, query });
    if (command === "/ping") {
      return { rows: Array.from({ length: Number(args.count ?? 1) }, (_, i) => ({ seq: String(i), host: args.address, time: "1ms" })) };
    }
    const i = command.lastIndexOf("/");
    const menu = command.slice(0, i);
    const verb = command.slice(i + 1);
    const items = this.menus.get(menu);
    if (!items) throw new Error("no such command prefix");
    const byId = (id: string) => {
      const item = items.find((r) => r[".id"] === id || r.name === id);
      if (!item) throw new Error("no such item");
      return item;
    };
    switch (verb) {
      case "print": {
        const filters = query.map((q) => q.replace(/^\?/, "").split("=", 2) as [string, string]);
        let rows = items.filter((r) => filters.every(([k, v]) => r[k] === v));
        const proplist = args[".proplist"]?.split(",");
        if (proplist) rows = rows.map((r) => Object.fromEntries(proplist.filter((k) => k in r).map((k) => [k, r[k]])));
        return { rows };
      }
      case "add": {
        const id = `*${(this.nextId++).toString(16).toUpperCase()}`;
        items.push({ ".id": id, disabled: "false", ...args });
        return { rows: [], ret: id };
      }
      case "set": {
        const { ".id": id, ...rest } = args;
        Object.assign(id ? byId(id) : items[0], rest);
        return { rows: [] };
      }
      case "remove":
        items.splice(items.indexOf(byId(args[".id"])), 1);
        return { rows: [] };
      case "enable":
      case "disable":
        byId(args[".id"]).disabled = verb === "disable" ? "true" : "false";
        return { rows: [] };
      default:
        throw new Error("no such command");
    }
  }

  /** Serve the RouterOS v7 REST API. */
  async listenRest(user = "admin", pass = "secret"): Promise<{ port: number; close: () => Promise<void> }> {
    const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.headers.authorization !== expected) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: 401, message: "Unauthorized" }));
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          const { ".query": query = [], ".proplist": proplist, ...args } = body;
          if (proplist) args[".proplist"] = proplist.join(",");
          const { rows, ret } = this.handle(req.url!.replace(/^\/rest/, ""), args, query);
          res.end(JSON.stringify(ret !== undefined ? { ret } : rows));
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 400, message: "Bad Request", detail: (e as Error).message }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
  }

  /** Serve the binary API (port 8728 protocol). */
  async listenApi(user = "admin", pass = "secret"): Promise<{ port: number; close: () => Promise<void> }> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      let loggedIn = false;
      const decoder = new SentenceDecoder();
      sock.on("data", (chunk: Buffer) => {
        for (const [command, ...words] of decoder.push(chunk)) {
          const args: Record<string, string> = {};
          const query: string[] = [];
          let tag: string | undefined;
          for (const w of words) {
            if (w.startsWith(".tag=")) tag = w.slice(5);
            else if (w.startsWith("?")) query.push(w);
            else {
              const kv = parseAttribute(w);
              if (kv) args[kv[0]] = kv[1];
            }
          }
          const tagWord = tag ? [`.tag=${tag}`] : [];
          if (command === "/login") {
            loggedIn = args.name === user && args.password === pass;
            if (!loggedIn) sock.write(encodeSentence(["!trap", "=message=invalid user name or password (6)", ...tagWord]));
            sock.write(encodeSentence(["!done", ...tagWord]));
            continue;
          }
          if (!loggedIn) {
            sock.write(encodeSentence(["!fatal", "not logged in"]));
            sock.destroy();
            return;
          }
          try {
            const { rows, ret } = this.handle(command, args, query);
            for (const r of rows) sock.write(encodeSentence(["!re", ...Object.entries(r).map(([k, v]) => `=${k}=${v}`), ...tagWord]));
            sock.write(encodeSentence(["!done", ...(ret ? [`=ret=${ret}`] : []), ...tagWord]));
          } catch (e) {
            sock.write(encodeSentence(["!trap", `=message=${(e as Error).message}`, ...tagWord]));
            sock.write(encodeSentence(["!done", ...tagWord]));
          }
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    };
  }
}
