const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { validate, empty } = require('../server/config.cjs');
const { compile, keyPair } = require('../server/vpn.cjs');

const engine = process.env.SING_BOX_PATH || path.join(__dirname, 'sing-box', 'sing-box.exe');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitForPort(port, processInfo) {
  for (let i = 0; i < 40; i++) {
    if (processInfo.child.exitCode !== null) throw new Error(`sing-box exited: ${processInfo.errors()}`);
    try {
      const socket = net.connect(port, '127.0.0.1');
      await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
      socket.destroy();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`SOCKS listener did not start: ${processInfo.errors()}`);
}
function start(config) {
  config.log.level = 'debug';
  const input = JSON.stringify(config);
  const check = spawnSync(engine, ['check', '-c', 'stdin'], { input, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (check.status !== 0) throw new Error(`sing-box check failed: ${check.stderr || check.error}`);
  const child = spawn(engine, ['run', '-c', 'stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errors = '';
  child.stdout.on('data', (data) => { errors += data.toString(); });
  child.stderr.on('data', (data) => { errors += data.toString(); });
  child.stdin.end(input);
  return { child, errors: () => errors };
}
function reader(socket) {
  let buffer = Buffer.alloc(0);
  let pending;
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (pending && buffer.length >= pending.size) {
      const { size, resolve } = pending;
      pending = null;
      const result = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      resolve(result);
    }
  });
  return (size) => new Promise((resolve, reject) => {
    if (buffer.length >= size) {
      const result = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      resolve(result);
      return;
    }
    pending = { size, resolve };
    setTimeout(() => reject(new Error('SOCKS response timed out')), 5000).unref();
  });
}
async function requestThroughSocks(proxyPort, targetHost, targetPort) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const read = reader(socket);
  try {
    socket.write(Buffer.from([5, 1, 0]));
    assert.deepEqual(await read(2), Buffer.from([5, 0]));
    socket.write(Buffer.from([5, 1, 0, 1, ...targetHost.split('.').map(Number), targetPort >> 8, targetPort & 255]));
    const reply = await read(4);
    assert.equal(reply[1], 0, `SOCKS connect failed with code ${reply[1]}`);
    await read(reply[3] === 1 ? 6 : reply[3] === 4 ? 18 : 1);
    socket.write('GET /vpn-smoke HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    let response = '';
    for await (const chunk of socket) response += chunk.toString();
    assert.match(response, /HTTP\/1\.1 200 OK/);
    assert.match(response, /vpn-local-ok/);
  } finally {
    socket.destroy();
  }
}
async function main() {
  const targetHost = Object.values(os.networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal)?.address;
  if (!targetHost) throw new Error('A non-loopback local IPv4 address is required for the VPN target.');
  const wgPort = await freePort();
  const socksPort = await freePort();
  const serverKeys = keyPair();
  const clientKeys = keyPair();
  const origin = http.createServer((_req, res) => res.end('vpn-local-ok'));
  await new Promise((resolve, reject) => origin.listen(0, targetHost, resolve).once('error', reject));
  const originPort = origin.address().port;
  const serverStore = {
    config: validate({ ...empty(),
      outbounds: [{ id: 'direct', name: 'Local target', protocol: 'direct' }],
      servers: [{ id: 'server', name: 'Local VPN', address: '10.77.0.1/24', port: wgPort, endpoint: '127.0.0.1', publicKey: serverKeys.publicKey }],
      clients: [{ id: 'peer', name: 'Local peer', kind: 'vpn', identity: 'peer', address: '10.77.0.2', serverId: 'server', publicKey: clientKeys.publicKey, outboundId: 'direct' }],
    }),
    secret: (scope) => scope === 'server' ? serverKeys : clientKeys,
  };
  const clientStore = {
    config: validate({ ...empty(),
      outbounds: [{ id: 'vpn', name: 'Local VPN', protocol: 'wireguard', host: '127.0.0.1', port: wgPort,
        wireguard: { address: '10.77.0.2/32', dns: '1.1.1.1', peerPublicKey: serverKeys.publicKey, allowedIPs: ['0.0.0.0/0'] } }],
      clients: [{ id: 'app', name: 'Local app', kind: 'proxy', identity: 'app', outboundId: 'vpn' }],
      listeners: [{ id: 'socks', name: 'Local SOCKS', protocol: 'socks5', host: '127.0.0.1', port: socksPort, clientId: 'app', auth: false }],
    }),
    secret: () => clientKeys,
  };
  let server;
  let client;
  try {
    server = start(compile(serverStore));
    await sleep(500);
    if (server.child.exitCode !== null) throw new Error(`VPN server exited: ${server.errors()}`);
    client = start(compile(clientStore));
    await waitForPort(socksPort, client);
    await requestThroughSocks(socksPort, targetHost, originPort);
    console.log('Local WireGuard handshake and SOCKS -> VPN -> HTTP traffic passed.');
  } catch (error) {
    for (const processInfo of [server, client]) console.error((processInfo?.errors() || '').split('\n').filter((line) => /router:|outbound connection|inbound connection|ERROR|FATAL|handshake/.test(line)).slice(-25).join('\n'));
    throw error;
  } finally {
    client?.child.kill();
    server?.child.kill();
    await new Promise((resolve) => origin.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
