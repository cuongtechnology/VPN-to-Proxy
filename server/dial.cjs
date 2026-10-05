const net = require("node:net");
const dns = require("node:dns").promises;
const { Reader, connect, address, readAddress } = require("./socket.cjs");

async function dial(outbound, target, secret = {}) {
  if (!outbound) throw new Error("blocked");
  if (outbound.protocol === "direct") return connect(target.host, target.port);
  if (outbound.protocol === "wireguard") throw new Error("vpnEngineRequired");
  const socket = await connect(
    outbound.host,
    outbound.port,
    outbound.protocol === "https",
  );
  const reader = new Reader(socket);
  try {
    if (outbound.protocol === "http" || outbound.protocol === "https") {
      const authority = `${net.isIP(target.host) === 6 ? `[${target.host}]` : target.host}:${target.port}`;
      const auth = outbound.username
        ? `Proxy-Authorization: Basic ${Buffer.from(outbound.username + ":" + (secret.password || "")).toString("base64")}\r\n`
        : "";
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}Connection: keep-alive\r\n\r\n`,
      );
      const response = (await reader.until(Buffer.from("\r\n\r\n"))).toString(
        "latin1",
      );
      if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(response))
        throw new Error("upstreamRejected");
    } else if (outbound.protocol === "socks5") {
      socket.write(Buffer.from(outbound.username ? [5, 1, 2] : [5, 1, 0]));
      const reply = await reader.read(2);
      if (reply[0] !== 5 || reply[1] !== (outbound.username ? 2 : 0))
        throw new Error("upstreamAuth");
      if (reply[1] === 2) {
        const user = Buffer.from(outbound.username),
          pass = Buffer.from(secret.password || "");
        if (user.length > 255 || pass.length > 255)
          throw new Error("upstreamAuth");
        socket.write(
          Buffer.concat([
            Buffer.from([1, user.length]),
            user,
            Buffer.from([pass.length]),
            pass,
          ]),
        );
        const auth = await reader.read(2);
        if (auth[0] !== 1 || auth[1] !== 0) throw new Error("upstreamAuth");
      }
      socket.write(
        Buffer.concat([
          Buffer.from([5, 1, 0]),
          address(target.host, target.port),
        ]),
      );
      const response = await reader.read(4);
      if (response[0] !== 5 || response[1] !== 0)
        throw new Error("upstreamRejected");
      await readAddress(reader, response[3]);
    } else if (
      outbound.protocol === "socks4" ||
      outbound.protocol === "socks4a"
    ) {
      let ip = target.host;
      if (!net.isIP(ip) && outbound.protocol === "socks4")
        throw new Error("socks4NeedsIP");
      if (net.isIP(ip) === 6) throw new Error("addressUnsupported");
      const isDomain = !net.isIP(ip);
      const request = Buffer.alloc(8);
      request[0] = 4;
      request[1] = 1;
      request.writeUInt16BE(target.port, 2);
      Buffer.from(isDomain ? [0, 0, 0, 1] : ip.split(".").map(Number)).copy(
        request,
        4,
      );
      socket.write(
        Buffer.concat([
          request,
          Buffer.from(outbound.username || ""),
          Buffer.from([0]),
          ...(isDomain ? [Buffer.from(ip), Buffer.from([0])] : []),
        ]),
      );
      if ((await reader.read(8))[1] !== 90) throw new Error("upstreamRejected");
    } else throw new Error("protocolUnsupported");
    reader.release();
    socket.setTimeout(0);
    return socket;
  } catch (e) {
    reader.release();
    socket.destroy();
    throw e;
  }
}
module.exports = { dial };
