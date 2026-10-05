# Third-party notices

VPNtoProxy's original application code is distributed under the [MIT license](LICENSE).

The Windows desktop distribution includes Electron and its Chromium/Node.js components. Preserve the Electron `LICENSE` and `LICENSES.chromium.html` files shipped alongside the executable. They contain the runtime's license and bundled dependency notices.

The frontend bundles React, React DOM, Scheduler and Lucide icons. Their upstream license texts are collected in `licenses/` when packaging. Vite, TypeScript and Vitest are build/test tools and are not required on end-user machines.

WireGuard traffic is delegated to a separately installed sing-box executable. sing-box is not bundled with this release. Obtain official builds and their license/source information from [SagerNet/sing-box](https://github.com/SagerNet/sing-box). VPNtoProxy does not include copied sing-box or WireGuard implementation code.

Do not remove runtime licenses when repackaging the Windows folder.
