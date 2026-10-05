import { emptyConfig, validateConfig, type Config } from "./model";
type Bridge = {
  LoadConfig(): Promise<Config>;
  SaveConfig(config: Config): Promise<void>;
};
declare global {
  interface Window {
    go?: { main?: { App?: Bridge } };
    vpntoproxy?: { call(method: string, args?: unknown): Promise<any> };
    __VPN_TOKEN__?: string;
  }
}
const key = "vpntoproxy.config.v1";
export const isDesktop = () => !!window.vpntoproxy || !!window.go?.main?.App;
const token = () =>
  window.__VPN_TOKEN__ ||
  (typeof document !== "undefined"
    ? document.querySelector<HTMLMetaElement>('meta[name="vpntoproxy-token"]')
        ?.content
    : undefined);
export const hasRuntime = () => !!window.vpntoproxy || !!token();
export type SecretChange = {
  scope: "outbound" | "client" | "server";
  id: string;
  value: { password?: string; privateKey?: string; psk?: string };
};
export async function call<T = any>(
  method: string,
  args?: unknown,
): Promise<T> {
  if (window.vpntoproxy) return window.vpntoproxy.call(method, args);
  const auth = token();
  if (!auth) throw new Error("runtimeRequired");
  const res = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-VPNtoProxy-Token": auth },
    body: JSON.stringify({ method, args }),
  });
  const result = await res.json();
  if (!res.ok || result.error)
    throw new Error(result.error || "operationFailed");
  return result.value;
}
export async function loadConfig(): Promise<Config> {
  if (hasRuntime()) return validateConfig(await call("load"));
  const bridge = window.go?.main?.App;
  if (bridge) return validateConfig(await bridge.LoadConfig());
  const raw = localStorage.getItem(key);
  return raw ? validateConfig(JSON.parse(raw)) : emptyConfig();
}
export async function saveConfig(
  config: Config,
  secrets: SecretChange[] = [],
): Promise<void> {
  const clean = validateConfig(config);
  if (hasRuntime()) {
    await call("save", { config: clean, secrets });
    return;
  }
  if (secrets.length) throw new Error("runtimeRequired");
  const bridge = window.go?.main?.App;
  if (bridge) await bridge.SaveConfig(clean);
  else localStorage.setItem(key, JSON.stringify(clean));
}
