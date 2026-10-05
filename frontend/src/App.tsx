import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CircleHelp,
  GitBranch,
  Globe2,
  LayoutDashboard,
  LockKeyhole,
  Monitor,
  Network,
  Plus,
  Search,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Trash2,
  Users,
  X,
  Pencil,
} from "lucide-react";
import {
  ConfigError,
  deleteOutbound,
  emptyConfig,
  routePreview,
  type Client,
  type Config,
  type Outbound,
  type Protocol,
} from "./model";
import {
  isDesktop,
  hasRuntime,
  loadConfig,
  saveConfig,
  type SecretChange,
} from "./api";
import RuntimePanel, { useRuntimeStatus } from "./RuntimePanel";
import { runtimeText } from "./runtime-text";
import { useLanguage, type Key } from "./i18n";
type Page =
  "overview" | "outbounds" | "clients" | "routing" | "network" | "settings";
type Editor =
  { type: "outbound"; value?: Outbound } | { type: "client"; value?: Client };
const nav = [
  { id: "overview", icon: LayoutDashboard },
  { id: "outbounds", icon: Server },
  { id: "clients", icon: Users },
  { id: "routing", icon: GitBranch },
  { id: "network", icon: Network },
  { id: "settings", icon: Settings2 },
] as const;
const endpoint = (o: Outbound) =>
  o.protocol === 'direct' ? 'DIRECT' : `${o.host.includes(":") ? `[${o.host}]` : o.host}:${o.port}`;

