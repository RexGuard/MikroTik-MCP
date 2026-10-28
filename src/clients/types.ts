/** A single RouterOS record, e.g. one row of `/ip/address/print`. */
export type RosRecord = Record<string, string>;

/** Result of running a RouterOS command. */
export interface RosResult {
  /** Rows returned by the command (print, ping, monitor, ...). */
  rows: RosRecord[];
  /** Value of `ret`, e.g. the `.id` of a newly added item. */
  ret?: string;
}

export interface RunOptions {
  /** Attribute arguments, e.g. `{ address: "10.0.0.1/24", interface: "ether1" }`. */
  args?: Record<string, string>;
  /** Query words in RouterOS API syntax without the leading `?`, e.g. `["type=ether", "disabled=false"]`. */
  query?: string[];
  /** Restrict the returned properties. */
  proplist?: string[];
}

/**
 * Minimal transport-independent RouterOS client. Every operation in RouterOS
 * (print, add, set, remove, ping, reboot, ...) is a command on a menu path, so
 * one primitive is enough for both the REST API and the binary API.
 */
export interface RosClient {
  /** Run `command`, e.g. `/ip/address/print` or `/system/reboot`. */
  run(command: string, options?: RunOptions): Promise<RosResult>;
  close(): Promise<void>;
}

export class RosError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly status?: number,
  ) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "RosError";
  }
}

/** RouterOS menu commands look like `/ip/firewall/filter/print`. */
const COMMAND_RE = /^(\/[a-z0-9][a-z0-9-]*)+$/;

export function assertCommand(command: string): string {
  const normalized = command.trim().replace(/\s+/g, "/").replace(/\/+/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const clean = withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
  if (!COMMAND_RE.test(clean)) {
    throw new RosError(`Invalid RouterOS command path "${command}"`);
  }
  return clean;
}
