import type { DeviceConfig } from "./config.js";
import type { RosClient } from "./clients/types.js";

/**
 * Turns a low-level connection or login error into a plain-language
 * explanation of the likely cause and how to fix it. Returns undefined for
 * errors that are not about reaching or logging in to the router.
 */
export function explainError(err: unknown, d: DeviceConfig): string | undefined {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = (err as { status?: number } | undefined)?.status;
  const where = `${d.host}:${d.port}`;
  const service = serviceName(d);
  const enable =
    service === "api" || service === "api-ssl"
      ? `/ip service set ${service} disabled=no port=${d.port}` + (service === "api-ssl" ? " certificate=<your-certificate>" : "")
      : `/ip service set ${service} disabled=no` + (service === "www-ssl" ? " certificate=<your-certificate>" : "");

  if (/enotfound|eai_again|getaddrinfo/.test(msg)) {
    return `The name "${d.host}" could not be found in DNS. Check the spelling, or enter the router's IP address instead.`;
  }
  if (/econnrefused/.test(msg)) {
    return (
      `${where} refused the connection, so the ${service} service is off or on a different port. ` +
      `In the router terminal run "/ip service print" to see which services are on and their ports, and turn this one on with: ${enable}. ` +
      `If you reach the router through port forwarding, forward port ${d.port} as well. ` +
      `Note that WinBox (port 8291) is a different service the connector cannot use.`
    );
  }
  if (/certificate|self[- ]signed|unable to verify|altnames/.test(msg)) {
    return (
      `The router's TLS certificate is not trusted (MikroTik routers normally use a self-signed one). ` +
      `Turn on "Accept self-signed certificate" in the connector settings, or set MIKROTIK_INSECURE=true. The connection stays encrypted.`
    );
  }
  if (/wrong version number|packet length too long|unknown protocol|eproto|tls.*alert/.test(msg)) {
    return (
      `Port ${d.port} does not speak ${d.tls ? "TLS" : "plain text"}. ` +
      `Use 8728 for the plain API, 8729 for API-SSL, 443 for HTTPS or 80 for HTTP.`
    );
  }
  if (/invalid user name or password|cannot log ?in|unauthorized|login failure/.test(msg) || status === 401) {
    return (
      `The router rejected the user name or password. Check them, and check that the user's group has the ` +
      `"api"${d.transport === "rest" ? ' and "rest-api"' : ""} policy: run "/user print" and "/user group print" in the router terminal.`
    );
  }
  if (/not enough permissions/.test(msg) || status === 403) {
    return `The RouterOS user is missing a policy this action needs (for example "write", "reboot" or "sensitive"). Check "/user group print".`;
  }
  if (/closed by router|econnreset|socket hang up|disconnected before secure|router closed the session/.test(msg)) {
    return (
      `The router accepted the connection to ${where} and closed it straight away. The usual cause is the service's ` +
      `"available-from" list: the router only accepts the ${service} service from the addresses listed there. ` +
      `Run "/ip service print" and check that the IP address this computer connects from is allowed. ` +
      `If "${d.host}" is a DNS name that points at your public IP, the router sees your public IP instead of your LAN address, ` +
      `so use the router's LAN or VPN address instead. A TLS mismatch causes the same symptom: 8728 is plain, 8729 is TLS.`
    );
  }
  if (/timed out|timeout|etimedout|ehostunreach|enetunreach/.test(msg)) {
    const loginStage = /login failed/.test(msg);
    return loginStage
      ? `${where} accepted the connection but never answered the RouterOS API login, so this port is probably not the API service ` +
          `(for example it is WinBox on 8291 or the web interface). Use 8728 (API), 8729 (API-SSL) or 443 (REST).`
      : `No answer from ${where}. The address may be wrong or unreachable from this computer (different network, VPN off, ` +
          `no port forwarding), or a firewall is dropping it. Test it from this computer with ` +
          `"Test-NetConnection ${d.host} -Port ${d.port}" (Windows PowerShell) or "nc -vz ${d.host} ${d.port}" (macOS/Linux).`;
  }
  if (/non-json|http 404|no such command/.test(msg) && d.transport === "rest") {
    return (
      `Port ${d.port} answers HTTP but is not the RouterOS REST API. REST needs RouterOS 7.1 or newer; ` +
      `on RouterOS 6 use port 8728 (API) instead.`
    );
  }
  return undefined;
}

function serviceName(d: DeviceConfig): string {
  if (d.transport === "api") return d.tls ? "api-ssl" : "api";
  return d.tls ? "www-ssl" : "www";
}

export interface ConnectionReport {
  ok: boolean;
  device: string;
  host: string;
  port: number;
  transport: string;
  tls: boolean;
  readOnly: boolean;
  identity?: string;
  version?: string;
  board?: string;
  error?: string;
  howToFix?: string;
}

/** Logs in and reads the router identity, returning a report instead of throwing. */
export async function checkConnection(d: DeviceConfig, getClient: () => RosClient): Promise<ConnectionReport> {
  const base = {
    device: d.name,
    host: d.host,
    port: d.port,
    transport: d.transport === "api" ? (d.tls ? "api-ssl" : "api") : d.tls ? "rest (https)" : "rest (http)",
    tls: d.tls,
    readOnly: d.readOnly,
  };
  try {
    const client = getClient();
    const identity = await client.run("/system/identity/print");
    const resource = await client.run("/system/resource/print");
    return {
      ok: true,
      ...base,
      identity: identity.rows[0]?.name,
      version: resource.rows[0]?.version,
      board: resource.rows[0]?.["board-name"],
    };
  } catch (e) {
    return { ok: false, ...base, error: e instanceof Error ? e.message : String(e), howToFix: explainError(e, d) };
  }
}
