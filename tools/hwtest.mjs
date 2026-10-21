// End-to-end on hardware through the real UI, in headless Chrome-for-Testing:
// USB connect -> flash Jaguar* with Wi-Fi -> wait for the network over serial
// -> connect over Wi-Fi -> run -> install the web server example and fetch it.
// Needs a Chrome-for-Testing policy allowing serial for the app's origin
// (/etc/opt/chrome_for_testing/policies/managed/*.json:
// {"DefaultSerialGuardSetting":3,"SerialAllowAllPortsForUrls":[<origin>]}),
// as headless Chrome can't show the port chooser. APP defaults to a local
// `python3 web/serve.py 8777`; APP=https://girtsf.github.io/toit-webby/ tests
// the hosted site (headless also can't show the Local Network Access prompt,
// so it is granted up front).
// Usage: [APP=...] WIFI_SSID=... WIFI_PASS=... node hwtest.mjs [device-name] [--no-flash]
import puppeteer from "puppeteer";

const APP = process.env.APP || "http://localhost:8777/";
const NAME = process.argv[2] || "webby-s3";
const FLASH = !process.argv.includes("--no-flash");

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
try {
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setPermission", {
    permission: { name: "local-network" }, setting: "granted", origin: new URL(APP).origin,
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  // No port chooser in headless: hand out the CP210x port.
  await page.evaluateOnNewDocument(() => {
    if (!navigator.serial) return;
    navigator.serial.requestPort = async () =>
      (await navigator.serial.getPorts()).find((p) => p.getInfo().usbVendorId === 0x10c4);
  });
  await page.goto(APP, { waitUntil: "networkidle2" });

  // Mirror the app console as it grows.
  let seen = 0;
  const pump = setInterval(async () => {
    const lines = await page.$$eval("#console > div", (els) => els.map((e) => e.textContent)).catch(() => []);
    for (const l of lines.slice(seen)) console.log(stamp(), l.slice(0, 160));
    seen = lines.length;
  }, 300);
  const text = () => page.$eval("#console", (el) => el.innerText);
  async function waitFor(re, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(await text())) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("timeout waiting for " + re);
  }
  const clearConsole = async () => { await page.$eval("#console", (el) => el.replaceChildren()); seen = 0; };

  if (FLASH) {
    await page.click("#connect");
    await waitFor(/Detected /, 60000);
    await page.$eval("#devname", (el, v) => { el.value = v; }, NAME);
    await page.$eval("#ssid", (el, v) => { el.value = v; }, process.env.WIFI_SSID);
    await page.$eval("#pass", (el, v) => { el.value = v; }, process.env.WIFI_PASS);
    await page.click("#flash");
    await waitFor(/Device is on Wi-Fi|didn't report a network|Flash failed/, 6 * 60000);
    if (!/Device is on Wi-Fi/.test(await text())) throw new Error("device not on Wi-Fi");
    await page.click("#netbanner button");
  } else {
    await page.$eval("#wifi-host", (el, v) => { el.value = v; }, NAME + ".local");
    await page.click("#wifi-connect");
  }
  await waitFor(/Connected over Wi-Fi/, 30000);
  await new Promise((r) => setTimeout(r, 1500));
  await clearConsole();

  let t = Date.now();
  await page.click("#run");
  await waitFor(/(^|\n)done(\n|$)/, 60000);
  console.log(stamp(), "== run over Wi-Fi: done after", Date.now() - t, "ms");

  await page.select("#examples", "2");  // web server
  await page.type("#cname", "web");
  await page.click("#install");
  await waitFor(/serving on (http:\S+)/, 60000);
  const url = (await text()).match(/serving on (http:\S+)/)[1];
  const mdnsUrl = url.replace(/\/\/[\d.]+/, "//" + NAME + ".local");
  for (const u of [url, mdnsUrl]) {
    const body = await (await fetch(u)).text();
    console.log(stamp(), "== GET", u, "->", body);
  }
  await new Promise((r) => setTimeout(r, 1000));
  console.log(stamp(), "== containers:", await page.$eval("#containers", (el) => el.innerText.replace(/\s+/g, " ")));
  clearInterval(pump);
  await page.screenshot({ path: process.env.SHOT || "/tmp/webby-hw.png", fullPage: true });
} finally {
  await browser.close();
}
