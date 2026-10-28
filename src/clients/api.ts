import net from "node:net";
import tls from "node:tls";
import { assertCommand, RosClient, RosError, RosRecord, RosResult, RunOptions } from "./types.js";

export interface ApiClientOptions {
  host: string;
  port?: number;
  username: string;
  password: string;
  /** Use API-SSL (port 8729) instead of plain API (port 8728). */
  tls?: boolean;
  insecure?: boolean;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Wire format: a sentence is a list of length-prefixed words ended by an empty word.
// https://help.mikrotik.com/docs/display/ROS/API
// ---------------------------------------------------------------------------

export function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  if (len < 0x10000000) return Buffer.from([(len >>> 24) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([0xf0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

export function encodeSentence(words: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const w of words) {
    const b = Buffer.from(w, "utf8");
    parts.push(encodeLength(b.length), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Incrementally decodes sentences from a byte stream. */
export class SentenceDecoder {
  private buf = Buffer.alloc(0);
  private words: string[] = [];

  push(chunk: Buffer): string[][] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const sentences: string[][] = [];
    for (;;) {
      const header = this.readLength();
      if (!header) break;
      const [len, hdrSize] = header;
      if (this.buf.length < hdrSize + len) break;
      const word = this.buf.subarray(hdrSize, hdrSize + len).toString("utf8");
      this.buf = this.buf.subarray(hdrSize + len);
      if (len === 0) {
        sentences.push(this.words);
        this.words = [];
      } else {
        this.words.push(word);
      }
    }
    return sentences;
  }

  private readLength(): [number, number] | undefined {
    const b = this.buf;
    if (b.length < 1) return undefined;
    const c = b[0];
    if ((c & 0x80) === 0) return [c, 1];
    if ((c & 0xc0) === 0x80) return b.length < 2 ? undefined : [((c & 0x3f) << 8) | b[1], 2];
    if ((c & 0xe0) === 0xc0) return b.length < 3 ? undefined : [((c & 0x1f) << 16) | (b[1] << 8) | b[2], 3];
    if ((c & 0xf0) === 0xe0)
      return b.length < 4 ? undefined : [((c & 0x0f) * 0x1000000) + ((b[1] << 16) | (b[2] << 8) | b[3]), 4];
    return b.length < 5 ? undefined : [b.readUInt32BE(1), 5];
  }
}

/** Splits `=key=value` into `[key, value]` (values may contain `=`). */
export function parseAttribute(word: string): [string, string] | undefined {
  if (!word.startsWith("=")) return undefined;
  const i = word.indexOf("=", 1);
  return i < 0 ? [word.slice(1), ""] : [word.slice(1, i), word.slice(i + 1)];
}

// ---------------------------------------------------------------------------

interface Pending {
  rows: RosRecord[];
  ret?: string;
  trap?: RosRecord;
  resolve: (r: RosResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client for the RouterOS binary API (ports 8728 / 8729). Works on RouterOS v6
 * and v7. Requests are multiplexed over one connection using `.tag`.
 */
export class ApiClient implements RosClient {
  private socket?: net.Socket;
  private connecting?: Promise<void>;
  private nextTag = 1;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: ApiClientOptions) {}

  async run(command: string, options: RunOptions = {}): Promise<RosResult> {
    const path = assertCommand(command);
    await this.ensureConnected();
    const words = [path];
    for (const [k, v] of Object.entries(options.args ?? {})) words.push(`=${k}=${v}`);
    if (options.proplist?.length) words.push(`=.proplist=${options.proplist.join(",")}`);
    for (const q of options.query ?? []) words.push(q.startsWith("?") ? q : `?${q}`);
    return this.send(words);
  }

  async close(): Promise<void> {
    this.failAll(new RosError("Connection closed"));
    this.socket?.destroy();
    this.socket = undefined;
    this.connecting = undefined;
  }

  private ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.connect().catch((e) => {
        this.connecting = undefined;
        throw e;
      });
    }
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const useTls = this.opts.tls ?? false;
    const port = this.opts.port ?? (useTls ? 8729 : 8728);
    const timeout = this.opts.timeoutMs ?? 30_000;

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const onError = (e: Error) => reject(new RosError(`Cannot reach ${this.opts.host}:${port}`, e.message));
      const s = useTls
        ? tls.connect({ host: this.opts.host, port, rejectUnauthorized: !this.opts.insecure }, () => resolve(s))
        : net.connect({ host: this.opts.host, port }, () => resolve(s));
      s.setTimeout(timeout, () => s.destroy(new Error("connect timeout")));
      s.once("error", onError);
    });
    socket.setTimeout(0);
    socket.removeAllListeners("error");

    const decoder = new SentenceDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const sentence of decoder.push(chunk)) this.onSentence(sentence);
    });
    socket.on("error", (e) => this.failAll(new RosError("Connection error", e.message)));
    socket.on("close", () => {
      this.failAll(new RosError("Connection closed by router"));
      if (this.socket === socket) {
        this.socket = undefined;
        this.connecting = undefined;
      }
    });
    this.socket = socket;

    // Post-6.43 login: plain-text credentials (use API-SSL on untrusted networks).
    await this.send(["/login", `=name=${this.opts.username}`, `=password=${this.opts.password}`]).catch((e) => {
      socket.destroy();
      throw new RosError("Login failed", e instanceof Error ? e.message : String(e));
    });
  }

  private send(words: string[]): Promise<RosResult> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new RosError("Not connected"));
    const tag = String(this.nextTag++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tag);
        socket.write(encodeSentence(["/cancel", `=tag=${tag}`]));
        reject(new RosError(`Command ${words[0]} timed out`));
      }, this.opts.timeoutMs ?? 30_000);
      this.pending.set(tag, { rows: [], resolve, reject, timer });
      socket.write(encodeSentence([...words, `.tag=${tag}`]));
    });
  }

  private onSentence(words: string[]): void {
    const [reply, ...rest] = words;
    const attrs: RosRecord = {};
    let tag: string | undefined;
    for (const w of rest) {
      if (w.startsWith(".tag=")) tag = w.slice(5);
      else {
        const kv = parseAttribute(w);
        if (kv) attrs[kv[0]] = kv[1];
      }
    }
    if (reply === "!fatal") {
      this.failAll(new RosError("Router closed the session", rest.join(" ")));
      return;
    }
    const p = tag ? this.pending.get(tag) : undefined;
    if (!p || !tag) return;

    switch (reply) {
      case "!re":
        p.rows.push(attrs);
        break;
      case "!trap":
        p.trap = attrs;
        break;
      case "!empty": // RouterOS 7.18+ sends !empty before !done when nothing matched
        break;
      case "!done":
        clearTimeout(p.timer);
        this.pending.delete(tag);
        if (p.trap) p.reject(new RosError(p.trap.message ?? "Command failed", p.trap.category ? `category ${p.trap.category}` : undefined));
        else p.resolve({ rows: p.rows, ret: attrs.ret });
        break;
    }
  }

  private failAll(err: Error): void {
    for (const [tag, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(tag);
    }
  }
}
