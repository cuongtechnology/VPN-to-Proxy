export type Protocol =
  "wireguard" | "http" | "https" | "socks5" | "socks4" | "socks4a" | "direct";
export type Outbound = {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username?: string;
  wireguard?: { address: string; peerPublicKey: string; dns: string; allowedIPs?: string[] };
};
export type Client = {
  id: string;
  name: string;
  kind: "vpn" | "proxy";
  identity: string;
  outboundId: string;
  serverId?: string;
  address?: string;
  publicKey?: string;
};
export type Listener = {
  id: string;
  name: string;
  protocol: "mixed" | "http" | "socks5" | "socks4";
  host: string;
  port: number;
  clientId: string;
  auth: boolean;
};
export type VPNServer = {
  id: string;
  name: string;
  address: string;
  port: number;
  endpoint: string;
  publicKey: string;
};
export type Config = {
  version: 1;
  outbounds: Outbound[];
  clients: Client[];
  listeners?: Listener[];
  servers?: VPNServer[];
};
export const emptyConfig = (): Config => ({
  version: 1,
  outbounds: [],
  clients: [],
});
export type ErrorCode =
  | "invalidConfig"
  | "invalidName"
  | "invalidEndpoint"
  | "duplicateIdentity"
  | "missingOutbound"
  | "inUse";
