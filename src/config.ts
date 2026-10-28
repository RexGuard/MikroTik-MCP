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
  transport: z.enum(["rest", "api"]).default("rest"),
  port: z.number().int().positive().optional(),
  tls: z.boolean().optional(),
  insecure: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(30_000),
});

export type DeviceConfig = z.infer<typeof DeviceSchema>;

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
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
  if (env.MIKROTIK_CONFIG) {
    raw = JSON.parse(readFileSync(env.MIKROTIK_CONFIG, "utf8"));
  } else if (env.MIKROTIK_DEVICES) {
    raw = JSON.parse(env.MIKROTIK_DEVICES);
  } else if (env.MIKROTIK_HOST) {
    raw = [
      {
        name: "default",
        host: env.MIKROTIK_HOST,
        username: env.MIKROTIK_USERNAME ?? env.MIKROTIK_USER,
        password: env.MIKROTIK_PASSWORD,
        transport: env.MIKROTIK_TRANSPORT?.toLowerCase(),
        port: env.MIKROTIK_PORT ? Number(env.MIKROTIK_PORT) : undefined,
        tls: bool(env.MIKROTIK_TLS),
        insecure: bool(env.MIKROTIK_INSECURE),
        timeoutMs: env.MIKROTIK_TIMEOUT_MS ? Number(env.MIKROTIK_TIMEOUT_MS) : undefined,
      },
    ];
  } else {
    raw = [];
  }
  if (!Array.isArray(raw)) throw new Error("MikroTik device config must be a JSON array");
  const forceReadOnly = bool(env.MIKROTIK_READ_ONLY) === true;
  const devices = raw.map((d) => {
    const parsed = DeviceSchema.parse(stripUndefined(d));
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
  const common = {
    host: d.host,
    port: d.port,
    username: d.username,
    password: d.password,
    insecure: d.insecure,
    timeoutMs: d.timeoutMs,
  };
  return d.transport === "api"
    ? new ApiClient({ ...common, tls: d.tls ?? false })
    : new RestClient({ ...common, tls: d.tls ?? true });
}

/** Holds one lazily created client per configured device. */
export class DeviceRegistry {
  private readonly clients = new Map<string, RosClient>();

  constructor(
    readonly devices: DeviceConfig[],
    private readonly factory: (d: DeviceConfig) => RosClient = createClient,
  ) {}

  resolve(name?: string): { device: DeviceConfig; client: RosClient } {
    if (this.devices.length === 0) {
      throw new RosError(
        "No MikroTik devices configured",
        "set MIKROTIK_HOST/MIKROTIK_USERNAME/MIKROTIK_PASSWORD or MIKROTIK_DEVICES",
      );
    }
    const device = name ? this.devices.find((d) => d.name === name) : this.devices[0];
    if (!device) {
      throw new RosError(`Unknown device "${name}"`, `known devices: ${this.devices.map((d) => d.name).join(", ")}`);
    }
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
