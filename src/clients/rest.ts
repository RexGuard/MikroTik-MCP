import http from "node:http";
import https from "node:https";
import { assertCommand, RosClient, RosError, RosRecord, RosResult, RunOptions } from "./types.js";

export interface RestClientOptions {
  host: string;
  port?: number;
  username: string;
  password: string;
  /** Use HTTPS (default true). RouterOS only enables REST on `www-ssl` unless you also enable `www`. */
  tls?: boolean;
  /** Accept self-signed certificates. */
  insecure?: boolean;
  timeoutMs?: number;
}

/**
 * Client for the RouterOS v7 REST API (`/rest/...`).
 * Every command is sent as `POST /rest/<menu>/<command>`, which RouterOS
 * documents as the universal way to reach any console command.
 */
export class RestClient implements RosClient {
  private readonly agent: http.Agent;
  private readonly tls: boolean;
  private readonly port: number;
  private readonly auth: string;

  constructor(private readonly opts: RestClientOptions) {
    this.tls = opts.tls ?? true;
    this.port = opts.port ?? (this.tls ? 443 : 80);
    this.auth = "Basic " + Buffer.from(`${opts.username}:${opts.password}`).toString("base64");
    this.agent = this.tls
      ? new https.Agent({ keepAlive: true, rejectUnauthorized: !opts.insecure })
      : new http.Agent({ keepAlive: true });
  }

  async run(command: string, options: RunOptions = {}): Promise<RosResult> {
    const path = assertCommand(command);
    const body: Record<string, unknown> = { ...(options.args ?? {}) };
    if (options.proplist?.length) body[".proplist"] = options.proplist;
    if (options.query?.length) body[".query"] = options.query;

    const { status, text } = await this.request("POST", `/rest${path}`, JSON.stringify(body));
    let data: unknown = undefined;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        if (status >= 400) throw new RosError(`HTTP ${status}`, text.slice(0, 500), status);
        throw new RosError("Router returned a non-JSON response", text.slice(0, 500), status);
      }
    }
    if (status >= 400) {
      const err = (data ?? {}) as { message?: string; detail?: string };
      throw new RosError(err.message ?? `HTTP ${status}`, err.detail, status);
    }
    return normalize(data);
  }

  async close(): Promise<void> {
    this.agent.destroy();
  }

  private request(method: string, path: string, body: string): Promise<{ status: number; text: string }> {
    const lib = this.tls ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          host: this.opts.host,
          port: this.port,
          method,
          path,
          agent: this.agent,
          headers: {
            Authorization: this.auth,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: this.opts.timeoutMs ?? 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new RosError(`Request to ${this.opts.host} timed out`)));
      req.on("error", (e) => reject(e instanceof RosError ? e : new RosError(`Cannot reach ${this.opts.host}`, e.message)));
      req.end(body);
    });
  }
}

function toRecord(value: unknown): RosRecord {
  const out: RosRecord = {};
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

function normalize(data: unknown): RosResult {
  if (Array.isArray(data)) return { rows: data.map(toRecord) };
  if (data && typeof data === "object") {
    const rec = toRecord(data);
    if ("ret" in rec && Object.keys(rec).length === 1) return { rows: [], ret: rec.ret };
    return { rows: [rec] };
  }
  return { rows: [] };
}