export class ConfigError extends Error {
  constructor(public code: ErrorCode) {
    super(code);
  }
}
const fail = (code: ErrorCode): never => {
  throw new ConfigError(code);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const shortText = (v: unknown, max = 100): v is string =>
  typeof v === "string" &&
  v.trim().length > 0 &&
  v.length <= max &&
  !/[\x00-\x1f\x7f]/.test(v);
export function validHost(host: string): boolean {
  if (!host || host.length > 253 || /[\s/@?#]/.test(host)) return false;
  if (host.includes(":")) {
    try {
      return new URL(`http://[${host}]/`).hostname.startsWith("[");
    } catch {
      return false;
    }
  }
  if (/^[\d.]+$/.test(host))
    return (
      host.split(".").length === 4 &&
      host
        .split(".")
        .every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
    );
  return host
    .split(".")
    .every((p) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(p));
}
export function validateConfig(value: unknown): Config {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.outbounds) ||
    !Array.isArray(value.clients) ||
    value.outbounds.length > 1000 ||
    value.clients.length > 10000
  )
    return fail("invalidConfig");
  const ids = new Set<string>();
  const identity = new Set<string>();
  for (const o of value.outbounds) {
    if (!isObject(o) || !shortText(o.id) || ids.has(o.id))
      return fail("invalidConfig");
    ids.add(o.id);
    if (!shortText(o.name)) return fail("invalidName");
    if (
      ![
        "wireguard",
        "http",
        "https",
        "socks5",
        "socks4",
        "socks4a",
        "direct",
      ].includes(String(o.protocol)) ||
      (o.protocol !== "direct" &&
        (typeof o.host !== "string" ||
          !validHost(o.host) ||
          !Number.isInteger(o.port) ||
          Number(o.port) < 1 ||
          Number(o.port) > 65535))
    )
      return fail("invalidEndpoint");
  }
  const clientIds = new Set<string>();
  for (const c of value.clients) {
    if (
      !isObject(c) ||
      !shortText(c.id) ||
      clientIds.has(c.id) ||
      !["vpn", "proxy"].includes(String(c.kind)) ||
      !shortText(c.identity, 256)
    )
      return fail("invalidConfig");
    clientIds.add(c.id);
    if (!shortText(c.name)) return fail("invalidName");
    const key = `${c.kind}:${c.identity}`;
    if (identity.has(key)) return fail("duplicateIdentity");
    identity.add(key);
    if (
      typeof c.outboundId !== "string" ||
      (c.outboundId !== "" && !ids.has(c.outboundId))
    )
      return fail("missingOutbound");
  }
  if (value.listeners !== undefined) {
    if (!Array.isArray(value.listeners) || value.listeners.length > 1000)
      return fail("invalidConfig");
    const listenerIds = new Set<string>();
    for (const l of value.listeners) {
      if (
        !isObject(l) ||
        !shortText(l.id) ||
        listenerIds.has(l.id) ||
        !shortText(l.name) ||
        typeof l.host !== "string" ||
        !validHost(l.host) ||
        !Number.isInteger(l.port) ||
        Number(l.port) < 1 ||
        Number(l.port) > 65535 ||
        !["mixed", "http", "socks5", "socks4"].includes(String(l.protocol)) ||
        !clientIds.has(String(l.clientId)) ||
        typeof l.auth !== "boolean"
      )
        return fail("invalidConfig");
      listenerIds.add(l.id);
    }
  }
  if (value.servers !== undefined) {
    if (!Array.isArray(value.servers) || value.servers.length > 1000)
      return fail("invalidConfig");
    const serverIds = new Set<string>();
    for (const s of value.servers) {
      if (
        !isObject(s) ||
        !shortText(s.id) ||
        serverIds.has(s.id) ||
        !shortText(s.name) ||
        !shortText(s.address) ||
        !shortText(s.publicKey) ||
        typeof s.endpoint !== "string" ||
        !validHost(s.endpoint) ||
        !Number.isInteger(s.port) ||
        Number(s.port) < 1 ||
        Number(s.port) > 65535
      )
        return fail("invalidConfig");
      serverIds.add(s.id);
    }
  }
  // Persist only known, non-secret fields, including when reading imported data.
  return {
    version: 1,
    outbounds: value.outbounds.map((o) => ({
      id: o.id,
      name: o.name,
      protocol: o.protocol,
      host: o.host,
      port: o.port,
      ...(o.username ? { username: o.username } : {}),
      ...(o.wireguard
        ? {
            wireguard: {
              address: o.wireguard.address,
              peerPublicKey: o.wireguard.peerPublicKey,
              dns: o.wireguard.dns,
              ...(o.wireguard.allowedIPs ? { allowedIPs: o.wireguard.allowedIPs } : {}),
            },
          }
        : {}),
    })),
    clients: value.clients.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      identity: c.identity,
      outboundId: c.outboundId,
      ...(c.serverId
        ? { serverId: c.serverId, address: c.address, publicKey: c.publicKey }
        : {}),
    })),
    ...(Array.isArray(value.listeners)
      ? {
          listeners: value.listeners.map((l) => ({
            id: l.id,
            name: l.name,
            host: l.host,
            port: l.port,
            protocol: l.protocol,
            clientId: l.clientId,
            auth: l.auth,
          })),
        }
      : {}),
    ...(Array.isArray(value.servers)
      ? {
          servers: value.servers.map((s) => ({
            id: s.id,
            name: s.name,
            address: s.address,
            port: s.port,
            endpoint: s.endpoint,
            publicKey: s.publicKey,
          })),
        }
      : {}),
  };
}
export function deleteOutbound(config: Config, id: string): Config {
  if (config.clients.some((c) => c.outboundId === id)) return fail("inUse");
  return validateConfig({
    ...config,
    outbounds: config.outbounds.filter((o) => o.id !== id),
  });
}
export function routePreview(
  config: Config,
  clientId: string,
): { action: "block" | "assigned"; outbound?: Outbound } {
  const client = config.clients.find((c) => c.id === clientId);
  const outbound = config.outbounds.find((o) => o.id === client?.outboundId);
  return outbound ? { action: "assigned", outbound } : { action: "block" };
}
export function canForward(
  config: Config,
  clientId: string,
  availableOutbounds: ReadonlySet<string>,
): boolean {
  try {
    validateConfig(config);
  } catch {
    return false;
  }
  const decision = routePreview(config, clientId);
  return !!decision.outbound && availableOutbounds.has(decision.outbound.id);
}
