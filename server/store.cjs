const fs = require("node:fs/promises");
const path = require("node:path");
const { validate, empty, id } = require("./config.cjs");

class Store {
  constructor(file, encryption) {
    this.file = file;
    this.encryption = encryption;
    this.config = empty();
    this.secrets = Object.create(null);
    this.tail = Promise.resolve();
  }
  async load() {
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > 16 * 1024 * 1024) throw new Error("invalidConfig");
      const value = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.config = validate(value.config ?? value);
      if (value.secrets) {
        if (!this.encryption) throw new Error("secretStoreUnavailable");
        this.secrets = JSON.parse(
          this.encryption.decrypt(Buffer.from(value.secrets, "base64")),
        );
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return this.snapshot();
  }
  snapshot() {
    return structuredClone(this.config);
  }
  secret(scope, itemId) {
    return this.secrets[`${scope}:${itemId}`] || {};
  }
  status() {
    return Object.keys(this.secrets).filter(
      (k) => Object.keys(this.secrets[k]).length,
    );
  }
  save(config, changes = []) {
    const task = this.tail.then(async () => {
      const clean = validate(config);
      const secrets = { ...this.secrets };
      if (!Array.isArray(changes) || changes.length > 1000)
        throw new Error("invalidConfig");
      for (const change of changes) {
        if (
          !["outbound", "client", "server"].includes(change.scope) ||
          !id(change.id) ||
          !change.value ||
          typeof change.value !== "object"
        )
          throw new Error("invalidConfig");
        const secret = {};
        for (const [key, value] of Object.entries(change.value)) {
          if (
            !["password", "privateKey", "psk"].includes(key) ||
            typeof value !== "string" ||
            value.length > 4096
          )
            throw new Error("invalidConfig");
          if (value) secret[key] = value;
        }
        secrets[`${change.scope}:${change.id}`] = secret;
      }
      const allowed = new Set([
        ...clean.outbounds.map((o) => `outbound:${o.id}`),
        ...clean.clients.map((c) => `client:${c.id}`),
        ...clean.servers.map((s) => `server:${s.id}`),
      ]);
      for (const key of Object.keys(secrets))
        if (!allowed.has(key)) delete secrets[key];
      for (const listener of clean.listeners)
        if (listener.auth && !secrets[`client:${listener.clientId}`]?.password)
          throw new Error("authRequired");
      const payload = { config: clean };
      if (this.encryption && Object.keys(secrets).length)
        payload.secrets = this.encryption
          .encrypt(JSON.stringify(secrets))
          .toString("base64");
      // Browser service keeps secrets only in memory if no OS-backed encryption is supplied.
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp =
        this.file + "." + require("node:crypto").randomUUID() + ".tmp";
      try {
        await fs.writeFile(temp, JSON.stringify(payload, null, 2), {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(temp, this.file);
      } finally {
        await fs.rm(temp, { force: true });
      }
      this.config = clean;
      this.secrets = secrets;
      return this.snapshot();
    });
    this.tail = task.catch(() => {});
    return task;
  }
}
module.exports = { Store };
