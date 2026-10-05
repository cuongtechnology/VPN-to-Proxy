const net = require("node:net");
const tls = require("node:tls");
const { once } = require("node:events");
class Reader {
  constructor(socket, initial = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = initial;
    this.waiter = null;
    this.failure = null;
    this.data = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 1024 * 1024)
        return this.fail(new Error("handshakeTooLarge"));
      this.wake();
    };
    this.end = () => this.fail(new Error("connectionClosed"));
    this.err = (e) => this.fail(e);
    socket.on("data", this.data);
    socket.on("end", this.end);
    socket.on("close", this.end);
    socket.on("error", this.err);
    socket.resume();
  }
  wake() {
    this.waiter?.();
    this.waiter = null;
  }
  fail(e) {
    this.failure = e;
    this.wake();
  }
  async wait() {
    if (this.failure) throw this.failure;
    await new Promise((resolve) => {
      this.waiter = resolve;
    });
    if (this.failure) throw this.failure;
  }
  async read(n) {
    while (this.buffer.length < n) await this.wait();
    const value = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return value;
  }
  async until(delimiter, max = 32768) {
    while (true) {
      const index = this.buffer.indexOf(delimiter);
      if (index >= 0) return this.read(index + delimiter.length);
      if (this.buffer.length >= max) throw new Error("handshakeTooLarge");
      await this.wait();
    }
  }
  release() {
    if (this.released) return;
    this.released = true;
    const s = this.socket;
    s.pause();
    s.off("data", this.data);
    s.off("end", this.end);
    s.off("close", this.end);
    s.off("error", this.err);
    if (this.buffer.length) s.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}
async function connect(host, port, secure = false) {
  const socket = secure
    ? tls.connect({
        host,
        port,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: true,
      })
    : net.connect({ host, port });
  socket.on("error", () => {});
  socket.setTimeout(15000, () => socket.destroy(new Error("connectTimeout")));
  await once(socket, secure ? "secureConnect" : "connect");
  return socket;
}
function address(host, port) {
  let data;
  if (net.isIP(host) === 4)
    data = Buffer.from([1, ...host.split(".").map(Number)]);
  else {
    // SOCKS domain form also accepts a textual IPv6 literal and avoids local DNS.
    const bytes = Buffer.from(host);
    if (!bytes.length || bytes.length > 255) throw new Error("invalidEndpoint");
    data = Buffer.concat([Buffer.from([3, bytes.length]), bytes]);
  }
  const tail = Buffer.alloc(2);
  tail.writeUInt16BE(port);
  return Buffer.concat([data, tail]);
}
async function readAddress(reader, type) {
  let host;
  if (type === 1) host = [...(await reader.read(4))].join(".");
  else if (type === 3)
    host = (await reader.read((await reader.read(1))[0])).toString("utf8");
  else if (type === 4) {
    const b = await reader.read(16);
    host = Array.from({ length: 8 }, (_, i) =>
      b.readUInt16BE(i * 2).toString(16),
    ).join(":");
  } else throw new Error("addressUnsupported");
  const port = (await reader.read(2)).readUInt16BE();
  return { host, port };
}
module.exports = { Reader, connect, address, readAddress };
