// Run after `npm run dev`. Requires Node 22+ and a Chromium executable.
// CHROME_PATH=/path/to/chrome node tools/smoke-browser.mjs
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const executable = process.env.CHROME_PATH;
if (!executable)
  throw new Error("Set CHROME_PATH to your Chromium executable.");
const origin = process.env.SMOKE_ORIGIN || "http://127.0.0.1:5173";
await mkdir(".tools/browser-smoke", { recursive: true });
const profile = await mkdtemp(resolve(".tools/browser-smoke/profile-"));
const extraArgs = process.env.SMOKE_CHROME_ARGS
  ? JSON.parse(process.env.SMOKE_CHROME_ARGS)
  : [];
const child = spawn(
  executable,
  [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    ...extraArgs,
    "about:blank",
  ],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
);
let browserLog = "";
child.stderr.on("data", (chunk) => {
  browserLog += chunk;
});
let socket;
try {
  const wsUrl = await new Promise((res, rej) => {
    const timer = setTimeout(
      () => rej(new Error("Chromium startup timeout")),
      15000,
    );
    let log = "";
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.stderr.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        res(match[1]);
      }
    });
  });
  socket = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    socket.addEventListener("open", res, { once: true });
    socket.addEventListener("error", rej, { once: true });
  });
  let nextID = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id);
      if (task) {
        pending.delete(message.id);
        clearTimeout(task.timer);
        message.error
          ? task.reject(new Error(message.error.message))
          : task.resolve(message.result);
      }
    }
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails.text);
  });
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextID;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const { targetId } = await command("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const send = (method, params) => command(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result.value;
  }
  async function wait(expression) {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        if (!/navigated|context|Cannot find context/i.test(error.message))
          throw error;
      }
      await new Promise((r) => setTimeout(r, 75));
    }
    throw new Error(`Browser condition timeout: ${expression}`);
  }
  async function reload() {
    const previous = await evaluate("performance.timeOrigin");
    await send("Page.reload");
    await wait(
      `performance.timeOrigin !== ${previous} && document.readyState === 'complete'`,
    );
  }
  const clickText = (text) =>
    evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('Button missing: ' + ${JSON.stringify(text)}); b.click(); })()`,
    );
  const fill = (name, value) =>
    evaluate(
      `(() => { const e = document.querySelector('[name="${name}"]'); const p = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`,
    );
  const save = async () => {
    await clickText("Save configuration");
    await wait(`!document.querySelector('dialog')`);
  };
  await send("Page.navigate", { url: origin });
  await wait(`document.querySelector('h1')`);
  await evaluate(`localStorage.clear()`);
  await reload();
  await wait(
    `document.body.innerText.includes('Your network starts with a client')`,
  );
  assert.equal(await evaluate(`document.querySelectorAll('.stat').length`), 4);
  await clickText("Add outbound");
  await wait(`document.querySelector('dialog[open]')`);
  await fill("name", "Office VPN");
  await fill("host", "vpn.example.com");
  await save();
  await clickText("Outbounds1");
  await wait(`document.querySelector('table')`);
  await clickText("Add outbound");
  await fill("name", "Singapore proxy");
  await fill("protocol", "socks5");
  await fill("host", "proxy.example.com");
  await fill("port", "1080");
  await save();
  await clickText("Clients");
  await clickText("Add client");
  await fill("name", "Phone A");
  await fill("identity", "phone-a");
  const outboundID = await evaluate(
    `JSON.parse(localStorage.getItem('vpntoproxy.config.v1')).outbounds[0].id`,
  );
  await fill("outboundId", outboundID);
  await save();
  await clickText("Add client");
  await fill("name", "Duplicate phone");
  await fill("identity", "phone-a");
  await clickText("Save configuration");
  await wait(
    `document.querySelector('dialog [role="alert"]')?.textContent.includes('already exists')`,
  );
  await clickText("Cancel");
  await clickText("Outbounds2");
  await evaluate(
    `document.querySelector('button[aria-label="Delete Office VPN"]').click()`,
  );
  await clickText("Delete");
  await wait(
    `document.querySelector('dialog [role="alert"]')?.textContent.includes('before deleting')`,
  );
  await clickText("Cancel");
  await evaluate(
    `document.querySelector('button[aria-label="Edit Singapore proxy"]').click()`,
  );
  await fill("port", "2080");
  await save();
  await reload();
  await wait(`document.querySelector('h1')?.textContent === 'Overview'`);
  assert.equal(
    await evaluate(
      `JSON.parse(localStorage.getItem('vpntoproxy.config.v1')).outbounds[1].port`,
    ),
    2080,
  );
  await clickText("Routing");
  await wait(`document.querySelector('.route')`);
  assert.equal(await evaluate(`document.querySelectorAll('.route').length`), 1);
  await clickText("Overview");
  await evaluate(
    `document.querySelector('select[aria-label="Interface language"]').value = 'vi'; document.querySelector('select[aria-label="Interface language"]').dispatchEvent(new Event('change', { bubbles: true }))`,
  );
  await wait(`document.querySelector('h1')?.textContent === 'Tổng quan'`);
  await reload();
  await wait(
    `document.documentElement.lang === 'vi' && document.querySelector('.route')`,
  );
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    ".tools/browser-smoke/overview-vi.png",
    Buffer.from(screenshot.data, "base64"),
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.ok(
    await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
    "Mobile layout overflows",
  );
  const mobile = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    ".tools/browser-smoke/mobile.png",
    Buffer.from(mobile.data, "base64"),
  );
  await evaluate(`localStorage.setItem('vpntoproxy.config.v1', '{corrupt')`);
  await reload();
  await wait(
    `document.querySelector('[role="alert"]')?.textContent.includes('Không đọc')`,
  );
  assert.equal(
    await evaluate(`localStorage.getItem('vpntoproxy.config.v1')`),
    "{corrupt",
  );
  assert.equal(
    await evaluate(`document.querySelector('.page-heading .primary').disabled`),
    true,
  );
  assert.deepEqual(exceptions, [], "Unexpected browser exceptions");
  console.log(
    "Browser smoke passed: create/edit, duplicate identity rejection, protected delete, persistence, route preview, language persistence, mobile layout, and corrupt-data preservation.",
  );
} finally {
  await writeFile(".tools/browser-smoke/chromium.log", browserLog);
  socket?.close();
  child.kill();
}
