import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { panelStyles } from "./panel-styles.js";

const chrome = process.env.CHROME_BIN ?? [
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(path => existsSync(path));

// JSDOM cannot measure overflow. Exercise the plugin CSS inside BB's capped
// sidebar disclosure in Chromium, including content that grows after a refresh.
test("compact content has one continuous host-owned scroll viewport", { skip: !chrome, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "quota-scroll-test-"));
  const browser = spawn(chrome!, [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
    "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
    `--user-data-dir=${join(directory, "profile")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  browser.stderr.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
  let startupError: Error | undefined;
  browser.on("error", error => { startupError = error; });
  let socket: WebSocket | undefined;
  try {
    const frames = [400, 800, 1100].flatMap(height => [280, 390].map(width => {
      const document = `<style>html{font-size:16px}body{margin:0}${panelStyles}</style>
        <div id="host" style="max-height:20rem;overflow:auto">
          <section class="limits-panel limits-compact">
            <header class="limits-compact-head">Account quotas</header>
            <div class="limits-compact-body"><p style="height:40px">One account</p></div>
          </section>
        </div>`;
      const escaped = document.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      return `<iframe width="${width}" height="${height}" srcdoc="${escaped}"></iframe>`;
    })).join("");
    const file = join(directory, "scroll.html");
    await writeFile(file, `<!doctype html><body>${frames}`);
    let port: string | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (startupError) throw startupError;
      assert.equal(browser.exitCode, null, `Chromium exited before startup: ${diagnostics}`);
      try { port = (await readFile(join(directory, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(port, `Chromium (${chrome}) must start its debugging endpoint: ${diagnostics}`);
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = tabs.find(tab => tab.type === "page");
    assert.ok(page, "Chromium must expose a page");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    const connection = socket;
    await new Promise<void>((resolve, reject) => {
      connection.addEventListener("open", () => resolve(), { once: true });
      connection.addEventListener("error", () => reject(new Error("Cannot connect to Chromium")), { once: true });
    });
    let sequence = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    connection.addEventListener("message", event => {
      const response = JSON.parse(String(event.data));
      const task = pending.get(response.id);
      if (!task) return;
      pending.delete(response.id);
      if (response.error) task.reject(new Error(JSON.stringify(response.error)));
      else task.resolve(response.result);
    });
    const call = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      connection.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string) => {
      const result = await call("Runtime.evaluate", { expression, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, "Browser evaluation must succeed");
      return result.result.value;
    };
    await call("Page.navigate", { url: `file://${file}` });
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      ready = await evaluate(`document.readyState === 'complete' && document.querySelectorAll('iframe').length === 6 &&
        [...document.querySelectorAll('iframe')].every(frame => frame.contentDocument?.querySelector('.limits-compact-body'))`);
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, "All sidebar fixtures must load before measuring overflow");
    const results = await evaluate(`(() => {
        const results = [...document.querySelectorAll('iframe')].map(frame => {
          const doc = frame.contentDocument, host = doc.querySelector('#host');
          const panel = doc.querySelector('.limits-compact'), body = doc.querySelector('.limits-compact-body');
          const compactHeight = host.getBoundingClientRect().height;
          for (let i = 0; i < 12; i++) body.append(body.firstElementChild.cloneNode(true));
          const scrollers = [host, panel].filter(node =>
            /auto|scroll/.test(frame.contentWindow.getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1
          ).map(node => node.id || node.className);
          const before = body.getBoundingClientRect().top;
          host.scrollTop = 120;
          const distance = before - body.getBoundingClientRect().top;
          host.scrollTop = host.scrollHeight;
          const bottomVisible = body.lastElementChild.getBoundingClientRect().bottom <= host.getBoundingClientRect().bottom + 1;
          return { width: frame.width, height: frame.height, compactHeight, scrollers, distance, bottomVisible };
        });
        return results;
      })()`) as Array<{ width: string; height: string; compactHeight: number; scrollers: string[]; distance: number; bottomVisible: boolean }>;
    assert.equal(results.length, 6);
    for (const result of results) {
      assert.ok(result.compactHeight < 160, "Short content must not reserve a tall empty viewport");
      assert.deepEqual(result.scrollers, ["host"], JSON.stringify(result));
      assert.equal(result.distance, 120, "Scrolling the host must move the visible content continuously");
      assert.equal(result.bottomVisible, true, "The final account must remain reachable");
    }
  } finally {
    socket?.close();
    browser.kill();
    if (browser.pid && browser.exitCode === null && browser.signalCode === null) {
      await new Promise(resolve => browser.once("exit", resolve));
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
