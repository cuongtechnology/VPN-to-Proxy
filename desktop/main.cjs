const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
} = require("electron");
const path = require("node:path");
const { Store } = require("../server/store.cjs");
const { Controller } = require("../server/controller.cjs");
let controller,
  window,
  exiting = false;
if (process.env.VPNTO_PROXY_DATA)
  app.setPath("userData", path.resolve(process.env.VPNTO_PROXY_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.whenReady().then(async () => {
    try {
      const data =
        process.env.VPNTO_PROXY_DATA ||
        path.join(app.getPath("userData"), "data");
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("OS credential encryption is unavailable.");
      controller = new Controller(
        new Store(path.join(data, "config.json"), {
          encrypt: (s) => safeStorage.encryptString(s),
          decrypt: (b) => safeStorage.decryptString(b),
        }),
      );
      await controller.init();
      ipcMain.handle("vpntoproxy", async (event, method, args) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("unauthorized");
        if (method === "chooseEngine") {
          const result = await dialog.showOpenDialog(window, {
            properties: ["openFile"],
            filters: [
              {
                name: "sing-box",
                extensions: process.platform === "win32" ? ["exe"] : ["*"],
              },
            ],
          });
          return result.canceled ? null : result.filePaths[0];
        }
        return controller.call(method, args);
      });
      window = new BrowserWindow({
        title: "VPNtoProxy",
        width: 1360,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        backgroundColor: "#f5f7f6",
        autoHideMenuBar: true,
        show: !process.env.VPNTO_PROXY_SMOKE,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      await window.loadFile(
        path.join(__dirname, "../frontend/dist/index.html"),
      );
      if (process.env.VPNTO_PROXY_SMOKE) {
        const secretValue = require("node:crypto")
          .randomBytes(20)
          .toString("hex");
        await controller.call("save", {
          config: {
            version: 1,
            outbounds: [],
            clients: [
              {
                id: "smoke",
                name: "Smoke",
                kind: "proxy",
                identity: "smoke",
                outboundId: "",
              },
            ],
          },
          secrets: [
            { scope: "client", id: "smoke", value: { password: secretValue } },
          ],
        });
        const persisted = await require("node:fs/promises").readFile(
          path.join(data, "config.json"),
          "utf8",
        );
        if (persisted.includes(secretValue))
          throw new Error("Credential appeared in plaintext");
        await controller.store.load();
        if (controller.store.secret("client", "smoke").password !== secretValue)
          throw new Error("Credential round-trip failed");
        const result = await window.webContents.executeJavaScript(
          `window.vpntoproxy.call('status').then(s => ({title: document.title, encrypted: s.persistentSecrets, running: s.running}))`,
        );
        result.secretRoundTrip = true;
        require("node:fs").writeFileSync(
          process.env.VPNTO_PROXY_SMOKE,
          JSON.stringify(result),
        );
        app.quit();
      }
    } catch (e) {
      if (process.env.VPNTO_PROXY_SMOKE)
        require("node:fs").writeFileSync(
          process.env.VPNTO_PROXY_SMOKE,
          JSON.stringify({ error: e.message }),
        );
      else dialog.showErrorBox("VPNtoProxy", e.message);
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (controller && !exiting) {
      event.preventDefault();
      exiting = true;
      controller.close().finally(() => app.quit());
    }
  });
}
