const net = require("node:net");
const { randomUUID } = require("node:crypto");
const error = (code) => {
  throw new Error(code);
};
const text = (s, n = 100) =>
  typeof s === "string" &&
  s.trim().length > 0 &&
  s.length <= n &&
  !/[\x00-\x1f\x7f]/.test(s);
const id = (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
const host = (s) =>
  typeof s === "string" &&
  (net.isIP(s) ||
    (s.length <= 253 &&
      !/^[\d.]+$/.test(s) &&
      s
        .split(".")
        .every((p) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(p))));
const port = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const key = (s) =>
  typeof s === "string" &&
  /^[A-Za-z0-9+/]{43}=$/.test(s) &&
  Buffer.from(s, "base64").length === 32;
const cidr = (s) => {
  if (typeof s !== "string") return false;
  const [ip, bits, extra] = s.split("/");
  const family = net.isIP(ip);
  return (
    !extra &&
    family &&
    /^\d+$/.test(bits) &&
    Number(bits) <= (family === 4 ? 32 : 128)
  );
};
const loopback = (s) => s === "::1" || /^127\./.test(s);
const empty = () => ({
  version: 1,
  outbounds: [],
  clients: [],
  listeners: [],
  servers: [],
});
function validate(raw) {
  if (
    !raw ||
    raw.version !== 1 ||
    !Array.isArray(raw.outbounds) ||
    !Array.isArray(raw.clients)
  )
    error("invalidConfig");
  const value = {
    ...raw,
    listeners: raw.listeners ?? [],
    servers: raw.servers ?? [],
  };
  const known = new Set([
    "version",
    "outbounds",
    "clients",
    "listeners",
    "servers",
  ]);
  for (const k of Object.keys(value)) if (!known.has(k)) delete value[k];
  for (const list of [
    value.outbounds,
    value.clients,
    value.listeners,
    value.servers,
  ]) {
    if (!Array.isArray(list) || list.length > 1000) error("invalidConfig");
    const ids = new Set();
    for (const item of list) {
      if (!item || !id(item.id) || ids.has(item.id) || !text(item.name))
        error("invalidConfig");
      ids.add(item.id);
    }
  }
  value.outbounds = value.outbounds.map((o) => {
    if (
      ![
        "direct",
        "wireguard",
        "http",
        "https",
        "socks5",
        "socks4",
        "socks4a",
      ].includes(o.protocol)
    )
      error("invalidEndpoint");
    if (o.protocol !== "direct" && (!host(o.host) || !port(o.port)))
      error("invalidEndpoint");
    if (o.username && !text(o.username, 255)) error("invalidConfig");
    const result = {
      id: o.id,
      name: o.name,
      protocol: o.protocol,
      host: o.host || "",
      port: o.port || 0,
      username: o.username || "",
    };
    if (o.protocol === "wireguard" && o.wireguard) {
      if (
        !cidr(o.wireguard.address) ||
        !key(o.wireguard.peerPublicKey) ||
        !net.isIP(o.wireguard.dns)
      )
        error("invalidWireGuard");
      // IP endpoints prevent endpoint DNS from taking an unintended host route.
      if (!net.isIP(o.host)) error("vpnEndpointIP");
      if (o.wireguard.allowedIPs && (!Array.isArray(o.wireguard.allowedIPs) || !o.wireguard.allowedIPs.length || !o.wireguard.allowedIPs.every(cidr))) error('invalidWireGuard');
      result.wireguard = {
        address: o.wireguard.address,
        peerPublicKey: o.wireguard.peerPublicKey,
        dns: o.wireguard.dns,
        ...(o.wireguard.allowedIPs ? { allowedIPs: [...o.wireguard.allowedIPs] } : {}),
      };
    }
    return result;
  });
  const servers = new Set(value.servers.map((s) => s.id));
  const outbounds = new Set(value.outbounds.map((o) => o.id));
  const identities = new Set();
  const peerAddresses = new Set();
  value.clients = value.clients.map((c) => {
    if (
      !["vpn", "proxy"].includes(c.kind) ||
      !text(c.identity, 255) ||
      (c.outboundId && !outbounds.has(c.outboundId))
    )
      error("invalidConfig");
    const identity = c.kind + ":" + c.identity;
    if (identities.has(identity)) error("duplicateIdentity");
    identities.add(identity);
    const result = {
      id: c.id,
      name: c.name,
      kind: c.kind,
      identity: c.identity,
      outboundId: c.outboundId || "",
    };
    if (c.kind === "vpn" && c.serverId) {
      if (!servers.has(c.serverId) || !net.isIP(c.address) || !key(c.publicKey))
        error("invalidWireGuard");
      const address = c.serverId + ":" + c.address;
      if (peerAddresses.has(address)) error("duplicateIdentity");
      peerAddresses.add(address);
      Object.assign(result, {
        serverId: c.serverId,
        address: c.address,
        publicKey: c.publicKey,
      });
    }
    return result;
  });
  const clients = new Map(value.clients.map((c) => [c.id, c]));
  const bindings = new Set();
  value.listeners = value.listeners.map((l) => {
    if (
      !net.isIP(l.host) ||
      !port(l.port) ||
      !["mixed", "http", "socks5", "socks4"].includes(l.protocol) ||
      clients.get(l.clientId)?.kind !== "proxy" ||
      typeof l.auth !== "boolean"
    )
      error("invalidListener");
    if (!loopback(l.host) && !l.auth) error("authRequired");
    if (l.protocol === "socks4" && l.auth) error("socks4Auth");
    const binding = l.host + ":" + l.port;
    if (bindings.has(binding)) error("duplicateListener");
    bindings.add(binding);
    return {
      id: l.id,
      name: l.name,
      host: l.host,
      port: l.port,
      protocol: l.protocol,
      clientId: l.clientId,
      auth: l.auth,
    };
  });
  const udpPorts = new Set();
  value.servers = value.servers.map((s) => {
    if (
      !cidr(s.address) ||
      !port(s.port) ||
      !key(s.publicKey) ||
      !host(s.endpoint)
    )
      error("invalidWireGuard");
    if (udpPorts.has(s.port)) error("duplicateListener");
    udpPorts.add(s.port);
    return {
      id: s.id,
      name: s.name,
      address: s.address,
      port: s.port,
      publicKey: s.publicKey,
      endpoint: s.endpoint,
    };
  });
  return value;
}
module.exports = {
  validate,
  empty,
  key,
  cidr,
  loopback,
  host,
  port,
  id,
  randomUUID,
};