function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useLanguage();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label={t("close")}
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export default function App() {
  const { t, locale, setLocale } = useLanguage();
  const runtime = useRuntimeStatus();
  const rt = runtimeText[locale];
  const engineActive = !!runtime?.running || runtime?.vpn.state === "running";
  const [page, setPage] = useState<Page>("overview");
  const [config, setConfig] = useState<Config>(emptyConfig);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [message, setMessage] = useState<Key | null>(null);
  const [error, setError] = useState<Key | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editProtocol, setEditProtocol] = useState<Protocol>("socks5");
  const [removal, setRemoval] = useState<{
    type: "outbound" | "client";
    id: string;
    name: string;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState("all");
  async function reload() {
    setLoading(true);
    setLoadError(false);
    try {
      setConfig(await loadConfig());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [message]);
  function openEditor(value: Editor) {
    setError(null);
    if (value.type === "outbound")
      setEditProtocol(value.value?.protocol || "socks5");
    setEditor(value);
  }
  async function commit(
    next: Config,
    success: Key = "saved",
    secrets: SecretChange[] = [],
  ) {
    if (engineActive) {
      setError("stopBeforeEditing");
      return false;
    }
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await saveConfig(next, secrets);
      setConfig(next);
      setMessage(success);
      return true;
    } catch (e) {
      setError(e instanceof ConfigError ? e.code : "saveFailed");
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const id = editor.value?.id ?? crypto.randomUUID();
    let next: Config;
    const secrets: SecretChange[] = [];
    if (editor.type === "outbound") {
      const value: Outbound = {
        ...editor.value,
        id,
        name: text("name"),
        protocol: text("protocol") as Protocol,
        host: text("host"),
        port: Number(text("port")),
        username: text("username"),
      };
      if (data.get("password"))
        secrets.push({
          scope: "outbound",
          id,
          value: { password: String(data.get("password")) },
        });
      next = {
        ...config,
        outbounds: editor.value
          ? config.outbounds.map((o) => (o.id === id ? value : o))
          : [...config.outbounds, value],
      };
    } else {
      const value: Client = {
        ...editor.value,
        id,
        name: text("name"),
        kind: text("kind") as Client["kind"],
        identity: text("identity"),
        outboundId: text("outboundId"),
      };
      next = {
        ...config,
        clients: editor.value
          ? config.clients.map((c) => (c.id === id ? value : c))
          : [...config.clients, value],
      };
    }
    if (await commit(next, "saved", secrets)) setEditor(null);
  }
  async function remove() {
    if (!removal) return;
    try {
      const next =
        removal.type === "outbound"
          ? deleteOutbound(config, removal.id)
          : {
              ...config,
              clients: config.clients.filter((c) => c.id !== removal.id),
            };
      if (await commit(next, "deleted")) setRemoval(null);
    } catch (e) {
      setError(e instanceof ConfigError ? e.code : "saveFailed");
    }
  }
  function exportConfig() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "vpntoproxy-config.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const languageSelect = (
    <select
      aria-label={t("language")}
      value={locale}
      onChange={(e) => setLocale(e.target.value as "en" | "vi")}
    >
      <option value="en">English</option>
      <option value="vi">Tiếng Việt</option>
    </select>
  );
  const add = (type: "outbound" | "client") => (
    <button
      className="primary"
      disabled={loading || loadError || engineActive}
      onClick={() => openEditor({ type })}
    >
      <Plus size={17} />
      {t(type === "outbound" ? "addOutbound" : "addClient")}
    </button>
  );
  const filtered = config.outbounds.filter(
    (o) =>
      `${o.name} ${o.host}`.toLowerCase().includes(query.toLowerCase()) &&
      (protocol === "all" || o.protocol === protocol),
  );
  function actions(type: "outbound" | "client", value: Outbound | Client) {
    return (
      <div className="row-actions">
        <button
          className="icon-button"
          aria-label={`${t("edit")} ${value.name}`}
          onClick={() =>
            openEditor(
              type === "outbound"
                ? { type, value: value as Outbound }
                : { type, value: value as Client },
            )
          }
        >
          <Pencil size={16} />
        </button>
        <button
          className="icon-button delete"
          aria-label={`${t("remove")} ${value.name}`}
          onClick={() => {
            setError(null);
            setRemoval({ type, id: value.id, name: value.name });
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
    );
  }
  function clientRoutes() {
    return config.clients.length ? (
      <div className="routes">
        {config.clients.map((c) => {
          const route = routePreview(config, c.id);
          return (
            <div className="route" key={c.id}>
              <div className="route-node">
                <span className="node-icon">
                  <Monitor size={19} />
                </span>
                <div>
                  <strong>{c.name}</strong>
                  <small>
                    {t(c.kind)} · {c.identity}
                  </small>
                </div>
              </div>
              <div className="route-line">
                <span />
                <ArrowRight size={16} />
              </div>
              <div className="route-node">
                <span className={`node-icon ${route.outbound ? "mint" : ""}`}>
                  {route.outbound ? (
                    <Server size={19} />
                  ) : (
                    <LockKeyhole size={19} />
                  )}
                </span>
                <div>
                  <strong>{route.outbound?.name ?? t("blocked")}</strong>
                  <small>
                    {route.outbound ? endpoint(route.outbound) : t("noRoute")}
                  </small>
                </div>
              </div>
              <span className="badge">
                <span />
                {t("draft")}
              </span>
            </div>
          );
        })}
      </div>
    ) : (
      <Empty
        icon={<Network size={29} />}
        title={t("noClients")}
        description={t("noClientsDesc")}
      >
        {add(config.outbounds.length ? "client" : "outbound")}
      </Empty>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("overview");
          }}
        >
          <span className="brand-mark">
            <Network size={24} />
          </span>
          <span>
            VPN<span className="brand-light">to</span>Proxy
            <small>{t("subtitle")}</small>
          </span>
        </a>
        <p className="nav-label">{t("workspace")}</p>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "nav-item selected" : "nav-item"}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => {
                setPage(item.id);
                setError(null);
              }}
            >
              <item.icon size={19} />
              {t(item.id)}
              {item.id === "outbounds" && (
                <span className="nav-count">{config.outbounds.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <ShieldCheck size={20} />
            <div>
              <strong>{t("localOnly")}</strong>
              <small>{t("build")}</small>
            </div>
          </div>
          <span className="sidebar-footer">{t("footer")}</span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            VPNtoProxy <span>/</span> <strong>{t(page)}</strong>
          </div>
          <div className="top-actions">
            <span className="mode">
              <span />
              {t(isDesktop() ? "desktop" : hasRuntime() ? 'localServer' : "browser")}
            </span>
            <Globe2 size={16} />
            {languageSelect}
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">VPNtoProxy / {t("workspace")}</span>
              <h1>{t(page)}</h1>
              <p>{t(`${page}Desc` as Key)}</p>
            </div>
            {page !== "settings" &&
              page !== "network" &&
              add(
                page === "clients" || page === "routing"
                  ? "client"
                  : "outbound",
              )}
          </div>
          {message && (
            <div className="toast" role="status">
              <Check size={17} />
              {t(message)}
            </div>
          )}
          {error && !editor && !removal && (
            <p className="error" role="alert">
              {t(error)}
            </p>
          )}
          {loading ? (
            <div className="panel loading" role="status">
              …
            </div>
          ) : loadError ? (
            <div className="panel empty">
              <p role="alert">{t("loadFailed")}</p>
              <button onClick={() => void reload()}>{t("retry")}</button>
            </div>
          ) : (
            <>
              {page === "overview" && (
                <>
                  <div className="stats">
                    {[
                      {
                        label: "configured",
                        value: config.outbounds.length,
                        icon: Server,
                      },
                      {
                        label: "registered",
                        value: config.clients.length,
                        icon: Users,
                      },
                      {
                        label: "assigned",
                        value: config.clients.filter((c) => c.outboundId)
                          .length,
                        icon: GitBranch,
                      },
                      {
                        label: "live",
                        value: runtime ? runtime.connections : "—",
                        icon: Activity,
                      },
                    ].map((stat) => (
                      <div className="stat" key={stat.label}>
                        <div>
                          <span>{t(stat.label as Key)}</span>
                          <stat.icon size={18} />
                        </div>
                        <strong>{stat.value}</strong>
                        <small>
                          {t(
                            stat.label === "live"
                              ? "runtimeStatus"
                              : "localOnly",
                          )}
                        </small>
                      </div>
                    ))}
                  </div>
                  <div className="engine-banner">
                    <span className="engine-icon">
                      <Shield size={23} />
                    </span>
                    <div>
                      <h3>{engineActive ? rt.running : t("engineTitle")}</h3>
                      <p>{t("engineDesc")}</p>
                      <button
                        className="engine-link"
                        onClick={() => setPage("network")}
                      >
                        {rt.network}
                        <ArrowRight size={14} />
                      </button>
                    </div>
                    <span className="version">v0.2</span>
                  </div>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>{t("connections")}</h2>
                        <p>{t("mapDesc")}</p>
                      </div>
                      <GitBranch size={21} />
                    </div>
                    {clientRoutes()}
                  </section>
                  <div className="policy-card">
                    <LockKeyhole size={19} />
                    <div>
                      <strong>{t("deny")}</strong>
                      <p>{t("denyDesc")}</p>
                    </div>
                  </div>
                </>
              )}
              {page === "outbounds" && (
                <section className="panel">
                  <div className="toolbar">
                    <div className="search">
                      <Search size={17} />
                      <input
                        aria-label={t("search")}
                        placeholder={t("search")}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </div>
                    <select
                      aria-label={t("protocol")}
                      value={protocol}
                      onChange={(e) => setProtocol(e.target.value)}
                    >
                      <option value="all">{t("all")}</option>
                      <option value="wireguard">WireGuard</option>
                      <option value="http">HTTP CONNECT</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                  </div>
                  {!config.outbounds.length ? (
                    <Empty
                      icon={<Server size={29} />}
                      title={t("noOutbounds")}
                      description={t("noOutboundsDesc")}
                    >
                      {add("outbound")}
                    </Empty>
                  ) : !filtered.length ? (
                    <p className="empty">{t("noResults")}</p>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            {(
                              [
                                "name",
                                "protocol",
                                "endpoint",
                                "status",
                                "actions",
                              ] as Key[]
                            ).map((k) => (
                              <th key={k}>{t(k)}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map((o) => (
                            <tr key={o.id}>
                              <td>
                                <div className="name-cell">
                                  <span className="node-icon mint">
                                    <Server size={18} />
                                  </span>
                                  <strong>{o.name}</strong>
                                </div>
                              </td>
                              <td>
                                <span className="protocol">
                                  {o.protocol === "wireguard"
                                    ? "WireGuard"
                                    : o.protocol.toUpperCase()}
                                </span>
                              </td>
                              <td>
                                <code>{endpoint(o)}</code>
                              </td>
                              <td>
                                <span className="badge">
                                  <span />
                                  {t("draft")}
                                </span>
                              </td>
                              <td>{actions("outbound", o)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}
              {page === "clients" && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      {t("clients")}{" "}
                      <span className="count">{config.clients.length}</span>
                    </h2>
                    <Users size={20} />
                  </div>
                  {!config.clients.length ? (
                    <Empty
                      icon={<Users size={29} />}
                      title={t("noClients")}
                      description={t("noClientsDesc")}
                    >
                      {add("client")}
                    </Empty>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            {(
                              [
                                "name",
                                "kind",
                                "identity",
                                "outbound",
                                "actions",
                              ] as Key[]
                            ).map((k) => (
                              <th key={k}>{t(k)}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {config.clients.map((c) => (
                            <tr key={c.id}>
                              <td>
                                <strong>{c.name}</strong>
                              </td>
                              <td>{t(c.kind)}</td>
                              <td>
                                <code>{c.identity}</code>
                              </td>
                              <td>
                                <select
                                  disabled={busy}
                                  aria-label={`${t("outbound")} ${c.name}`}
                                  value={c.outboundId}
                                  onChange={(e) =>
                                    void commit({
                                      ...config,
                                      clients: config.clients.map((item) =>
                                        item.id === c.id
                                          ? {
                                              ...item,
                                              outboundId: e.target.value,
                                            }
                                          : item,
                                      ),
                                    })
                                  }
                                >
                                  <option value="">{t("blocked")}</option>
                                  {config.outbounds.map((o) => (
                                    <option key={o.id} value={o.id}>
                                      {o.name}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>{actions("client", c)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}
              {page === "routing" && (
                <>
                  <div className="engine-banner">
                    <LockKeyhole size={24} />
                    <div>
                      <h3>{t("deny")}</h3>
                      <p>{t("denyDesc")}</p>
                    </div>
                  </div>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>{t("routeTo")}</h2>
                        <p>{t("unavailable")}</p>
                      </div>
                      <GitBranch size={21} />
                    </div>
                    {clientRoutes()}
                  </section>
                </>
              )}
              {page === "network" && (
                <RuntimePanel config={config} onSaved={setConfig} />
              )}
              {page === "settings" && (
                <section className="panel settings">
                  <div className="setting">
                    <div>
                      <h2>{t("language")}</h2>
                      <p>{t("languageDesc")}</p>
                    </div>
                    {languageSelect}
                  </div>
                  <div className="setting">
                    <div>
                      <h2>{t("storage")}</h2>
                      <p>{t("storageDesc")}</p>
                      <span className="storage-mode">
                        {t(isDesktop() ? "desktopStorage" : hasRuntime() ? 'serviceStorage' : "browserStorage")}
                      </span>
                    </div>
                    <LockKeyhole size={24} />
                  </div>
                  <div className="setting">
                    <div>
                      <h2>{t("backup")}</h2>
                      <p>{t("backupDesc")}</p>
                    </div>
                    <button onClick={exportConfig}>
                      <ArrowDownToLine size={17} />
                      {t("export")}
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
          <footer className="content-footer">
            <span>
              <span className="tiny-dot" />
              {t("localOnly")}
            </span>
            <span>
              VPNtoProxy <span className="muted">/ 0.2.0</span>
            </span>
          </footer>
        </div>
      </main>
      {editor && (
        <Modal
          title={t(
            editor.type === "outbound"
              ? editor.value
                ? "editOutbound"
                : "addOutbound"
              : editor.value
                ? "editClient"
                : "addClient",
          )}
          onClose={() => setEditor(null)}
          busy={busy}
        >
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              <label>
                {t("name")}
                <input
                  name="name"
                  defaultValue={editor.value?.name}
                  autoFocus
                  required
                  maxLength={100}
                  placeholder={
                    editor.type === "outbound" ? "Office VPN" : "Laptop"
                  }
                />
              </label>
              {editor.type === "outbound" ? (
                <>
                  <label>
                    {t("protocol")}
                    <select
                      name="protocol"
                      value={editProtocol}
                      onChange={(e) =>
                        setEditProtocol(e.target.value as Protocol)
                      }
                    >
                      <option value="wireguard">WireGuard</option>
                      <option value="http">HTTP CONNECT</option>
                      <option value="socks5">SOCKS5</option>
                      <option value="https">HTTPS proxy (TLS)</option>
                      <option value="socks4">SOCKS4</option>
                      <option value="socks4a">SOCKS4a</option>
                      <option value="direct">{rt.direct}</option>
                    </select>
                  </label>
                  <div className="form-row">
                    <label>
                      {t("host")}
                      <input
                        name="host"
                        defaultValue={editor.value?.host}
                        required={editProtocol !== "direct"}
                        disabled={editProtocol === "direct"}
                        maxLength={253}
                        placeholder="vpn.example.com"
                      />
                    </label>
                    <label>
                      {t("port")}
                      <input
                        name="port"
                        type="number"
                        min="1"
                        max="65535"
                        step="1"
                        defaultValue={editor.value?.port ?? 1080}
                        required={editProtocol !== "direct"}
                        disabled={editProtocol === "direct"}
                      />
                    </label>
                  </div>
                  <p className="form-hint">{t("endpointHint")}</p>
                  <label>
                    {rt.username}
                    <input
                      name="username"
                      defaultValue={editor.value?.username}
                      maxLength={255}
                      autoComplete="off"
                    />
                  </label>
                  {hasRuntime() && (
                    <label>
                      {rt.password}
                      <input
                        name="password"
                        type="password"
                        maxLength={255}
                        autoComplete="new-password"
                      />
                      <span className="form-hint">{rt.passwordHint}</span>
                    </label>
                  )}
                  <div className="form-info">
                    <CircleHelp size={17} />
                    {t("configHint")}
                  </div>
                </>
              ) : (
                <>
                  <label>
                    {t("kind")}
                    <select
                      name="kind"
                      defaultValue={editor.value?.kind ?? "proxy"}
                    >
                      <option value="vpn">{t("vpn")}</option>
                      <option value="proxy">{t("proxy")}</option>
                    </select>
                  </label>
                  <label>
                    {t("identity")}
                    <input
                      name="identity"
                      defaultValue={editor.value?.identity}
                      required
                      maxLength={256}
                      placeholder="laptop-a"
                    />
                  </label>
                  <p className="form-hint">{t("identityHint")}</p>
                  <label>
                    {t("outbound")}
                    <select
                      name="outboundId"
                      defaultValue={editor.value?.outboundId ?? ""}
                    >
                      <option value="">{t("blocked")}</option>
                      {config.outbounds.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {error && (
                <p className="error" role="alert">
                  {t(error)}
                </p>
              )}
              <div className="modal-actions">
                <button type="button" onClick={() => setEditor(null)}>
                  {t("cancel")}
                </button>
                <button className="primary" type="submit">
                  {t(busy ? "saving" : "save")}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
      {removal && (
        <Modal
          title={t("confirmDelete", { name: removal.name })}
          onClose={() => setRemoval(null)}
          busy={busy}
        >
          <p>{t("deleteNote")}</p>
          {error && (
            <p className="error" role="alert">
              {t(error)}
            </p>
          )}
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setRemoval(null)}>
              {t("cancel")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t("remove")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function Empty({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-art">
        <div />
        <span>{icon}</span>
        <div />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
