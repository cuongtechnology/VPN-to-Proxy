const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate, empty } = require("../config.cjs");
const { keyPair, parseProfile, compile, exportPeer } = require("../vpn.cjs");
test("rejects public unauthenticated listeners and dangling assignments", () => {
  const c = {
    ...empty(),
    clients: [
      { id: "c", name: "C", kind: "proxy", identity: "c", outboundId: "" },
    ],
    listeners: [
      {
        id: "l",
        name: "L",
        host: "0.0.0.0",
        port: 1080,
        protocol: "mixed",
        clientId: "c",
        auth: false,
      },
    ],
  };
  assert.throws(() => validate(c), /authRequired/);
  c.listeners = [];
  c.clients[0].outboundId = "missing";
  assert.throws(() => validate(c));
});
test("WireGuard import extracts keys without executing commands", () => {
  const a = keyPair(),
    b = keyPair();
  const profile = `[Interface]\nPrivateKey = ${a.privateKey}\nAddress = 10.7.0.2/32\nDNS = 1.1.1.1\n[Peer]\nPublicKey = ${b.publicKey}\nEndpoint = 192.0.2.1:51820\nAllowedIPs = 0.0.0.0/0`;
  const parsed = parseProfile(profile);
  assert.equal(parsed.port, 51820);
  assert.equal(parsed.secret.privateKey, a.privateKey);
  assert.equal(parsed.wireguard.address, "10.7.0.2/32");
  assert.throws(
    () =>
      parseProfile(
        profile.replace("[Peer]", "PostUp = arbitrary-command\n[Peer]"),
      ),
    /profileCommandsRejected/,
  );
});
test("VPN compiler pins peer source addresses, routes DNS through assigned outbound and rejects unmatched traffic", () => {
  const serverKeys = keyPair(),
    peerKeys = keyPair();
  const config = validate({
    ...empty(),
    outbounds: [
      {
        id: "o",
        name: "O",
        protocol: "socks5",
        host: "127.0.0.1",
        port: 10080,
      },
    ],
    servers: [
      {
        id: "s",
        name: "S",
        address: "10.7.0.1/24",
        port: 51820,
        endpoint: "vpn.example.com",
        publicKey: serverKeys.publicKey,
      },
    ],
    clients: [
      {
        id: "c",
        name: "C",
        kind: "vpn",
        identity: "phone",
        address: "10.7.0.2",
        serverId: "s",
        publicKey: peerKeys.publicKey,
        outboundId: "o",
      },
    ],
  });
  const store = {
    config,
    secret: (scope) =>
      scope === "server" ? serverKeys : scope === "client" ? peerKeys : {},
  };
  const compiled = compile(store);
  assert.deepEqual(compiled.endpoints[0].peers[0].allowed_ips, ["10.7.0.2/32"]);
  assert.equal(compiled.dns.servers[1].detour, "out:o");
  assert.deepEqual(compiled.route.rules.at(-1), { action: "reject" });
  assert.equal(
    compiled.route.rules.find((r) => r.action === "route").outbound,
    "out:o",
  );
  assert.match(exportPeer(store, "c"), /DNS = 10.7.0.1/);
  assert.equal(compiled.endpoints[0].system, false);
});

test("direct outbound DNS starts without an invalid detour", () => {
  const config = validate({
    ...empty(),
    outbounds: [{ id: "direct", name: "Direct", protocol: "direct" }],
  });
  const compiled = compile({ config, secret: () => ({}) });
  assert.deepEqual(compiled.dns.servers[1], {
    type: "tcp",
    tag: "dns:direct",
    server: "1.1.1.1",
  });
});
