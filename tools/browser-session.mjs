import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function browserSession() {
  if (!process.env.CHROME_PATH) throw new Error('Set CHROME_PATH to a Chromium executable.');
  await mkdir('.tools/browser-runtime', { recursive: true });
  const profile = await mkdtemp(resolve('.tools/browser-runtime/profile-'));
  const child = spawn(process.env.CHROME_PATH, ['--headless', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...JSON.parse(process.env.SMOKE_CHROME_ARGS || '[]'), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  const address = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Browser startup timeout')); }, 15000); child.on('error', reject); child.stderr.on('data', b => { log += b; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } }); });
  const ws = new WebSocket(address);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const pending = new Map(), errors = []; let id = 0;
  ws.onmessage = event => { const r = JSON.parse(event.data); if (r.id && pending.has(r.id)) { const p = pending.get(r.id); pending.delete(r.id); clearTimeout(p.timer); r.error ? p.reject(new Error(r.error.message)) : p.resolve(r.result); } if (r.method === 'Runtime.exceptionThrown') errors.push(r.params.exceptionDetails.text); };
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timed out')); }, 15000); pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' }); const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => command(method, params, sessionId);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const wait = async expression => { const start = Date.now(); while (Date.now() - start < 10000) { try { if (await evaluate(`Boolean(${expression})`)) return; } catch (e) { if (!/context|navigated/i.test(e.message)) throw e; } await new Promise(r => setTimeout(r, 100)); } throw new Error('Condition timed out: ' + expression); };
  const click = text => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('Button missing: ' + ${JSON.stringify(text)}); b.click(); })()`);
  const fill = (selector, value) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('Field missing'); const p = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`);
  const reload = async () => { const old = await evaluate('performance.timeOrigin'); await send('Page.reload'); await wait(`performance.timeOrigin !== ${old} && document.readyState === 'complete'`); };
  const screenshot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(file, Buffer.from(r.data, 'base64')); };
  return { send, evaluate, wait, click, fill, reload, screenshot, errors, close: async () => { try { await command('Browser.close'); } catch {} ws.close(); child.kill(); await writeFile('.tools/browser-runtime/chromium.log', log); } };
}
