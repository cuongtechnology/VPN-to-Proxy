const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const { key } = require("./config.cjs");
function keyPair() {
  const pair = crypto.generateKeyPairSync("x25519");
  return {
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .subarray(-32)
      .toString("base64"),
    publicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
  };
}
function parseProfile(text) {
  if (typeof text !== "string" || text.length > 65536)
    throw new Error("invalidWireGuard");
  const sections = [];
  let section;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    if (/^\[(Interface|Peer)\]$/.test(line)) {
      section = { type: line.slice(1, -1) };
      sections.push(section);
      continue;
    }
    const i = line.indexOf("=");
    if (!section || i < 0) throw new Error("invalidWireGuard");
    const name = line.slice(0, i).trim(),
      value = line.slice(i + 1).trim();
    if (["PreUp", "PostUp", "PreDown", "PostDown"].includes(name))
      throw new Error("profileCommandsRejected");
    if (section[name] !== undefined) throw new Error("invalidWireGuard");
    section[name] = value;
  }
  const iface = sections.find((s) => s.type === "Interface"),
    peers = sections.filter((s) => s.type === "Peer");
  if (
    !iface ||
    peers.length !== 1 ||
    !key(iface.PrivateKey) ||
    !key(peers[0].PublicKey)
  )
    throw new Error("invalidWireGuard");
  const peer = peers[0];
  if ((iface.Address || '').split(',').length !== 1) throw new Error('invalidWireGuard');
  const allowedIPs = (peer.AllowedIPs || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowedIPs.length || !allowedIPs.every(require('./config.cjs').cidr)) throw new Error('invalidWireGuard');
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(peer.Endpoint || "");
  if (!match) throw new Error("invalidEndpoint");
  return {
    host: match[1] || match[2],
    port: Number(match[3]),
    wireguard: {
      address: (iface.Address || "").split(",")[0].trim(),
      dns: (iface.DNS || "1.1.1.1").split(",")[0].trim(),
      peerPublicKey: peer.PublicKey,
      allowedIPs,
    },
    secret: {
      privateKey: iface.PrivateKey,
      ...(peer.PresharedKey ? { psk: peer.PresharedKey } : {}),
    },
  };
}
const prefix = (address) => `${address}/${net.isIP(address) === 6 ? 128 : 32}`;
function compile(store) {
  const c = store.config;
  const result = {
    log: { level: "error", timestamp: true },
    dns: { servers: [{ type: "local", tag: "bootstrap" }], rules: [] },
    inbounds: [],
    outbounds: [],
    endpoints: [],
    route: { default_domain_resolver: "bootstrap", rules: [] },
  };
  for (const o of c.outbounds) {
    const tag = `out:${o.id}`,
      secret = store.secret("outbound", o.id);
    if (o.protocol === "wireguard") {
      if (!o.wireguard) throw new Error("invalidWireGuard");
      if (!key(secret.privateKey)) throw new Error("missingPrivateKey");
      result.endpoints.push({
        type: "wireguard",
        tag,
        system: false,
        address: [o.wireguard.address],
        private_key: secret.privateKey,
        peers: [
          {
            address: o.host,
            port: o.port,
            public_key: o.wireguard.peerPublicKey,
            ...(secret.psk ? { pre_shared_key: secret.psk } : {}),
            allowed_ips: o.wireguard.allowedIPs || ["0.0.0.0/0", "::/0"],
            persistent_keepalive_interval: 25,
          },
        ],
      });
    } else if (o.protocol === "direct")
      result.outbounds.push({ type: "direct", tag });
    else
      result.outbounds.push({
        type: o.protocol.startsWith("socks") ? "socks" : "http",
        tag,
        server: o.host,
        server_port: o.port,
        ...(o.protocol.startsWith("socks")
          ? {
              version:
                o.protocol === "socks5"
                  ? "5"
                  : o.protocol === "socks4a"
                    ? "4a"
                    : "4",
            }
          : {}),
        ...(o.username
          ? { username: o.username, password: secret.password || "" }
          : {}),
        ...(o.protocol === "https"
          ? { tls: { enabled: true, server_name: o.host } }
          : {}),
      });
    // Destination DNS travels through the same outbound, including TCP-only proxies.
    result.dns.servers.push({
      type: "tcp",
      tag: `dns:${o.id}`,
      server: o.wireguard?.dns || "1.1.1.1",
      ...(o.protocol === "direct" ? {} : { detour: tag }),
    });
  }
  function assign(match, outboundId) {
    if (!outboundId) {
      result.route.rules.push({ ...match, action: "reject" });
      return;
    }
    const server = `dns:${outboundId}`;
    result.dns.rules.push({ ...match, action: "route", server });
    result.route.rules.push(
      { ...match, port: 53, action: "hijack-dns" },
      { ...match, action: "resolve", server, strategy: "prefer_ipv4" },
      { ...match, action: "route", outbound: `out:${outboundId}` },
    );
  }
  for (const l of c.listeners) {
    const client = c.clients.find((c) => c.id === l.clientId);
    result.inbounds.push({
      type:
        l.protocol === "http"
          ? "http"
          : l.protocol === "mixed"
            ? "mixed"
            : "socks",
      tag: `in:${l.id}`,
      listen: l.host,
      listen_port: l.port,
      ...(l.auth
        ? {
            users: [
              {
                username: client.identity,
                password: store.secret("client", client.id).password,
              },
            ],
          }
        : {}),
    });
    assign({ inbound: [`in:${l.id}`] }, client.outboundId);
  }
  for (const s of c.servers) {
    const privateKey = store.secret("server", s.id).privateKey;
    if (!key(privateKey)) throw new Error("missingPrivateKey");
    const clients = c.clients.filter((c) => c.serverId === s.id);
    result.endpoints.push({
      type: "wireguard",
      tag: `vpn:${s.id}`,
      system: false,
      address: [s.address],
      listen_port: s.port,
      private_key: privateKey,
      peers: clients.map((c) => ({
        public_key: c.publicKey,
        allowed_ips: [prefix(c.address)],
      })),
    });
    for (const client of clients)
      assign(
        { inbound: [`vpn:${s.id}`], source_ip_cidr: [prefix(client.address)] },
        client.outboundId,
      );
  }
  result.route.rules.push({ action: "reject" });
  return result;
}
function exportPeer(store, clientId) {
  const client = store.config.clients.find((c) => c.id === clientId),
    server = store.config.servers.find((s) => s.id === client?.serverId);
  const privateKey = store.secret("client", clientId).privateKey;
  if (!client || !server || !key(privateKey))
    throw new Error("missingPrivateKey");
  const endpoint =
    net.isIP(server.endpoint) === 6 ? `[${server.endpoint}]` : server.endpoint;
  return `[Interface]\nPrivateKey = ${privateKey}\nAddress = ${prefix(client.address)}\nDNS = ${server.address.split("/")[0]}\n\n[Peer]\nPublicKey = ${server.publicKey}\nEndpoint = ${endpoint}:${server.port}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n`;
}
class VPNEngine {
  constructor(store) {
    this.store = store;
    this.child = null;
    this.state = "stopped";
    this.lastError = "";
  }
  async check(executable) {
    if (!executable || !(await fs.stat(executable).catch(() => null))?.isFile())
      throw new Error("vpnEngineRequired");
    const output = await this.run(executable, ["version"]);
    const version = /sing-box version (1\.(\d+)\.\d+)/.exec(output);
    if (!version || Number(version[2]) < 12)
      throw new Error("engineVersionUnsupported");
    return version[1];
  }
  run(executable, args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("engineTimeout"));
      }, 15000);
      child.stdout.on("data", (b) => {
        output = (output + b).slice(-65536);
      });
      child.stderr.on("data", () => {});
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("engineUnavailable"));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve(output)
          : reject(new Error("engineConfigRejected"));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input || "");
    });
  }
  async start(executable) {
    if (this.child) throw new Error("alreadyRunning");
    await this.check(executable);
    const input = JSON.stringify(compile(this.store));
    // sing-box's documented stdin configuration path keeps secrets off disk/argv.
    await this.run(executable, ["check", "-c", "stdin"], input);
    this.state = "starting";
    this.lastError = "";
    const child = spawn(executable, ["run", "-c", "stdin"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", () => {
      this.state = "error";
      this.lastError = "engineUnavailable";
      this.child = null;
    });
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        this.state = code === 0 ? "stopped" : "error";
        this.lastError = code === 0 ? "" : "engineExited";
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (!this.child) throw new Error(this.lastError || "engineExited");
    this.state = "running";
  }
  async stop() {
    const child = this.child;
    this.child = null;
    if (child)
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    this.state = "stopped";
  }
  status() {
    return { state: this.state, lastError: this.lastError };
  }
}
module.exports = { keyPair, parseProfile, compile, exportPeer, VPNEngine };
