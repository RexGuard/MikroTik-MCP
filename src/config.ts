import { readFileSync } from "node:fs";
import { z } from "zod";
import { ApiClient } from "./clients/api.js";
import { RestClient } from "./clients/rest.js";
import { RosClient, RosError } from "./clients/types.js";

const DeviceSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  username: z.string().min(1).default("admin"),
  password: z.string().default(""),
  /** `auto` picks the transport from the port: 8728/8729 → binary API, 80/443 → REST. */
  transport: z.enum(["auto", "rest", "api"]).default("auto"),
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().optional(),
  insecure: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(30_000),
});

export interface DeviceConfig {
  name: string;
  host: string;
  username: string;
  password: string;
  transport: "rest" | "api";
  port: number;
  tls: boolean;
  insecure: boolean;
  readOnly: boolean;
  timeoutMs: number;
}

/** Ports that belong to RouterOS services the connector cannot talk to. */
const UNSUPPORTED_PORTS: Record<number, string> = {
  8291: "WinBox",
  20561: "MAC WinBox",
  22: "SSH",
  23: "Telnet",
  21: "FTP",
};

/**
 * Returns why this device cannot work as configured (for example the WinBox
 * port), or undefined when the configuration looks usable.
 */
export function configProblem(d: DeviceConfig): RosError | undefined {
  const service = UNSUPPORTED_PORTS[d.port];
  if (service) {
    return new RosError(
      `Port ${d.port} is the ${service} port, which the connector cannot use`,
      `${service} speaks its own protocol. Use the RouterOS API instead: port 8728 (API), 8729 (API-SSL) or 443 (REST, RouterOS 7). ` +
        `Turn it on in the router terminal with: /ip service set api disabled=no`,
    );
  }
  return undefined;
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/**
 * Reads an env var, treating empty values and unfilled template placeholders
 * such as `${user_config.port}` (left by MCP bundle hosts for blank optional
 * fields) as unset.
 */
function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = env[name]?.trim();
    if (v && !/^\$\{[^}]*\}$/.test(v)) return v;
  }
  return undefined;
}

