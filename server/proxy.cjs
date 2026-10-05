const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const { Reader, readAddress } = require("./socket.cjs");
const { dial } = require("./dial.cjs");
const { host: validHost, port: validPort } = require("./config.cjs");
const equal = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a).digest(),
    crypto.createHash("sha256").update(b).digest(),
  );
class ProxyEngine {
  constructor(store) {
    this.store = store;
    this.listeners = new Map();
    this.connections = new Set();
    this.history = [];
    this.bytesUp = 0;
    this.bytesDown = 0;
  }
  log(clientId, target, code) {
    this.history.unshift({
      time: new Date().toISOString(),
      clientId,
      target,
      code,
    });
    this.history.length = Math.min(100, this.history.length);
  }
  status() {
    return {
      running: this.listeners.size > 0,
      listeners: [...this.listeners].map(([id, entry]) => ({
        id,
        host: entry.spec.host,
        port: entry.server.address()?.port,
      })),
      connections: this.connections.size,
      bytesUp: this.bytesUp,
      bytesDown: this.bytesDown,
      history: this.history,
    };
  }
  authenticate(spec, username, password) {
    const c = this.store.config.clients.find((c) => c.id === spec.clientId);
    const secret = this.store.secret("client", spec.clientId);
    return (
      !!c &&
      (!spec.auth ||
        (!!secret.password &&
          equal(username, c.identity) &&
          equal(password, secret.password)))
    );
  }
  async open(spec, host, port) {
    if (!validHost(host) || !validPort(port))
      throw new Error("invalidEndpoint");
    // Deny recursive proxy connections; account for localhost and wildcard binds.
    if (
      [...this.listeners.values()].some(
        (l) =>
          l.spec.port === port &&
          (l.spec.host === host ||
            ["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"].includes(host)),
      )
    )
      throw new Error("routingLoop");
    const client = this.store.config.clients.find(
      (c) => c.id === spec.clientId,
    );
    const outbound = this.store.config.outbounds.find(
      (o) => o.id === client?.outboundId,
    );
    if (!outbound) throw new Error("blocked");
    return dial(
      outbound,
      { host, port },
      this.store.secret("outbound", outbound.id),
    );
  }
  bridge(incoming, outgoing, spec, destination) {
    if (incoming.destroyed) { outgoing.destroy(); return; }
    incoming.setTimeout(300000, () => incoming.destroy());
    outgoing.setTimeout(300000, () => outgoing.destroy());
    incoming.on("data", (c) => {
      this.bytesUp += c.length;
    });
    outgoing.on("data", (c) => {
      this.bytesDown += c.length;
    });
    incoming.once("close", () => outgoing.destroy());
    outgoing.once("close", () => {
      if (!outgoing.readableEnded) incoming.destroy();
    });
    outgoing.on("error", () => incoming.destroy());
    incoming.on("error", () => outgoing.destroy());
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
    this.log(spec.clientId, destination, "connected");
  }
  async socks(socket, spec, initial) {
    const reader = new Reader(socket, initial);
    let version = 5;
    try {
      version = (await reader.read(1))[0];
      if (version === 4) {
        if (spec.auth || spec.protocol === "socks5")
          throw new Error("authRequired");
        const header = await reader.read(7);
        if (header[0] !== 1) throw new Error("commandUnsupported");
        const port = header.readUInt16BE(1),
          ip = header.subarray(3, 7);
        await reader.until(Buffer.from([0]), 256);
        const host =
          ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0
            ? (await reader.until(Buffer.from([0]), 256))
                .subarray(0, -1)
                .toString()
            : [...ip].join(".");
        const remote = await this.open(spec, host, port);
        socket.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
        reader.release();
        this.bridge(socket, remote, spec, `${host}:${port}`);
        return;
      }
      if (version !== 5 || spec.protocol === "socks4")
        throw new Error("protocolUnsupported");
      const methods = await reader.read((await reader.read(1))[0]);
      const method = spec.auth ? 2 : 0;
      if (!methods.includes(method)) {
        socket.end(Buffer.from([5, 255]));
        return;
      }
      socket.write(Buffer.from([5, method]));
      if (method === 2) {
        if ((await reader.read(1))[0] !== 1) throw new Error("authRequired");
        const username = (
          await reader.read((await reader.read(1))[0])
        ).toString();
        const password = (
          await reader.read((await reader.read(1))[0])
        ).toString();
        if (!this.authenticate(spec, username, password)) {
          socket.end(Buffer.from([1, 1]));
          return;
        }
        socket.write(Buffer.from([1, 0]));
      }
      const head = await reader.read(4);
      if (head[0] !== 5 || head[2] !== 0 || head[1] !== 1) {
        socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const { host, port } = await readAddress(reader, head[3]);
      const remote = await this.open(spec, host, port);
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      reader.release();
      this.bridge(socket, remote, spec, `${host}:${port}`);
    } catch (e) {
      this.log(spec.clientId, "", e.message);
      if (!socket.destroyed)
        socket.end(
          Buffer.from(
            version === 4
              ? [0, 91, 0, 0, 0, 0, 0, 0]
              : [5, 1, 0, 1, 0, 0, 0, 0, 0, 0],
          ),
        );
    } finally {
      reader.release();
    }
  }
  http(spec) {
    const auth = (req) => {
      if (!spec.auth) return true;
      const header = req.headers["proxy-authorization"];
      if (!header?.startsWith("Basic ")) return false;
      const value = Buffer.from(header.slice(6), "base64").toString();
      const split = value.indexOf(":");
      return (
        split >= 0 &&
        this.authenticate(spec, value.slice(0, split), value.slice(split + 1))
      );
    };
    const server = http.createServer(
      { maxHeaderSize: 32768, requestTimeout: 30000, headersTimeout: 15000 },
      async (req, res) => {
        if (!auth(req)) {
          res.writeHead(407, {
            "Proxy-Authenticate": 'Basic realm="VPNtoProxy"',
            Connection: "close",
          });
          res.end();
          return;
        }
        let remote;
        try {
          const url = new URL(req.url);
          if (url.protocol !== "http:" || url.username || url.password)
            throw new Error("invalidEndpoint");
          const host = url.hostname.replace(/^\[|\]$/g, ""),
            port = Number(url.port || 80);
          remote = await this.open(spec, host, port);
          const headers = {
            ...req.headers,
            host: url.host,
            connection: "close",
          };
          for (const name of [
            "proxy-authorization",
            "proxy-connection",
            "keep-alive",
            "upgrade",
            "te",
            "trailer",
            ...String(req.headers.connection || "")
              .split(",")
              .map((s) => s.trim().toLowerCase()),
          ])
            if (name) delete headers[name];
          headers.connection = "close";
          const agent = new http.Agent({ keepAlive: false });
          agent.createConnection = () => remote;
          const upstream = http.request(
            {
              hostname: host,
              port,
              method: req.method,
              path: url.pathname + url.search,
              headers,
              agent,
            },
            (response) => {
              res.writeHead(response.statusCode, response.headers);
              response.on("data", (chunk) => {
                this.bytesDown += chunk.length;
              });
              response.pipe(res);
            },
          );
          upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
            remote.destroy();
          });
          req.on("data", (chunk) => {
            this.bytesUp += chunk.length;
          });
          req.pipe(upstream);
          remote.resume();
          req.on("aborted", () => upstream.destroy());
          res.on("close", () => {
            upstream.destroy();
            remote.destroy();
            agent.destroy();
          });
          this.log(spec.clientId, url.host, "connected");
        } catch (e) {
          remote?.destroy();
          this.log(spec.clientId, "", e.message);
          if (!res.headersSent) res.writeHead(502, { Connection: "close" });
          res.end("Proxy route unavailable");
        }
      },
    );
    server.on("connect", async (req, socket, head) => {
      socket.on("error", () => {});
      if (!auth(req)) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="VPNtoProxy"\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      try {
        if (!/^(?:\[[0-9a-f:]+\]|[^\s/:@?#]+):\d+$/i.test(req.url))
          throw new Error("invalidEndpoint");
        const url = new URL(`http://${req.url}`),
          host = url.hostname.replace(/^\[|\]$/g, ""),
          port = Number(req.url.slice(req.url.lastIndexOf(":") + 1));
        const remote = await this.open(spec, host, port);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        this.bridge(socket, remote, spec, req.url);
      } catch (e) {
        this.log(spec.clientId, "", e.message);
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    });
    server.on("clientError", (_err, socket) =>
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"),
    );
    return server;
  }
  async start() {
    if (this.listeners.size) return this.status();
    try {
      for (const spec of this.store.config.listeners) {
        const httpServer = this.http(spec);
        const server = net.createServer({ allowHalfOpen: true }, (socket) => {
          if (this.connections.size >= 512) return socket.destroy();
          this.connections.add(socket);
          socket.on("error", () => {});
          socket.once("close", () => this.connections.delete(socket));
          socket.setTimeout(15000, () => socket.destroy());
          socket.once("data", (initial) => {
            socket.pause();
            const socks = initial[0] === 4 || initial[0] === 5;
            if (socks && spec.protocol !== "http")
              void this.socks(socket, spec, initial);
            else if (!socks && ["http", "mixed"].includes(spec.protocol)) {
              socket.unshift(initial);
              httpServer.emit("connection", socket);
              socket.resume();
            } else socket.destroy();
          });
        });
        server.on("error", () => {});
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(spec.port, spec.host, () => {
            server.off("error", reject);
            resolve();
          });
        });
        this.listeners.set(spec.id, { server, httpServer, spec });
      }
      return this.status();
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  async stop() {
    for (const c of this.connections) c.destroy();
    this.connections.clear();
    const entries = [...this.listeners.values()];
    this.listeners.clear();
    await Promise.all(
      entries.map(
        ({ server, httpServer }) =>
          new Promise((resolve) => {
            httpServer.closeAllConnections();
            server.close(resolve);
          }),
      ),
    );
    return this.status();
  }
}
module.exports = { ProxyEngine };
