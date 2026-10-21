import puppeteer from "puppeteer";
const url = process.argv[2];
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("console", m => console.log("[console]", m.text()));
page.on("pageerror", e => console.log("[pageerror]", e.message));
page.on("requestfailed", r => console.log("[reqfail]", r.url(), r.failure()?.errorText));
await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
// wait for "ALL GOOD" or "FAILED" in #out
await page.waitForFunction(() => /ALL GOOD|FAILED/.test(document.getElementById("out")?.textContent||""), { timeout: 90000 }).catch(()=>{});
const txt = await page.evaluate(() => document.getElementById("out").textContent);
console.log("=== page #out ===\n" + txt);
console.log("crossOriginIsolated:", await page.evaluate(()=>window.crossOriginIsolated));
await browser.close();
