import { useEffect, useState, type FormEvent } from "react";
import {
  Play,
  Square,
  Plus,
  Server,
  Download,
  Upload,
  Trash2,
  Pencil,
  Copy,
} from "lucide-react";
import {
  call,
  hasRuntime,
  isDesktop,
  saveConfig,
  type SecretChange,
} from "./api";
import { type Config, type Listener, validateConfig } from "./model";
import { useLanguage } from "./i18n";
import { runtimeText } from "./runtime-text";
export type RuntimeStatus = {
  running: boolean;
  listeners: { id: string; host: string; port: number }[];
  connections: number;
  bytesUp: number;
  bytesDown: number;
  history: { time: string; clientId: string; target: string; code: string }[];
  vpn: { state: string; lastError: string };
  enginePath: string;
  persistentSecrets: boolean;
  secretRefs: string[];
};
export function useRuntimeStatus() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  useEffect(() => {
    if (!hasRuntime()) return;
    let disposed = false;
    const update = () =>
      call<RuntimeStatus>("status")
        .then((s) => {
          if (!disposed) setStatus(s);
        })
        .catch(() => {
          if (!disposed) setStatus(null);
        });
    void update();
    const timer = setInterval(update, 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  return status;
}
export const download = (name: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export default function RuntimePanel({
  config,
  onSaved,
}: {
  config: Config;
  onSaved(config: Config): void;
}) {
  const { locale } = useLanguage();
  const text = runtimeText[locale];
  const status = useRuntimeStatus();
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [form, setForm] = useState<
    "listener" | "server" | "peer" | "import" | null
  >(null);
  const [editing, setEditing] = useState<Listener | null>(null),
    [serverId, setServerId] = useState("");
  const [enginePath, setEnginePath] = useState("");
  const active = !!status?.running || status?.vpn.state === "running";
  useEffect(() => {
    if (status?.enginePath) setEnginePath(status.enginePath);
  }, [status?.enginePath]);
  function message(e: unknown) {
    const code =
      e instanceof Error
        ? e.message.replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          )
        : "operationFailed";
    return text[code as keyof typeof text] || text.operationFailed;
  }
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(next: Config, secrets: SecretChange[] = []) {
    await saveConfig(next, secrets);
    onSaved(await call<Config>("load"));
    setNotice(text.saved);
  }
  function open(kind: typeof form) {
    setError("");
    setEditing(null);
    setForm(kind);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) || "").trim();
    await act(async () => {
      const id = editing?.id || crypto.randomUUID();
      const name = field("name");
      if (form === "listener") {
        const listener: Listener = {
          id,
          name,
          protocol: field("protocol") as Listener["protocol"],
          host: field("host"),
          port: Number(field("port")),
          clientId: field("clientId"),
          auth: data.has("auth"),
        };
        const password = String(data.get("password") || "");
        await save(
          {
            ...config,
            listeners: editing
              ? config.listeners?.map((l) => (l.id === id ? listener : l))
              : [...(config.listeners || []), listener],
          },
          password
            ? [{ scope: "client", id: listener.clientId, value: { password } }]
            : [],
        );
      } else if (form === "server") {
        const keys = await call<{ publicKey: string; privateKey: string }>(
          "keys",
        );
        await save(
          {
            ...config,
            servers: [
              ...(config.servers || []),
              {
                id,
                name,
                address: field("address"),
                port: Number(field("port")),
                endpoint: field("endpoint"),
                publicKey: keys.publicKey,
              },
            ],
          },
          [{ scope: "server", id, value: { privateKey: keys.privateKey } }],
        );
      } else if (form === "peer") {
        const keys = await call<{ publicKey: string; privateKey: string }>(
          "keys",
        );
        await save(
          {
            ...config,
            clients: [
              ...config.clients,
              {
                id,
                name,
                kind: "vpn",
                identity: field("identity"),
                serverId,
                address: field("address"),
                publicKey: keys.publicKey,
                outboundId: field("outboundId"),
              },
            ],
          },
          [{ scope: "client", id, value: { privateKey: keys.privateKey } }],
        );
      } else if (form === "import") {
        const parsed = await call("parseProfile", {
          text: String(data.get("profile") || ""),
        });
        await save(
          {
            ...config,
            outbounds: [
              ...config.outbounds,
              {
                id,
                name,
                protocol: "wireguard",
                host: parsed.host,
                port: parsed.port,
                wireguard: parsed.wireguard,
              },
            ],
          },
          [{ scope: "outbound", id, value: parsed.secret }],
        );
      }
      setForm(null);
      setEditing(null);
    });
  }
  async function importMetadata(file: File | undefined) {
    if (!file || !confirm(text.confirmReplace)) return;
    await act(async () => {
      if (file.size > 2 * 1024 * 1024) throw new Error("invalidConfig");
      await save(validateConfig(JSON.parse(await file.text())));
    });
  }
  const disabled = busy || active || !hasRuntime();
  const proxyClients = config.clients.filter((c) => c.kind === "proxy");
  return (
    <div className="runtime-panel">
      {!hasRuntime() && <div className="engine-banner">{text.preview}</div>}
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="toast">
          {notice}
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              {text.network}{" "}
              <span className="badge">
                {active ? text.running : text.stopped}
              </span>
            </h2>
            <p>{status?.persistentSecrets ? text.secrets : text.memory}</p>
          </div>
          <Server size={22} />
        </div>
        <div className="engine-controls">
          <button
            className="primary"
            disabled={busy || active || !hasRuntime()}
            onClick={() =>
              void act(async () => {
                await call("start", { mode: "proxy" });
              })
            }
          >
            <Play size={15} />
            {text.start}
          </button>
          <button
            disabled={busy || active || !hasRuntime()}
            onClick={() =>
              void act(async () => {
                await call("start", { mode: "vpn" });
              })
            }
          >
            <Play size={15} />
            {text.startVPN}
          </button>
          <button
            disabled={busy || !hasRuntime()}
            onClick={() =>
              void act(async () => {
                await call("stop");
              })
            }
          >
            <Square size={15} />
            {text.stop}
          </button>
          <span className="runtime-metrics">
            {text.active}: {status?.connections ?? "—"} · ↑{" "}
            {((status?.bytesUp || 0) / 1024).toFixed(1)} KB · ↓{" "}
            {((status?.bytesDown || 0) / 1024).toFixed(1)} KB
          </span>
        </div>
        {status?.vpn.lastError && (
          <p className="error">{message(new Error(status.vpn.lastError))}</p>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>{text.listeners}</h2>
          <button
            disabled={disabled || !proxyClients.length}
            onClick={() => open("listener")}
          >
            <Plus size={15} />
            {text.addListener}
          </button>
        </div>
        {!(config.listeners || []).length ? (
          <p className="empty">{text.noListeners}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{text.name}</th>
                  <th>{text.protocol}</th>
                  <th>{text.endpoint}</th>
                  <th>{text.client}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {config.listeners?.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td>
                      {l.protocol.toUpperCase()}
                      {l.auth ? " · AUTH" : ""}
                    </td>
                    <td>
                      <code>
                        {l.host.includes(":") ? `[${l.host}]` : l.host}:{l.port}
                      </code>
                    </td>
                    <td>
                      {config.clients.find((c) => c.id === l.clientId)?.name}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={text.copy}
                          onClick={() =>
                            void act(async () => {
                              await navigator.clipboard.writeText(
                                `${l.host.includes(":") ? `[${l.host}]` : l.host}:${l.port}`,
                              );
                              setNotice(text.copied);
                            })
                          }
                        >
                          <Copy size={16} />
                        </button>
                        <button
                          className="icon-button"
                          disabled={disabled}
                          aria-label={text.edit}
                          onClick={() => {
                            setEditing(l);
                            setForm("listener");
                          }}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-button"
                          disabled={disabled}
                          aria-label={text.remove}
                          onClick={() => {
                            if (confirm(text.confirmDelete))
                              void act(() =>
                                save({
                                  ...config,
                                  listeners: config.listeners?.filter(
                                    (x) => x.id !== l.id,
                                  ),
                                }),
                              );
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{text.servers}</h2>
            <p>{text.vpnNote}</p>
          </div>
          <button disabled={disabled} onClick={() => open("server")}>
            <Plus size={15} />
            {text.addServer}
          </button>
        </div>
        {config.servers?.map((s) => (
          <div className="vpn-server" key={s.id}>
            <div className="vpn-server-heading">
              <div>
                <h3>{s.name}</h3>
                <code>
                  {s.endpoint}:{s.port} · {s.address}
                </code>
              </div>
              <div className="row-actions">
                <button
                  disabled={disabled}
                  onClick={() => {
                    setServerId(s.id);
                    open("peer");
                  }}
                >
                  <Plus size={15} />
                  {text.addPeer}
                </button>
                <button
                  disabled={
                    disabled || config.clients.some((c) => c.serverId === s.id)
                  }
                  aria-label={text.remove}
                  onClick={() => {
                    if (confirm(text.confirmDelete))
                      void act(() =>
                        save({
                          ...config,
                          servers: config.servers?.filter((x) => x.id !== s.id),
                        }),
                      );
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            <p className="key-line">
              {text.publicKey}: <code>{s.publicKey}</code>
            </p>
            {config.clients
              .filter((c) => c.serverId === s.id)
              .map((c) => (
                <div className="peer-row" key={c.id}>
                  <strong>{c.name}</strong>
                  <code>{c.address}</code>
                  <span>
                    {config.outbounds.find((o) => o.id === c.outboundId)
                      ?.name || text.blocked}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        download(
                          `vpntoproxy-peer-${c.id}.conf`,
                          await call<string>("exportPeer", { id: c.id }),
                        );
                      })
                    }
                  >
                    <Download size={14} />
                    {text.exportPeer}
                  </button>
                </div>
              ))}
          </div>
        ))}
        <div className="engine-controls">
          <button disabled={disabled} onClick={() => open("import")}>
            <Upload size={15} />
            {text.importVPN}
          </button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{text.vpnEngine}</h2>
            <p>{text.engineHelp}</p>
          </div>
        </div>
        <div className="engine-controls">
          <input
            aria-label={text.enginePath}
            value={enginePath}
            onChange={(e) => setEnginePath(e.target.value)}
            placeholder="C:\\Tools\\sing-box.exe"
            disabled={active || busy}
          />
          {isDesktop() && (
            <button
              disabled={active || busy}
              onClick={() =>
                void act(async () => {
                  const file = await call<string | null>("chooseEngine");
                  if (file) setEnginePath(file);
                })
              }
            >
              {text.browse}
            </button>
          )}
          <button
            disabled={disabled || !enginePath}
            onClick={() =>
              void act(async () => {
                await call("enginePath", { path: enginePath });
                setNotice(text.engineSaved);
              })
            }
          >
            {text.apply}
          </button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>{text.traffic}</h2>
        </div>
        {!status?.history.length ? (
          <p className="empty">{text.noTraffic}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{text.time}</th>
                  <th>{text.client}</th>
                  <th>{text.target}</th>
                  <th>{text.result}</th>
                </tr>
              </thead>
              <tbody>
                {status.history.map((entry, i) => (
                  <tr key={i}>
                    <td>{new Date(entry.time).toLocaleTimeString(locale)}</td>
                    <td>
                      {config.clients.find((c) => c.id === entry.clientId)
                        ?.name || entry.clientId}
                    </td>
                    <td>
                      <code>{entry.target || "—"}</code>
                    </td>
                    <td>{entry.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="setting">
          <div>
            <h2>{text.importConfig}</h2>
            <p>{text.importConfigHint}</p>
          </div>
          <input
            type="file"
            accept="application/json,.json"
            aria-label={text.importConfig}
            disabled={disabled}
            onChange={(e) => {
              void importMetadata(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      </section>
      {form && (
        <div className="runtime-overlay">
          <section
            className="runtime-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="runtime-title"
          >
            <h2 id="runtime-title">
              {form === "listener"
                ? text.addListener
                : form === "server"
                  ? text.addServer
                  : form === "peer"
                    ? text.addPeer
                    : text.importVPN}
            </h2>
            <form onSubmit={submit}>
              <fieldset disabled={busy}>
                <label>
                  {text.name}
                  <input
                    name="name"
                    required
                    maxLength={100}
                    defaultValue={editing?.name}
                    autoFocus
                  />
                </label>
                {form === "listener" && (
                  <>
                    <div className="form-row">
                      <label>
                        {text.host}
                        <input
                          name="host"
                          required
                          defaultValue={editing?.host || "127.0.0.1"}
                        />
                      </label>
                      <label>
                        {text.port}
                        <input
                          name="port"
                          required
                          type="number"
                          min={1}
                          max={65535}
                          defaultValue={editing?.port || 1080}
                        />
                      </label>
                    </div>
                    <label>
                      {text.protocol}
                      <select
                        name="protocol"
                        defaultValue={editing?.protocol || "mixed"}
                      >
                        <option value="mixed">HTTP + SOCKS5 / SOCKS4a</option>
                        <option value="http">HTTP CONNECT</option>
                        <option value="socks5">SOCKS5</option>
                        <option value="socks4">SOCKS4 / SOCKS4a</option>
                      </select>
                    </label>
                    <label>
                      {text.client}
                      <select
                        name="clientId"
                        required
                        defaultValue={editing?.clientId}
                      >
                        {proxyClients.map((c) => (
                          <option value={c.id} key={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="checkbox">
                      <input
                        name="auth"
                        type="checkbox"
                        defaultChecked={editing?.auth}
                      />
                      {text.auth}
                    </label>
                    <label>
                      {text.password}
                      <input
                        type="password"
                        name="password"
                        autoComplete="new-password"
                        maxLength={255}
                      />
                    </label>
                    <p className="form-hint">{text.passwordHint}</p>
                  </>
                )}
                {form === "server" && (
                  <>
                    <label>
                      {text.endpoint}
                      <input
                        name="endpoint"
                        required
                        placeholder="vpn.example.com"
                      />
                    </label>
                    <div className="form-row">
                      <label>
                        {text.address}
                        <input
                          name="address"
                          required
                          defaultValue="10.77.0.1/24"
                        />
                      </label>
                      <label>
                        {text.port}
                        <input
                          name="port"
                          type="number"
                          required
                          min={1}
                          max={65535}
                          defaultValue={51820}
                        />
                      </label>
                    </div>
                  </>
                )}
                {form === "peer" && (
                  <>
                    <label>
                      {text.client}
                      <input name="identity" required placeholder="phone-a" />
                    </label>
                    <label>
                      {text.peerAddress}
                      <input name="address" required placeholder="10.77.0.2" />
                    </label>
                    <label>
                      {text.outbound}
                      <select name="outboundId">
                        <option value="">{text.blocked}</option>
                        {config.outbounds.map((o) => (
                          <option value={o.id} key={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                {form === "import" && (
                  <>
                    <label>
                      {text.profile}
                      <textarea
                        name="profile"
                        required
                        rows={12}
                        maxLength={65536}
                        spellCheck={false}
                      />
                    </label>
                    <p className="form-hint">{text.importHint}</p>
                  </>
                )}
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
                <div className="modal-actions">
                  <button type="button" onClick={() => setForm(null)}>
                    {text.cancel}
                  </button>
                  <button type="submit" className="primary">
                    {text.save}
                  </button>
                </div>
              </fieldset>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
