import { describe, expect, it } from "vitest";
import {
  canForward,
  deleteOutbound,
  emptyConfig,
  routePreview,
  validateConfig,
  validHost,
  type Config,
} from "./model";
import en from "./locales/en";
import vi from "./locales/vi";
const fixture = (): Config => ({
  version: 1,
  outbounds: [
    {
      id: "a",
      name: "Office",
      protocol: "wireguard",
      host: "vpn.example.com",
      port: 51820,
    },
    { id: "b", name: "Proxy", protocol: "socks5", host: "::1", port: 1080 },
  ],
  clients: [
    {
      id: "phone",
      name: "Phone",
      kind: "vpn",
      identity: "phone-a",
      outboundId: "a",
    },
    {
      id: "browser",
      name: "Browser",
      kind: "proxy",
      identity: "browser-a",
      outboundId: "b",
    },
  ],
});
describe("client isolation", () => {
  it("keeps two clients on their assigned outbounds", () => {
    const c = fixture();
    expect(routePreview(c, "phone").outbound?.id).toBe("a");
    expect(routePreview(c, "browser").outbound?.id).toBe("b");
  });
  it("blocks failed outbounds even when another is available", () => {
    const c = fixture();
    expect(canForward(c, "phone", new Set(["b"]))).toBe(false);
    expect(canForward(c, "browser", new Set(["b"]))).toBe(true);
  });
  it("blocks unassigned and unknown clients", () => {
    const c = fixture();
    c.clients[0].outboundId = "";
    expect(canForward(c, "phone", new Set(["a", "b"]))).toBe(false);
    expect(canForward(c, "unknown", new Set(["a", "b"]))).toBe(false);
  });
  it("prevents deletion of an assigned outbound", () => {
    expect(() => deleteOutbound(fixture(), "a")).toThrow("inUse");
    const c = fixture();
    c.clients[0].outboundId = "";
    expect(deleteOutbound(c, "a").outbounds.map((o) => o.id)).toEqual(["b"]);
  });
});
describe("configuration boundary", () => {
  it("accepts empty and populated configurations", () => {
    expect(validateConfig(emptyConfig())).toEqual(emptyConfig());
    expect(validateConfig(fixture())).toEqual(fixture());
  });
  it.each([
    null,
    {},
    { version: 2, outbounds: [], clients: [] },
    { version: 1, outbounds: [], clients: [null] },
  ])("rejects malformed or future data", (value) => {
    expect(() => validateConfig(value)).toThrow();
  });
  it("rejects dangling assignments and duplicate identities", () => {
    const c = fixture();
    c.clients[0].outboundId = "missing";
    expect(() => validateConfig(c)).toThrow("missingOutbound");
    const d = fixture();
    d.clients.push({ ...d.clients[0], id: "other" });
    expect(() => validateConfig(d)).toThrow("duplicateIdentity");
  });
  it("drops unknown fields so secrets cannot enter stored metadata", () => {
    const c = fixture();
    const result = validateConfig({
      ...c,
      password: "secret",
      outbounds: [{ ...c.outbounds[0], privateKey: "secret" }, c.outbounds[1]],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it.each([0, 65536, 1.1, NaN])("rejects invalid port %s", (port) => {
    const c = fixture();
    c.outbounds[0].port = port;
    expect(() => validateConfig(c)).toThrow("invalidEndpoint");
  });
  it.each(["example.com", "localhost", "127.0.0.1", "2001:db8::1", "::1"])(
    "accepts host %s",
    (host) => expect(validHost(host)).toBe(true),
  );
  it.each([
    "https://example.com",
    "user:pass@host",
    "256.1.1.1",
    "a b",
    "-host.com",
    "host/path",
    "::xyz",
  ])("rejects host %s", (host) => expect(validHost(host)).toBe(false));
});
it("keeps English and Vietnamese translation keys and interpolation parameters aligned", () => {
  expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
  for (const key of Object.keys(en) as (keyof typeof en)[])
    expect(vi[key].match(/\{\{\w+\}\}/g)).toEqual(
      en[key].match(/\{\{\w+\}\}/g),
    );
});
