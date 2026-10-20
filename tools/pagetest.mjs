import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errs=[];
page.on("pageerror", e => errs.push("pageerror: "+e.message));
page.on("console", m => { if(m.type()==="error") errs.push("console.error: "+m.text()); });
await page.goto("http://localhost:8777/index.html", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise(r=>setTimeout(r,2500));
const info = await page.evaluate(() => ({
  status: document.getElementById("status")?.textContent,
  hasCM: !!document.querySelector("#editor .cm-editor") || !!document.querySelector(".editor-fallback"),
  cmClass: document.querySelector("#editor .cm-editor") ? "codemirror" : (document.querySelector(".editor-fallback") ? "textarea-fallback" : "none"),
  connectDisabled: document.getElementById("connect")?.disabled,
  flashDisabled: document.getElementById("flash")?.disabled,
  coi: window.crossOriginIsolated,
}));
console.log("status:", info.status);
console.log("editor:", info.cmClass, "| connect disabled:", info.connectDisabled, "| flash disabled:", info.flashDisabled, "| COI:", info.coi);
console.log("errors:", errs.length ? errs.join("\n  ") : "none");
await page.screenshot({ path: "/tmp/webby.png", fullPage: true });
await browser.close();
