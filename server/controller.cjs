const { ProxyEngine } = require("./proxy.cjs");
const { VPNEngine, keyPair, parseProfile, exportPeer } = require("./vpn.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
class Controller {
  constructor(store) {
    this.store = store;
    this.proxy = new ProxyEngine(store);
    this.vpn = new VPNEngine(store);
    this.enginePath = "";
    this.tail = Promise.resolve();
  }
  async init() {
    await this.store.load();
    try {
      const s = JSON.parse(
        await fs.readFile(
          path.join(path.dirname(this.store.file), "settings.json"),
          "utf8",
        ),
      );
      this.enginePath = typeof s.enginePath === "string" ? s.enginePath : "";
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  async call(method, args = {}) {
    if (method === "load") return this.store.snapshot();
    if (method === "status")
      return {
        ...this.proxy.status(),
        vpn: this.vpn.status(),
        enginePath: this.enginePath,
        persistentSecrets: !!this.store.encryption,
        secretRefs: this.store.status(),
      };
    if (method === "keys") return keyPair();
    if (method === "parseProfile") return parseProfile(args.text);
    if (method === "exportPeer") return exportPeer(this.store, args.id);
    const task = this.tail.then(async () => {
      if (method === "save") {
        if (this.proxy.listeners.size || this.vpn.child)
          throw new Error("stopBeforeEditing");
        return this.store.save(args.config, args.secrets || []);
      }
      if (method === "start") {
        if (args.mode === "vpn") {
          await this.proxy.stop();
          await this.vpn.start(this.enginePath);
        } else {
          if (this.vpn.child) throw new Error("alreadyRunning");
          if (!this.store.config.listeners.length)
            throw new Error("noListeners");
          await this.proxy.start();
        }
        return this.call("status");
      }
      if (method === "stop") {
        await this.proxy.stop();
        await this.vpn.stop();
        return this.call("status");
      }
      if (method === "enginePath") {
        const version = await this.vpn.check(args.path);
        await fs.mkdir(path.dirname(this.store.file), { recursive: true });
        await fs.writeFile(
          path.join(path.dirname(this.store.file), "settings.json"),
          JSON.stringify({ enginePath: args.path }),
          { mode: 0o600 },
        );
        this.enginePath = args.path;
        return { version };
      }
      throw new Error("unknownOperation");
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async close() {
    await this.call("stop");
  }
}
module.exports = { Controller };
