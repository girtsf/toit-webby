// Drives the app's Wi-Fi path in headless Chrome against a Jaguar* device:
// connect via #device=, run the default example, install + list + uninstall,
// then crash a program and check the decoded stack trace.
// Usage: node wifitest.mjs [app-url] [device-host]
// For a host-run Jaguar* (no hardware), see device/host_run.toit.
import puppeteer from "puppeteer";

const APP = process.argv[2] || "http://localhost:8777/";
const DEVICE = process.argv[3] || "webby-host.local:9123";

// CHROME_ARGS e.g. "--ip-address-space-overrides=127.0.0.1:8443=public" makes a
// local HTTPS server look like a public site (as on GitHub Pages) for Local
// Network Access.
const extraArgs = (process.env.CHROME_ARGS || "").split(" ").filter(Boolean);
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--ignore-certificate-errors", ...extraArgs] });
try {
  // Headless can't show the permission prompt; grant it up front unless told not to.
  if (!process.env.NO_GRANT) {
    // Chrome 155 checks "local-network"; older builds used "local-network-access".
    const cdp = await browser.target().createCDPSession();
    for (const name of ["local-network", "local-network-access"]) {
      await cdp.send("Browser.setPermission", {
        permission: { name }, setting: "granted", origin: new URL(APP).origin,
      }).catch((e) => console.log("permission grant:", e.message));
    }
  }
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text()); });

  const consoleText = () => page.$eval("#console", (el) => el.innerText);
  async function waitConsole(re, ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = await consoleText();
      if (re.test(t)) return t;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("timeout waiting for " + re + "\n--- console ---\n" + await consoleText());
  }

  await page.goto(APP + "#device=" + encodeURIComponent(DEVICE), { waitUntil: "networkidle2" });
  await waitConsole(/Connected over Wi-Fi/);
  console.log("connected; target =", await page.$eval("#target", (s) => s.value));
  // Drop the replayed history so the waits below only see new output.
  await new Promise((r) => setTimeout(r, 1500));
  await page.$eval("#console", (el) => el.replaceChildren());

  let t0 = Date.now();
  await page.click("#run");
  await waitConsole(/(^|\n)done(\n|$)/);
  console.log("run: output received after", Date.now() - t0, "ms");

  await page.$eval("#console", (el) => el.replaceChildren());
  await page.type("#cname", "hello");
  t0 = Date.now();
  await page.click("#install");
  await waitConsole(/(^|\n)done(\n|$)/);
  console.log("install: output received after", Date.now() - t0, "ms");
  await page.click("#containers-refresh");
  await new Promise((r) => setTimeout(r, 1000));
  console.log("containers:", await page.$eval("#containers", (el) => el.innerText.replace(/\s+/g, " ")));
  const [uninstall] = await page.$$("xpath/.//div[@class='container'][.//b[text()='hello']]//button[text()='uninstall']");
  await uninstall.click();
  await new Promise((r) => setTimeout(r, 1500));
  console.log("after uninstall:", await page.$eval("#containers", (el) => el.innerText.replace(/\s+/g, " ")));
  // Crash example: logd captures the trace, the page decodes it in wasm.
  await page.$eval("#console", (el) => el.replaceChildren());
  await page.select("#examples", "4");
  await page.click("#run");
  await waitConsole(/main\.toit:\d+:\d+/);
  console.log("trace:", (await consoleText()).split("\n").filter((l) => /EXCEPTION|main\.toit/.test(l)).join(" | "));
  await page.screenshot({ path: process.env.SHOT || "/tmp/webby-wifi.png", fullPage: true });
} finally {
  await browser.close();
}
