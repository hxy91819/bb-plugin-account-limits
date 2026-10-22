import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { panelStyles } from "./panel-styles.js";

const chrome = process.env.CHROME_BIN ?? [
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(path => existsSync(path));

// JSDOM cannot measure overflow. Exercise the plugin CSS inside BB's capped
// sidebar disclosure in Chromium, including content that grows after a refresh.
test("compact content has one continuous host-owned scroll viewport", { skip: !chrome, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "quota-scroll-test-"));
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
    await writeFile(file, `<!doctype html><body>${frames}<pre id="result"></pre><script>
      window.onload = () => {
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
        document.querySelector('#result').textContent = JSON.stringify(results);
      };
    </script>`);
    const { stdout } = await promisify(execFile)(chrome!, [
      "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
      `--user-data-dir=${join(directory, "profile")}`, "--dump-dom", "--virtual-time-budget=1000", `file://${file}`,
    ], { timeout: 20_000, maxBuffer: 2_000_000 });
    const output = stdout.match(/<pre id="result">([^<]+)<\/pre>/u)?.[1];
    assert.ok(output, "Browser must report layout measurements");
    const results = JSON.parse(output) as Array<{ width: string; height: string; compactHeight: number; scrollers: string[]; distance: number; bottomVisible: boolean }>;
    assert.equal(results.length, 6);
    for (const result of results) {
      assert.ok(result.compactHeight < 160, "Short content must not reserve a tall empty viewport");
      assert.deepEqual(result.scrollers, ["host"], JSON.stringify(result));
      assert.equal(result.distance, 120, "Scrolling the host must move the visible content continuously");
      assert.equal(result.bottomVisible, true, "The final account must remain reachable");
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
