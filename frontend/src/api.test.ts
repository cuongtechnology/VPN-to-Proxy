import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "./api";
import { emptyConfig } from "./model";

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("loads an empty workspace and persists browser metadata", async () => {
  expect(await loadConfig()).toEqual(emptyConfig());
  const value = {
    ...emptyConfig(),
    outbounds: [
      {
        id: "a",
        name: "Office",
        protocol: "wireguard" as const,
        host: "example.com",
        port: 51820,
      },
    ],
  };
  await saveConfig(value);
  expect(await loadConfig()).toEqual(value);
});
it("preserves corrupted browser data for recovery instead of resetting it", async () => {
  data.set("vpntoproxy.config.v1", "{corrupt");
  await expect(loadConfig()).rejects.toThrow();
  expect(data.get("vpntoproxy.config.v1")).toBe("{corrupt");
});
it("rejects a failed storage write without replacing existing data", async () => {
  await saveConfig(emptyConfig());
  const before = data.get("vpntoproxy.config.v1");
  vi.stubGlobal("localStorage", {
    setItem: () => {
      throw new Error("Quota exceeded");
    },
  });
  await expect(saveConfig(emptyConfig())).rejects.toThrow("Quota exceeded");
  expect(data.get("vpntoproxy.config.v1")).toBe(before);
});
it("uses the desktop bridge without silently falling back to browser storage", async () => {
  const LoadConfig = vi.fn().mockResolvedValue(emptyConfig());
  const SaveConfig = vi.fn().mockRejectedValue(new Error("Disk unavailable"));
  vi.stubGlobal("window", {
    go: { main: { App: { LoadConfig, SaveConfig } } },
  });
  expect(await loadConfig()).toEqual(emptyConfig());
  await expect(saveConfig(emptyConfig())).rejects.toThrow("Disk unavailable");
  expect(SaveConfig).toHaveBeenCalledWith(emptyConfig());
  expect(data.size).toBe(0);
});
