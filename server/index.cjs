const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Store } = require("./store.cjs");
const { Controller } = require("./controller.cjs");
async function serve({ directory, port = 47831 } = {}) {
  const controller = new Controller(
    new Store(
      path.join(directory || path.resolve(".local-data"), "config.json"),
    ),
  );
  await controller.init();
  const token = crypto.randomBytes(32).toString("hex");
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin)
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.url === "/api" && req.method === "POST") {
      if (
        req.headers["x-vpntoproxy-token"] !== token ||
        !req.headers["content-type"]?.startsWith("application/json")
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 2 * 1024 * 1024)
            throw new Error("requestTooLarge");
        }
        const { method, args } = JSON.parse(body);
        const value = await controller.call(method, args);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ value }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: /^[A-Za-z][A-Za-z0-9]{1,60}$/.test(e.message)
              ? e.message
              : "operationFailed",
          }),
        );
      }
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const requested = decodeURIComponent(new URL(req.url, origin).pathname);
      const root = path.resolve(__dirname, "../frontend/dist");
      const file = path.resolve(
        root,
        "." + (requested === "/" ? "/index.html" : requested),
      );
      if (!file.startsWith(root + path.sep)) throw new Error("notFound");
      const data = await fs.readFile(file);
      const ext = path.extname(file);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[ext] || "application/octet-stream",
      );
      if (ext === ".html")
        res.end(
          data
            .toString()
            .replace(
              "</head>",
              `<meta name="vpntoproxy-token" content="${token}"></head>`,
            ),
        );
      else res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    controller,
    origin,
    close: async () => {
      await controller.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
if (require.main === module)
  serve({
    directory: process.env.VPNTO_PROXY_DATA,
    port: Number(process.env.PORT || 47831),
  })
    .then((app) => {
      console.log(`VPNtoProxy: ${app.origin}`);
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await app.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((e) => {
      console.error("Unable to start VPNtoProxy:", e.message);
      process.exitCode = 1;
    });
module.exports = { serve };
