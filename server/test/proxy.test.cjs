const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { Store } = require("../store.cjs");
const { ProxyEngine } = require("../proxy.cjs");
const { dial } = require("../dial.cjs");
const { Reader, readAddress, connect } = require("../socket.cjs");
const { empty, validate } = require("../config.cjs");
const listen = (server) =>
  new Promise((r) =>
    server.listen(0, "127.0.0.1", () => r(server.address().port)),
  );
async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  return port;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vpntoproxy-"));
  const store = new Store(path.join(directory, "config.json"));
  const engine = new ProxyEngine(store);
  t.after(async () => {
    await engine.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, engine };
}
async function upstream(t, protocol, marker) {
  const connections = new Set(),
    targets = [];
  const server = net.createServer(async (socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    const r = new Reader(socket);
    try {
      if (protocol === "http") {
        const request = (await r.until(Buffer.from("\r\n\r\n"))).toString();
        targets.push(request.split("\r\n")[0]);
        socket.write("HTTP/1.1 200 OK\r\n\r\n");
      } else {
        assert.equal((await r.read(1))[0], 5);
        await r.read((await r.read(1))[0]);
        socket.write(Buffer.from([5, 0]));
        const h = await r.read(4);
        targets.push(await readAddress(r, h[3]));
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      }
      r.release();
      socket.once("data", (data) => {
        if (data.toString().startsWith("GET ")) {
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${marker.length}\r\nConnection: close\r\n\r\n${marker}`,
          );
        } else socket.end(marker + ":" + data.toString());
      });
      socket.resume();
    } catch {
      socket.destroy();
    }
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise((r) => server.close(r));
  });
  return {
    port,
    targets,
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
async function exchange(socket, data = "hello") {
  const value = once(socket, "data");
  socket.resume();
  socket.write(data);
  const [reply] = await value;
  socket.destroy();
  return reply.toString();
}
test(
  "real TCP paths isolate two clients and never fail over to another outbound",
  { timeout: 10000 },
  async (t) => {
    const a = await upstream(t, "http", "A"),
      b = await upstream(t, "socks5", "B");
    const { store, engine } = await fixture(t);
    const ports = [await freePort(), await freePort()];
    const config = {
      ...empty(),
      outbounds: [
        {
          id: "a",
          name: "A",
          protocol: "http",
          host: "127.0.0.1",
          port: a.port,
        },
        {
          id: "b",
          name: "B",
          protocol: "socks5",
          host: "127.0.0.1",
          port: b.port,
        },
      ],
      clients: ["a", "b"].map((id) => ({
        id,
        name: id,
        kind: "proxy",
        identity: id,
        outboundId: id,
      })),
      listeners: ["a", "b"].map((id, i) => ({
        id,
        name: id,
        protocol: "mixed",
        host: "127.0.0.1",
        port: ports[i],
        clientId: id,
        auth: false,
      })),
    };
    await store.save(config);
    await engine.start();
    const target = { host: "not-resolved-locally.invalid", port: 443 };
    const pa = { protocol: "socks5", host: "127.0.0.1", port: ports[0] },
      pb = { protocol: "http", host: "127.0.0.1", port: ports[1] };
    assert.equal(await exchange(await dial(pa, target)), "A:hello");
    assert.equal(await exchange(await dial(pb, target)), "B:hello");
    assert.equal(
      b.targets[0].host,
      target.host,
      "SOCKS target must reach upstream without local DNS",
    );
    await a.close();
    await assert.rejects(dial(pa, target));
    assert.equal(
      b.targets.length,
      1,
      "failed client must not reach another upstream",
    );
    assert.equal(await exchange(await dial(pb, target)), "B:hello");
  },
);
test(
  "HTTP forward requests use the assigned upstream, not a direct connection",
  { timeout: 10000 },
  async (t) => {
    const up = await upstream(t, "http", "THROUGH-UPSTREAM");
    const { store, engine } = await fixture(t);
    const port = await freePort();
    await store.save({
      ...empty(),
      outbounds: [
        {
          id: "o",
          name: "Up",
          protocol: "http",
          host: "127.0.0.1",
          port: up.port,
        },
      ],
      clients: [
        { id: "c", name: "C", kind: "proxy", identity: "u", outboundId: "o" },
      ],
      listeners: [
        {
          id: "l",
          name: "L",
          protocol: "http",
          host: "127.0.0.1",
          port,
          clientId: "c",
          auth: false,
        },
      ],
    });
    await engine.start();
    const value = await new Promise((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port,
            path: "http://must-not-resolve.invalid/file",
          },
          (res) => {
            let text = "";
            res.on("data", (b) => (text += b));
            res.on("end", () => resolve(text));
          },
        )
        .on("error", reject);
    });
    assert.equal(value, "THROUGH-UPSTREAM");
    assert.equal(up.targets.length, 1);
  },
);
test(
  "auth is required before any outgoing connection and SOCKS4a works on loopback",
  { timeout: 10000 },
  async (t) => {
    const up = await upstream(t, "http", "AUTH");
    const { store, engine } = await fixture(t);
    const port = await freePort();
    const c = {
      ...empty(),
      outbounds: [
        {
          id: "o",
          name: "Up",
          protocol: "http",
          host: "127.0.0.1",
          port: up.port,
        },
      ],
      clients: [
        {
          id: "c",
          name: "C",
          kind: "proxy",
          identity: "alice",
          outboundId: "o",
        },
      ],
      listeners: [
        {
          id: "l",
          name: "L",
          protocol: "mixed",
          host: "127.0.0.1",
          port,
          clientId: "c",
          auth: true,
        },
      ],
    };
    await store.save(c, [
      { scope: "client", id: "c", value: { password: "secret" } },
    ]);
    await engine.start();
    const proxy = {
        protocol: "socks5",
        host: "127.0.0.1",
        port,
        username: "alice",
      },
      target = { host: "example.invalid", port: 443 };
    await assert.rejects(dial(proxy, target, { password: "wrong" }));
    assert.equal(up.targets.length, 0);
    assert.equal(
      await exchange(await dial(proxy, target, { password: "secret" })),
      "AUTH:hello",
    );
    await engine.stop();
    c.listeners[0].auth = false;
    await store.save(c);
    await engine.start();
    assert.equal(
      await exchange(await dial({ ...proxy, protocol: "socks4a" }, target)),
      "AUTH:hello",
    );
  },
);
test(
  "listener startup failure rolls back listeners already opened",
  { timeout: 10000 },
  async (t) => {
    const { store, engine } = await fixture(t);
    const busy = net.createServer();
    const occupied = await listen(busy);
    t.after(() => busy.close());
    const free = await freePort();
    await store.save({
      ...empty(),
      clients: [
        { id: "c", name: "C", kind: "proxy", identity: "c", outboundId: "" },
      ],
      listeners: [
        {
          id: "a",
          name: "A",
          protocol: "mixed",
          host: "127.0.0.1",
          port: free,
          clientId: "c",
          auth: false,
        },
        {
          id: "b",
          name: "B",
          protocol: "mixed",
          host: "127.0.0.1",
          port: occupied,
          clientId: "c",
          auth: false,
        },
      ],
    });
    await assert.rejects(engine.start());
    assert.equal(engine.status().running, false);
    await assert.rejects(connect("127.0.0.1", free));
  },
);
