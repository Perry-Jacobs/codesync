import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const APP = process.env.UI_AUDIT_APP_URL ?? "http://localhost:3100";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const DEBUG_PORT = Number(process.env.UI_AUDIT_CDP_PORT ?? 9333);
const OUTPUT = path.resolve(process.env.UI_AUDIT_OUTPUT ?? ".preview-captures");
const ROOM_TITLE = "Visual audit room";
const FILE_NAMES = Array.from(
  { length: 6 },
  (_, index) => `audit-file-${String(index + 1).padStart(2, "0")}.ts`,
);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForEndpoint(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpPage {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await sleep(1800);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ?? "Runtime evaluation failed",
      );
    }
    return result.result?.value;
  }

  async screenshot(name) {
    const result = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    });
    const file = path.join(OUTPUT, `${name}.png`);
    await writeFile(file, Buffer.from(result.data, "base64"));
    return file;
  }
}

async function connectToPage() {
  const response = await waitForEndpoint(
    `http://127.0.0.1:${DEBUG_PORT}/json/list`,
  );
  const targets = await response.json();
  const target = targets.find((entry) => entry.type === "page");
  if (!target) throw new Error("Chrome did not expose a page target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const page = new CdpPage(socket);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return page;
}

async function createRoom() {
  const response = await fetch(`${APP}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostName: "Audit Host",
      title: ROOM_TITLE,
      admitMode: "auto",
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Room creation failed: ${response.status}`);
  return response.json();
}

async function clickButton(page, description, expression) {
  const target = await page.evaluate(`(() => {
    const matches = [...document.querySelectorAll('button')].filter((button) => {
      if (button.disabled || button.getClientRects().length === 0) return false;
      const text = (button.textContent || '').trim();
      const aria = button.getAttribute('aria-label') || '';
      return ${expression};
    });
    const button = matches[0];
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!target) throw new Error(`Could not click ${description}`);
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(300);
}

async function createFiles(page) {
  for (const name of FILE_NAMES) {
    let created = false;
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      await clickButton(
        page,
        "New file",
        `(button.innerHTML || '').includes('lucide-plus')`,
      );
      // Fill the name and submit in one DOM pass so a slow dialog animation
      // cannot leave the audit clicking a create button that is not mounted.
      created = await page.evaluate(`(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let tick = 0; tick < 20; tick += 1) {
          const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
            (node) => node.getClientRects().length > 0 && node.innerText.includes('New file'),
          );
          const input = dialog?.querySelector('input');
          const create = dialog
            ? [...dialog.querySelectorAll('button')].find(
                (button) => (button.textContent || '').trim() === 'Create',
              )
            : null;
          if (dialog && input && create) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, ${JSON.stringify(name)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(50);
            create.click();
            return true;
          }
          await wait(100);
        }
        return false;
      })()`);
      if (created) await sleep(400);
    }
    if (!created) throw new Error(`Could not create ${name}`);
  }
}

async function openFiles(page) {
  const opened = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')];
    let count = 0;
    for (const row of rows) {
      if ((row.textContent || '').includes('audit-file-')) {
        row.click();
        count += 1;
      }
    }
    return count;
  })()`);
  if (opened < FILE_NAMES.length) {
    throw new Error(`Only opened ${opened}/${FILE_NAMES.length} audit files`);
  }
  await sleep(800);
}

async function setMobile(page, width, height) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await sleep(400);
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  const room = await createRoom();
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=/tmp/codesync-ui-audit-${process.pid}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const report = { room, screenshots: [], checks: {}, browserErrors: [] };
  try {
    const page = await connectToPage();
    await page.navigate(APP);
    await page.evaluate(`(() => {
      localStorage.setItem('codesync:name', 'Audit Host');
      localStorage.setItem('codesync:host:${room.roomKey}', ${JSON.stringify(room.hostToken)});
      return true;
    })()`);
    await page.navigate(`${APP}/room/${room.roomKey}`);
    await sleep(2200);

    report.checks.roomVisible = await page.evaluate(
      `document.body.textContent.includes(${JSON.stringify(ROOM_TITLE)})`,
    );
    report.checks.hostVisible = await page.evaluate(
      `document.body.textContent.includes('Audit Host')`,
    );
    report.screenshots.push(
      await page.screenshot("codesync-room-host-desktop"),
    );

    await createFiles(page);
    // Let the per-socket file_op quota reset before opening every file.
    await sleep(11000);
    await openFiles(page);
    report.checks.tabCount = await page.evaluate(
      `document.querySelectorAll('[role="tab"]').length`,
    );
    report.checks.tabLayout = await page.evaluate(`(() => {
      const tablist = document.querySelector('[role="tablist"]');
      const main = tablist?.closest('main');
      const rail = document.querySelector('aside');
      const rect = (element) => element ? {
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        width: Math.round(element.getBoundingClientRect().width),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      } : null;
      return { tablist: rect(tablist), main: rect(main), rail: rect(rail) };
    })()`);
    report.checks.overflowVisible = await page.evaluate(
      `[...document.querySelectorAll('button')].some((button) => (button.getAttribute('aria-label') || '').startsWith('Show '))`,
    );
    report.screenshots.push(await page.screenshot("codesync-room-many-tabs"));

    await clickButton(
      page,
      "overflow menu",
      `(button.getAttribute('aria-label') || '').startsWith('Show ')`,
    );
    report.checks.overflowClicked = true;
    report.checks.overflowMenuVisible = await page.evaluate(
      `document.body.textContent.includes('More open files')`,
    );
    report.screenshots.push(
      await page.screenshot("codesync-room-overflow-menu"),
    );
    await page.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );

    await clickButton(
      page,
      "Host menu",
      `(button.textContent || '').trim().startsWith('Host')`,
    );
    report.screenshots.push(await page.screenshot("codesync-room-host-menu"));

    await page.navigate(APP);
    await sleep(1000);
    report.screenshots.push(await page.screenshot("codesync-landing-delayed"));

    await page.navigate(`${APP}/room/${room.roomKey}`);
    await sleep(4500);
    await setMobile(page, 390, 844);
    report.screenshots.push(await page.screenshot("codesync-room-host-mobile"));
    // A fresh joiner toast sits over the top bar on narrow screens; wait for it
    // to clear so the audit clicks the real control under the overlay.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const covered = await page.evaluate(
        `[...document.querySelectorAll('[data-sonner-toast]')].some((node) => node.getClientRects().length > 0)`,
      );
      if (!covered) break;
      await sleep(300);
    }
    await clickButton(
      page,
      "mobile people panel",
      `(button.getAttribute('aria-label') || '') === 'Toggle people and chat'`,
    );
    await sleep(600);
    report.checks.mobilePeopleDrawer = await page.evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
        (node) => node.getClientRects().length > 0 && node.innerText.includes('PEOPLE'),
      );
      if (!dialog) return false;
      const rect = dialog.getBoundingClientRect();
      return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    })()`);
    report.screenshots.push(
      await page.screenshot("codesync-room-mobile-people"),
    );

    report.browserErrors = page.events
      .filter(
        (event) =>
          event.method === "Runtime.exceptionThrown" ||
          (event.method === "Log.entryAdded" &&
            event.params?.entry?.level === "error"),
      )
      .map(
        (event) =>
          event.params?.exceptionDetails?.text ??
          event.params?.entry?.text ??
          event.method,
      );
  } finally {
    chrome.kill("SIGTERM");
  }

  const reportFile = path.join(OUTPUT, "ui-audit-report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportFile }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
