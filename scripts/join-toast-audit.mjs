import { spawn } from "node:child_process";
import WebSocket from "ws";

const APP = process.env.JOIN_AUDIT_APP_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const DEBUG_PORT = Number(process.env.JOIN_AUDIT_CDP_PORT ?? 9444);
const GUEST_DEBUG_PORT = DEBUG_PORT + 1;
const ERROR_TEXT = "The session is not connected. Your action was not sent.";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForEndpoint(url, timeoutMs = 10_000) {
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

async function createRoom() {
  const response = await fetch(`${APP}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostName: "Join Audit Host",
      title: "Join toast audit",
      admitMode: "auto",
    }),
  });
  if (!response.ok) throw new Error(`Room creation failed: ${response.status}`);
  return response.json();
}

class CdpPage {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
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

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await sleep(800);
  }
}

async function connectToPage(debugPort = DEBUG_PORT) {
  const response = await waitForEndpoint(
    `http://127.0.0.1:${debugPort}/json/list`,
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
  return page;
}

async function observeToasts(page, durationMs = 4_000) {
  const deadline = Date.now() + durationMs;
  const observedToasts = new Set();
  while (Date.now() < deadline) {
    const toasts = await page.evaluate(
      `[...document.querySelectorAll('[data-sonner-toast]')].map((toast) => (toast.textContent || '').trim())`,
    );
    for (const toast of toasts) observedToasts.add(toast);
    if (toasts.some((toast) => toast.includes(ERROR_TEXT))) break;
    await sleep(100);
  }
  return observedToasts;
}

/** Polls until the expression is true so slow dev-server compiles do not flake. */
async function waitForExpression(page, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  const room = await createRoom();
  const chromeOptions = (debugPort, suffix) => [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=/tmp/codesync-join-audit-${process.pid}-${suffix}`,
    "about:blank",
  ];
  const chrome = spawn(CHROME, chromeOptions(DEBUG_PORT, "host"), {
    stdio: "ignore",
  });
  const guestChrome = spawn(CHROME, chromeOptions(GUEST_DEBUG_PORT, "guest"), {
    stdio: "ignore",
  });

  try {
    const page = await connectToPage();
    await page.navigate(APP);
    await page.evaluate(`(() => {
      localStorage.setItem('codesync:name', 'Join Audit Host');
      localStorage.setItem('codesync:host:${room.roomKey}', ${JSON.stringify(room.hostToken)});
      return true;
    })()`);

    await page.navigate(`${APP}/room/${room.roomKey}`);
    const hostToasts = await observeToasts(page);
    const roomVisible = await waitForExpression(
      page,
      `document.body.textContent.includes('Join toast audit')`,
    );

    const guestPage = await connectToPage(GUEST_DEBUG_PORT);
    await guestPage.navigate(APP);
    await guestPage.evaluate(`(() => {
      localStorage.setItem('codesync:name', 'Join Audit Guest');
      return true;
    })()`);
    await guestPage.navigate(`${APP}/join/${room.roomKey}`);
    const guestButtonFound = await guestPage.evaluate(`(() => {
      const input = document.querySelector('#display-name');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Join Audit Guest');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const deadline = Date.now() + 15_000;
    let guestClickState = null;
    while (Date.now() < deadline) {
      guestClickState = await guestPage.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(
          (candidate) => (candidate.textContent || '').trim() === 'Join session',
        );
        const state = {
          found: Boolean(button),
          disabled: button?.disabled ?? true,
          inputValue: document.querySelector('#display-name')?.value ?? null,
        };
        if (button && !button.disabled) button.click();
        return state;
      })()`);
      if (guestClickState.found && !guestClickState.disabled) break;
      await sleep(300);
    }
    const guestClicked = guestClickState.found && !guestClickState.disabled;
    const guestToasts = await observeToasts(guestPage);
    const guestRoomVisible = await waitForExpression(
      guestPage,
      `location.pathname.startsWith('/room/') && document.body.textContent.includes('Join toast audit')`,
    );

    const disconnectedToast = [...hostToasts, ...guestToasts].find((toast) =>
      toast.includes(ERROR_TEXT),
    );
    const report = {
      roomVisible,
      guestButtonFound,
      guestClicked,
      guestClickState,
      guestRoomVisible,
      disconnectedToast: disconnectedToast ?? null,
      hostToasts: [...hostToasts],
      guestToasts: [...guestToasts],
    };
    console.log(JSON.stringify(report, null, 2));

    if (!roomVisible) throw new Error("The joined room did not become visible");
    if (!guestButtonFound || !guestClicked || !guestRoomVisible) {
      throw new Error("The guest did not complete the lobby join");
    }
    if (disconnectedToast) {
      throw new Error(
        `Join displayed the disconnected toast: ${disconnectedToast}`,
      );
    }
  } finally {
    chrome.kill("SIGTERM");
    guestChrome.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
