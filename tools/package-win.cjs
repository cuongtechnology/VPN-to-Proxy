const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
async function packageWindows() {
  if (process.platform !== "win32")
    throw new Error("This packaging script targets Windows.");
  const target = path.join(root, "release", "VPNtoProxy-win32-x64");
  await fs.mkdir(target, { recursive: true });
  let runtime = process.env.ELECTRON_RUNTIME;
  if (!runtime) {
    try {
      runtime = path.dirname(require("electron"));
    } catch {}
  }
  if (runtime) await fs.cp(runtime, target, { recursive: true });
  else {
    const archive = process.env.ELECTRON_ZIP;
    if (!archive)
      throw new Error(
        "Set ELECTRON_ZIP to an official Electron 37.10.3 Windows x64 zip, or install the pinned electron devDependency.",
      );
    const powershell = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:VPN_PACKAGE_ZIP -DestinationPath $env:VPN_PACKAGE_TARGET -Force",
      ],
      {
        env: {
          ...process.env,
          VPN_PACKAGE_ZIP: path.resolve(archive),
          VPN_PACKAGE_TARGET: target,
        },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (powershell.status !== 0)
      throw new Error("Electron extraction failed: " + powershell.stderr);
  }
  const app = path.join(target, "resources", "app");
  await fs.mkdir(app, { recursive: true });
  for (const folder of ["desktop", "server"])
    await fs.cp(path.join(root, folder), path.join(app, folder), {
      recursive: true,
      filter: (source) => !source.includes(path.sep + "test"),
    });
  await fs.cp(
    path.join(root, "frontend", "dist"),
    path.join(app, "frontend", "dist"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(app, "package.json"),
    JSON.stringify(
      {
        name: "vpntoproxy",
        productName: "VPNtoProxy",
        version: "0.2.0",
        main: "desktop/main.cjs",
        private: true,
      },
      null,
      2,
    ),
  );
  await fs.mkdir(path.join(target, "licenses"), { recursive: true });
  for (const name of ["react", "react-dom", "scheduler", "lucide-react"])
    await fs.copyFile(
      path.join(root, "frontend", "node_modules", name, "LICENSE"),
      path.join(target, "licenses", `${name}.txt`),
    );
  for (const file of [
    "README.md",
    "README.vi.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ])
    await fs.copyFile(
      path.join(root, file),
      path.join(target, file === "LICENSE" ? "LICENSE-VPNtoProxy.txt" : file),
    );
  await fs.rename(
    path.join(target, "electron.exe"),
    path.join(target, "VPNtoProxy.exe"),
  );
  console.log(path.join(target, "VPNtoProxy.exe"));
}
packageWindows().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
