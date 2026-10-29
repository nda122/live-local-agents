// Dedicated temporary browser; JSON-lines IPC only, no arbitrary code tool.
const readline = require("node:readline");
const dns = require("node:dns").promises;
const { chromium } = require("playwright");
let browser,
  context,
  page,
  targets = [],
  fingerprints = [],
  revision = 0;
const targetFingerprint = (el) => {
  const clone = el.cloneNode(true);
  if (clone.getAttribute("style") === "") clone.removeAttribute("style");
  return clone.outerHTML;
};
function isPublic(ip) {
  if (ip.includes(":"))
    return !(
      /^(::|fc|fd|fe[89ab]|ff)/i.test(ip) ||
      ip.toLowerCase().includes("::ffff:")
    );
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
async function safeURL(url) {
  const u = new URL(url);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port
  )
    throw Error("Use a public HTTP/HTTPS URL on its default port");
  const results = await dns.lookup(u.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
  });
  if (!results.length || results.some((r) => !isPublic(r.address)))
    throw Error("Private/local network destinations are blocked");
  return u.href;
}
async function ensure() {
  if (page && !page.isClosed()) return;
  browser = await chromium.launch({
    headless: false,
    channel:
      process.env.LIVE_AGENT_BROWSER_CHANNEL ||
      (process.platform === "darwin" ? "chrome" : "chromium"),
  });
  context = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: "block",
    viewport: { width: 1100, height: 760 },
  });
  await context.route("**/*", async (route) => {
    try {
      await safeURL(route.request().url());
      await route.continue();
    } catch {
      await route.abort();
    }
  });
  page = await context.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  context.on("page", (p) => {
    if (p !== page) p.close().catch(() => {});
  });
}
async function snapshot() {
  await ensure();
  targets = [];
  fingerprints = [];
  revision++;
  const elements = await page
    .locator(
      "a,button,input:not([type=hidden]),textarea,select,[role=button],[role=link]",
    )
    .elementHandles();
  const items = [];
  for (const handle of elements) {
    if (items.length >= 25) break;
    if (!(await handle.isVisible())) continue;
    const info = await handle.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      label: (
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.innerText ||
        el.getAttribute("name") ||
        ""
      )
        .trim()
        .slice(0, 100),
      ...(el.tagName === "SELECT"
        ? {
            options: Array.from(el.options)
              .slice(0, 15)
              .map((o) => ({ value: o.value, label: o.text.slice(0, 60) })),
          }
        : {}),
    }));
    if (info.type === "password" || info.type === "file") continue;
    targets.push(handle);
    fingerprints.push(await handle.evaluate(targetFingerprint));
    items.push({ target: targets.length, ...info });
  }
  return {
    url: page.url(),
    title: await page.title(),
    revision,
    targets: items,
    text: (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).slice(0, 800),
    scroll: await page.evaluate(() => ({ x: scrollX, y: scrollY })),
    screenshot: (await page.screenshot({ type: "jpeg", quality: 55 })).toString(
      "base64",
    ),
  };
}
async function dispatch(cmd) {
  if (cmd.op === "close") {
    await browser?.close();
    browser = context = page = null;
    targets = [];
    revision++;
    return { closed: true };
  }
  await ensure();
  if (cmd.op === "open") {
    await page.goto(await safeURL(cmd.url), {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    return snapshot();
  }
  if (cmd.op === "observe") return snapshot();
  if (cmd.op !== "action") throw Error("Unknown browser operation");
  if (cmd.revision !== revision || cmd.url !== page.url())
    throw Error("Page changed; observe again before proposing an action");
  const a = cmd.action;
  const before = {
    url: page.url(),
    text: await page.locator("body").innerText(),
    y: await page.evaluate(() => scrollY),
  };
  let verified = false,
    detail = "Action dispatched; the intended outcome still needs review.";
  if (a === "navigate")
    await page.goto(await safeURL(cmd.value), {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
  else if (a === "back" || a === "forward")
    await page[a === "back" ? "goBack" : "goForward"]({
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
  else if (a === "scroll") {
    if (!["up", "down"].includes(cmd.value))
      throw Error("Scroll value must be up or down");
    await page.evaluate(
      (direction) =>
        window.scrollBy(
          0,
          (direction === "down" ? 1 : -1) * innerHeight * 0.75,
        ),
      cmd.value,
    );
    verified = (await page.evaluate(() => scrollY)) !== before.y;
    detail = verified
      ? "Page scroll position changed."
      : "Already at the scroll boundary.";
  } else {
    const target = targets[cmd.target - 1];
    if (!target) throw Error("Unknown target; observe again");
    if (
      (await target.evaluate(targetFingerprint)) !==
      fingerprints[cmd.target - 1]
    )
      throw Error("Target changed; observe again and request a new approval");
    const label = await target.evaluate((el) =>
      (
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.innerText ||
        el.getAttribute("name") ||
        ""
      )
        .trim()
        .slice(0, 160),
    );
    if (label !== cmd.label) throw Error("Target changed; approval is stale");
    if (a === "click") await target.click({ timeout: 5000, noWaitAfter: true });
    else if (a === "fill") {
      const type = await target.getAttribute("type");
      if (["password", "file"].includes(type))
        throw Error("Password and file fields require manual interaction");
      await target.fill(cmd.value, { timeout: 5000 });
      verified = (await target.inputValue()) === cmd.value;
      detail = "Field value matches approved text.";
    } else if (a === "select") {
      await target.selectOption(cmd.value, { timeout: 5000 });
      verified = (await target.inputValue()) === cmd.value;
      detail = "Dropdown value matches approved option.";
    } else if (a === "press") {
      if (
        !["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"].includes(
          cmd.value,
        )
      )
        throw Error("Unsupported key");
      await target.press(cmd.value, { timeout: 5000 });
    } else throw Error("Unsupported action");
  }
  if (["navigate", "back", "forward"].includes(a)) {
    verified = page.url() !== before.url;
    detail = verified ? "Browser URL changed." : "URL did not change.";
  }
  if (["click", "press"].includes(a)) {
    verified =
      page.url() !== before.url ||
      (await page.locator("body").innerText()) !== before.text;
    detail = verified
      ? "Page URL or visible text changed; confirm it matches your intended outcome."
      : "No visible result detected; review before continuing.";
  }
  const state = await snapshot();
  state.verification = { verified, detail };
  return state;
}
let queue = Promise.resolve();
if (require.main === module) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    queue = queue.then(async () => {
      try {
        const cmd = JSON.parse(line);
        const result = await dispatch(cmd);
        process.stdout.write(JSON.stringify({ result }) + "\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: error.message }) + "\n");
      }
    });
  });
  process.on("SIGTERM", async () => {
    await browser?.close();
    process.exit();
  });
  process.stdin.on("end", async () => {
    await browser?.close();
    process.exit();
  });
}
module.exports = {
  dispatch,
  setTestPage(p) {
    page = p;
  },
  safeURL,
};
