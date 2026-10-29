const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");
const worker = require("../browser-worker.cjs");
(async () => {
  const browser = await chromium.launch({
    channel:
      process.env.LIVE_AGENT_BROWSER_CHANNEL ||
      (process.platform === "darwin" ? "chrome" : "chromium"),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<input aria-label="Name"><select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select><button onclick="document.querySelector(&quot;h1&quot;).textContent=&quot;Done&quot;">Apply</button><h1>Demo</h1><div style="height:3000px">Long page</div>',
    );
    worker.setTestPage(page);
    let state = await worker.dispatch({ op: "observe" });
    async function act(action, label, value) {
      const t = state.targets.find((t) => t.label === label);
      const result = await worker.dispatch({
        op: "action",
        action,
        target: t?.target,
        label: t?.label,
        value,
        revision: state.revision,
        url: state.url,
      });
      state = result;
      return result;
    }
    assert.ok((await act("fill", "Name", "Ada")).verification.verified);
    assert.ok((await act("select", "Color", "blue")).verification.verified);
    assert.ok((await act("click", "Apply", "")).verification.verified);
    assert.ok((await act("scroll", null, "down")).verification.verified);
    await assert.rejects(
      worker.dispatch({
        op: "action",
        action: "scroll",
        value: "up",
        revision: 1,
        url: state.url,
      }),
      /changed/,
    );
    console.log(
      "PASS: fill/select/click/scroll verification and stale observation rejection (headless fixture)",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