function numberValue(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

type Scheme = "http" | "https" | "api" | "api-ssl";

/**
 * Accepts what people paste into an address box: `192.168.88.1`,
 * `router.example.com:8729`, `https://192.168.88.1/`, `[fe80::1]:8728`,
 * `api-ssl://router.example.com`.
 */
export function parseAddress(input: string): { host: string; port?: number; scheme?: Scheme } {
  let s = input.trim();
  let scheme: Scheme | undefined;
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (m) {
    const name = m[1].toLowerCase();
    if (name === "http" || name === "https" || name === "api" || name === "api-ssl") scheme = name;
    else throw new Error(`Unsupported address scheme "${m[1]}://" in "${input}" (use http, https, api or api-ssl, or just the IP)`);
    s = s.slice(m[0].length);
  }
  s = s.replace(/[/?#].*$/, ""); // drop any path such as /webfig/
  s = s.replace(/^[^@]*@/, ""); // drop user@ if someone pasted it
  let host = s;
  let port: number | undefined;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) {
    host = v6[1];
    port = v6[2] ? Number(v6[2]) : undefined;
  } else if ((s.match(/:/g) ?? []).length === 1) {
    const [h, p] = s.split(":");
    if (!/^\d+$/.test(p)) throw new Error(`Invalid port in address "${input}"`);
    host = h;
    port = Number(p);
  }
  if (!host) throw new Error(`No host name or IP address in "${input}"`);
  return { host, port, scheme };
}

const PORT_DEFAULTS: Record<number, { transport: "rest" | "api"; tls: boolean }> = {
  8728: { transport: "api", tls: false },
  8729: { transport: "api", tls: true },
  443: { transport: "rest", tls: true },
  80: { transport: "rest", tls: false },
};

const SCHEME_DEFAULTS: Record<Scheme, { transport: "rest" | "api"; tls: boolean }> = {
  http: { transport: "rest", tls: false },
  https: { transport: "rest", tls: true },
  api: { transport: "api", tls: false },
  "api-ssl": { transport: "api", tls: true },
};

/** Turns a parsed device entry into a concrete transport, port and TLS setting. */
function finalize(d: z.infer<typeof DeviceSchema>): DeviceConfig {
  const addr = parseAddress(d.host);
  // A port typed into the address wins over the separate port setting.
  const explicitPort = addr.port ?? d.port;
  const fromScheme = addr.scheme ? SCHEME_DEFAULTS[addr.scheme] : undefined;
  const fromPort = explicitPort !== undefined ? PORT_DEFAULTS[explicitPort] : undefined;

  let transport: "rest" | "api";
  if (d.transport !== "auto") transport = d.transport;
  else transport = fromScheme?.transport ?? fromPort?.transport ?? (explicitPort !== undefined ? "api" : "rest");

  const tls =
    d.tls ??
    fromScheme?.tls ??
    (fromPort && fromPort.transport === transport ? fromPort.tls : undefined) ??
    (transport === "rest");
  const port = explicitPort ?? (transport === "rest" ? (tls ? 443 : 80) : tls ? 8729 : 8728);
  return { ...d, host: addr.host, transport, port, tls };
}

/**
 * Devices come from (first match wins):
 *  1. MIKROTIK_CONFIG — path to a JSON file holding an array of devices
 *  2. MIKROTIK_DEVICES — the same JSON array inline
 *  3. MIKROTIK_HOST / MIKROTIK_USERNAME / MIKROTIK_PASSWORD ... — a single device named "default"
 * MIKROTIK_READ_ONLY=true forces read-only mode on every device.
 */
export function loadDevices(env: NodeJS.ProcessEnv = process.env): DeviceConfig[] {
  let raw: unknown[];
  const configPath = envValue(env, "MIKROTIK_CONFIG");
  const devicesJson = envValue(env, "MIKROTIK_DEVICES");
  const host = envValue(env, "MIKROTIK_HOST");
  if (configPath) {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } else if (devicesJson) {
    raw = JSON.parse(devicesJson);
  } else if (host) {
    raw = [
      {
        name: "default",
        host,
        username: envValue(env, "MIKROTIK_USERNAME", "MIKROTIK_USER"),
        // Passwords are taken verbatim (no trimming), but placeholders still count as unset.
        password: env.MIKROTIK_PASSWORD && !/^\$\{[^}]*\}$/.test(env.MIKROTIK_PASSWORD) ? env.MIKROTIK_PASSWORD : undefined,
        transport: envValue(env, "MIKROTIK_TRANSPORT")?.toLowerCase(),
        port: numberValue("MIKROTIK_PORT", envValue(env, "MIKROTIK_PORT")),
        tls: bool(envValue(env, "MIKROTIK_TLS")),
        insecure: bool(envValue(env, "MIKROTIK_INSECURE")),
        readOnly: bool(envValue(env, "MIKROTIK_READ_ONLY")),
        timeoutMs: numberValue("MIKROTIK_TIMEOUT_MS", envValue(env, "MIKROTIK_TIMEOUT_MS")),
      },
    ];
  } else {
    raw = [];
  }
  if (!Array.isArray(raw)) throw new Error("MikroTik device config must be a JSON array");
  const forceReadOnly = bool(envValue(env, "MIKROTIK_READ_ONLY")) === true;
  const devices = raw.map((d) => {
    const parsed = finalize(DeviceSchema.parse(stripUndefined(d)));
    return forceReadOnly ? { ...parsed, readOnly: true } : parsed;
  });
  const names = new Set<string>();
  for (const d of devices) {
    if (names.has(d.name)) throw new Error(`Duplicate device name "${d.name}"`);
    names.add(d.name);
  }
  return devices;
}

function stripUndefined(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
}

export function createClient(d: DeviceConfig): RosClient {
  const problem = configProblem(d);
  if (problem) throw problem;
  const common = {
    host: d.host,
    port: d.port,
    username: d.username,
    password: d.password,
    insecure: d.insecure,
    timeoutMs: d.timeoutMs,
  };
  return d.transport === "api"
    ? new ApiClient({ ...common, tls: d.tls })
    : new RestClient({ ...common, tls: d.tls });
}

/** Holds one lazily created client per configured device. */
export class DeviceRegistry {
  private readonly clients = new Map<string, RosClient>();
  /** Set when the configuration could not be read, so tools can report it instead of the server failing to start. */
  configError?: Error;

  constructor(
    readonly devices: DeviceConfig[],
    private readonly factory: (d: DeviceConfig) => RosClient = createClient,
  ) {}

  /** Finds a device by name (or the default) without connecting. */
  lookup(name?: string): DeviceConfig {
    if (this.configError) {
      throw new RosError("The connector settings are invalid", this.configError.message);
    }
    if (this.devices.length === 0) {
      throw new RosError(
        "No MikroTik devices configured",
        "enter the router address, port, user name and password in the connector settings " +
          "(or set MIKROTIK_HOST/MIKROTIK_PORT/MIKROTIK_USERNAME/MIKROTIK_PASSWORD)",
      );
    }
    const device = name ? this.devices.find((d) => d.name === name) : this.devices[0];
    if (!device) {
      throw new RosError(`Unknown device "${name}"`, `known devices: ${this.devices.map((d) => d.name).join(", ")}`);
    }
    return device;
  }

  resolve(name?: string): { device: DeviceConfig; client: RosClient } {
    const device = this.lookup(name);
    let client = this.clients.get(device.name);
    if (!client) {
      client = this.factory(device);
      this.clients.set(device.name, client);
    }
    return { device, client };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }
}
