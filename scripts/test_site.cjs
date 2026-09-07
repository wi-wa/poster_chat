const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const base = process.env.SITE_URL || "http://127.0.0.1:8770/";
const screenshots = process.env.SCREENSHOTS || "/tmp/poster-chat-screenshots";
fs.mkdirSync(screenshots, { recursive: true });

async function waitText(page, selector, text) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
}

async function openView(page, name) {
  if (!await page.locator("#home").isVisible()) await page.getByRole("link", { name: "Back to menu", exact: true }).click();
  await page.getByRole("link", { name, exact: true }).click();
}

async function waitPlot(page) {
  await page.waitForFunction(() => !document.querySelector("#plot-download").disabled && document.querySelector("#eval-plot").src.startsWith("blob:"));
  await page.locator("#eval-plot").evaluate((image) => image.decode());
  assert.equal(await page.evaluate(() => Object.keys(Chart.instances).length), 0);
}

async function plotPixels(page) {
  return page.locator("#eval-plot").evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = { green: 0, pink: 0, blue: 0, orange: 0, purple: 0, white: 0 };
    const colors = { "44,160,44": "green", "212,103,178": "pink", "38,115,184": "blue", "220,139,40": "orange", "112,69,156": "purple", "255,255,255": "white" };
    for (let i = 0; i < bytes.length; i += 4) {
      const color = colors[`${bytes[i]},${bytes[i + 1]},${bytes[i + 2]}`];
      if (color) counts[color] += 1;
    }
    return counts;
  });
}

async function checkMenu(page) {
  assert.equal(await page.locator("#home").isVisible(), true);
  assert.equal(await page.locator(".home-menu a").count(), 4);
  assert.equal(await page.getByRole("tab").count(), 0);
  assert.equal(await page.locator("#home-link").isVisible(), false);
  assert.equal(await page.locator("#view-navigation").isVisible(), false);
  assert.equal(await page.locator(".identity").count(), 0);
  assert.equal(await page.locator("[data-panel]:visible").count(), 1);
  assert.doesNotMatch(await page.locator(".site-header").textContent(), /MATS/i);
  const menu = await page.locator(".home-menu").boundingBox();
  const description = await page.locator(".project-description").boundingBox();
  assert.ok(description.y >= menu.y + menu.height);
  for (const button of await page.locator(".menu-button").all()) {
    assert.ok((await button.locator("p").textContent()).length > 15);
    assert.ok(await button.locator("h2").evaluate((heading) => parseFloat(getComputedStyle(heading).fontSize) >= 22));
    assert.equal(await button.evaluate((node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight), true);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    let apiMode = "ok";
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (request.method() === "GET") return route.fulfill({ json: { data: [{ id: "annulus-2.5b-reif" }] }, headers });
      const body = request.postDataJSON();
      requests.push(body);
      if (apiMode === "offline") return route.abort();
      if (apiMode === "busy") return route.fulfill({ status: 429, json: { error: { message: "Server is busy. Please try again." } }, headers });
      if (apiMode === "context") return route.fulfill({ status: 400, json: { error: { message: "Prompt plus completion exceeds the 2048-token context." } }, headers });
      return route.fulfill({ json: { choices: [{ message: { content: "Test answer: <b>literal text</b>", ...(body.thinking ? { reasoning_content: "Test reasoning." } : {}) }, finish_reason: "stop" }] }, headers });
    });

    await page.goto(base);
    await checkMenu(page);
    await page.screenshot({ path: path.join(screenshots, "menu-desktop.png") });
    await openView(page, "Contingent Knowledge Eval");
    await waitText(page, "#eval-count", "700 responses: 111 correct, 589 incorrect");
    assert.equal(await page.locator("#home").isVisible(), false);
    assert.equal(await page.locator("#eval-samples > details").count(), 20);
    await waitPlot(page);
    assert.equal(await page.locator("#comparison-models input").count(), 5);
    assert.equal(await page.locator("#comparison-models input:checked").count(), 2);
    assert.equal(await page.locator("#eval-plot").evaluate((image) => image.naturalWidth), 1800);
    const initialPixels = await plotPixels(page);
    assert.ok(initialPixels.green > 100 && initialPixels.pink > 100 && initialPixels.white > 100000);
    assert.equal(initialPixels.blue, 0);
    const downloadReady = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download comparison PNG", exact: true }).click();
    const download = await downloadReady;
    assert.match(download.suggestedFilename(), /sft_bigsmall_control-vs-dpo_annulus_reif\.png$/);
    const pngPath = path.join(screenshots, "comparison.png");
    await download.saveAs(pngPath);
    const png = fs.readFileSync(pngPath);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 1800);
    assert.equal(png.readUInt32BE(20), 1000);
    const expandedReady = page.context().waitForEvent("page");
    await page.getByRole("button", { name: "Open full-size evaluation plot", exact: true }).click();
    const expanded = await expandedReady;
    await expanded.waitForLoadState();
    assert.ok(expanded.url().startsWith("blob:"));
    await expanded.close();
    await page.screenshot({ path: path.join(screenshots, "eval-desktop.png") });
    await page.locator(".plot-values > summary").click();
    assert.equal(await page.locator("#eval-summary tbody tr").count(), 6);
    assert.match(await page.locator("#eval-summary").textContent(), /1.54% \(1\/65\)/);
    for (const checkbox of await page.locator("#comparison-models input").all()) await checkbox.check();
    await waitPlot(page);
    await waitText(page, "#eval-count", "1750 responses: 202 correct, 1548 incorrect");
    assert.equal(await page.locator("#eval-summary thead th").count(), 6);
    assert.equal(await page.locator("#eval-model option").count(), 6);
    const allPixels = await plotPixels(page);
    for (const color of ["green", "pink", "blue", "orange", "purple"]) assert.ok(allPixels[color] > 100, `Missing ${color} bars`);
    await page.screenshot({ path: path.join(screenshots, "eval-five-models.png") });
    await page.locator("#comparison-models").evaluate((group) => {
      for (const checkbox of group.querySelectorAll("input")) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    assert.equal(await page.locator("#plot-download").isDisabled(), true);
    assert.equal(await page.locator("#plot-open").isDisabled(), true);
    await waitText(page, "#plot-status", "No models selected.");
    await waitText(page, "#eval-count", "0 responses");
    await page.locator('input[value="sft_bigsmall_filtered"]').check();
    await waitPlot(page);
    await waitText(page, "#eval-count", "350 responses: 9 correct, 341 incorrect");
    const singlePixels = await plotPixels(page);
    assert.ok(singlePixels.blue > 100);
    for (const color of ["green", "pink", "orange", "purple"]) assert.equal(singlePixels[color], 0);
    await page.locator('input[value="sft_bigsmall_filtered"]').uncheck();
    await page.locator('input[value="sft_bigsmall_control"]').check();
    await page.locator('input[value="dpo_annulus_reif"]').check();
    await waitPlot(page);
    const unfilteredPNG = await page.locator("#eval-plot").getAttribute("src");
    await page.locator("#eval-verdict").selectOption("1");
    await waitText(page, "#eval-count", "111 responses: 111 correct, 0 incorrect");
    await page.locator("#eval-model").selectOption("dpo_annulus_reif");
    await page.locator("#eval-domain").selectOption("philosophy_of_mind");
    await waitText(page, "#eval-count", "0 responses");
    assert.equal(await page.locator("#eval-samples > details").count(), 0);
    await page.locator("#eval-domain").selectOption("experience");
    await waitText(page, "#eval-count", "1 response: 1 correct, 0 incorrect");
    await page.locator("#eval-samples > details > summary").click();
    await page.locator(".sample-body .judge-explanation").waitFor();
    assert.match(await page.locator("#eval-samples").textContent(), /Reference answer/);
    await page.locator("#eval-samples .reasoning > summary").click();
    assert.ok(await page.locator("#eval-samples .reasoning .text").isVisible());
    await page.locator("#eval-verdict").selectOption("0");
    await waitText(page, "#eval-count", "64 responses: 0 correct, 64 incorrect");
    await page.locator("#eval-pagination").getByRole("button", { name: "Next page" }).click();
    assert.equal(await page.locator("#eval-pagination output").textContent(), "2 / 4");
    await page.locator("#eval-search").fill("seeing stars");
    await waitText(page, "#eval-count", "5 responses");
    assert.equal(await page.locator("#eval-pagination output").textContent(), "1 / 1");
    assert.equal(await page.locator("#eval-plot").getAttribute("src"), unfilteredPNG);

    await openView(page, "Handlabeled Viewer");
    const hand = page.frameLocator("#hand-frame");
    await hand.locator("#labelsStatusText").filter({ hasText: "200 samples" }).waitFor();
    assert.equal(await hand.locator("#overallValue").textContent(), "99.5%");
    assert.equal(await hand.locator(".correlation-table tbody tr").count(), 4);
    await page.screenshot({ path: path.join(screenshots, "handlabeled-desktop.png") });
    const before = await hand.locator("#thresholdValue").textContent();
    await hand.locator("#thresholdPlus").click();
    assert.notEqual(await hand.locator("#thresholdValue").textContent(), before);
    await hand.locator("#accuracyAggregationSelect").selectOption("max");
    await hand.locator("#labelsZToggle").check();
    assert.equal(await hand.locator("#thresholdRange").getAttribute("min"), "-1");
    assert.equal(await hand.locator("#thresholdRange").getAttribute("step"), "0.05");
    await hand.locator("#labelsFilterSelect").selectOption("reified_experience");
    await hand.locator("#labelsSortSelect").selectOption("models");
    await hand.locator("#modelStatsList input[type=checkbox]").first().uncheck();
    assert.match(await hand.locator("#correlationCaption").textContent(), /3 checked/);
    const popupReady = page.waitForEvent("popup");
    await hand.locator("#distributionButton").click();
    const popup = await popupReady;
    await popup.locator(".dist-page").waitFor();
    assert.ok(await popup.locator(".dist-card").count() >= 4);
    await popup.close();

    await openView(page, "Data Viewer SFT");
    await waitText(page, "#sft-count", "100 of 100 conversations");
    await page.locator("#sft-samples > details > summary").first().click();
    await page.locator("#sft-samples .sft-turn").first().waitFor();
    assert.ok(await page.locator("#sft-samples .sft-turn").count() >= 2);
    await page.screenshot({ path: path.join(screenshots, "sft-desktop.png") });
    for (const [dataset, expected] of [["identity", "63 of 63 files"], ["prompts", "200 of 200 examples"], ["judge", "100 of 100 examples"]]) {
      await page.locator("#sft-dataset").selectOption(dataset);
      await waitText(page, "#sft-count", expected);
      await page.locator("#sft-samples > details > summary").first().click();
      await page.locator("#sft-samples .sample-body").waitFor();
    }
    await page.locator("#sft-search").fill("nonexistent-unique-sample-12345");
    await waitText(page, "#sft-count", "0 of 100 examples");
    assert.equal(await page.locator("#sft-samples > details").count(), 0);

    await openView(page, "Chat");
    await waitText(page, "#chat-connection", "Connected");
    assert.equal(await page.locator("#chat-thinking").isChecked(), false);
    await page.locator("#chat-input").fill("Hello!");
    await page.locator("#chat-input").press("Enter");
    await page.locator(".chat-message.assistant").waitFor();
    assert.equal(requests[0].thinking, false);
    assert.equal(requests[0].max_completion_tokens, 256);
    assert.equal(await page.locator(".chat-message b").count(), 0);
    await page.locator("#chat-thinking").check();
    await page.locator("#chat-input").fill("And with thinking?");
    await page.locator("#chat-input").press("Enter");
    await waitText(page, "#chat-messages", "Test reasoning.");
    assert.equal(requests[1].thinking, true);
    assert.equal(requests[1].messages.length, 3);
    await page.locator(".chat-message.assistant .reasoning > summary").click();
    assert.equal(await page.locator(".chat-message.assistant .reasoning .text").textContent(), "Test reasoning.");
    await page.screenshot({ path: path.join(screenshots, "chat-desktop.png") });
    for (const [mode, errorText] of [["busy", "Server is busy"], ["context", "2048-token context"], ["offline", "Could not reach the chat server"]]) {
      apiMode = mode;
      await page.locator("#chat-input").fill("A failed message");
      await page.locator("#chat-input").press("Enter");
      await waitText(page, "#chat-status", errorText);
      assert.equal(await page.locator("#chat-input").inputValue(), "A failed message");
      assert.equal(await page.locator(".chat-message").count(), 4);
      assert.equal(await page.locator("#chat-send").isEnabled(), true);
    }
    apiMode = "ok";
    await page.locator("#chat-clear").click();
    assert.equal(await page.locator(".chat-message").count(), 0);
    await page.locator("#chat-input").fill("A new conversation");
    await page.locator("#chat-input").press("Enter");
    await page.locator(".chat-message.assistant").waitFor();
    assert.equal(requests.at(-1).messages.length, 1);

    await page.getByRole("link", { name: "Back to menu", exact: true }).click();
    assert.equal(await page.locator("#menu-chat").evaluate((link) => link === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#menu-eval").evaluate((link) => link === document.activeElement), true);
    await page.keyboard.press("Enter");
    await page.waitForURL("**#eval");
    assert.equal(await page.locator("#eval-model").inputValue(), "dpo_annulus_reif");
    await page.goBack();
    await page.waitForFunction(() => document.body.dataset.view === "home");
    await checkMenu(page);
    await page.goForward();
    await page.waitForFunction(() => document.body.dataset.view === "eval");
    assert.equal(await page.locator("#eval-search").inputValue(), "seeing stars");
    await openView(page, "Chat");
    assert.equal(await page.locator(".chat-message").count(), 2);
    assert.equal(await page.locator("#chat-thinking").isChecked(), true);
    await page.goto(`${base}#eval`);
    await page.reload();
    await waitText(page, "#eval-count", "700 responses");
    assert.equal(await page.locator("#home").isVisible(), false);
    await page.goto(`${base}data.html`);
    await page.waitForURL("**#sft");

    for (const width of [390, 320, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("link", { name: "Back to menu", exact: true }).click();
      await checkMenu(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Menu: overflow at ${width}px`);
      await page.screenshot({ path: path.join(screenshots, `menu-${width}.png`), fullPage: true });
      for (const name of ["Chat", "Contingent Knowledge Eval", "Handlabeled Viewer", "Data Viewer SFT"]) {
        await openView(page, name);
        if (name === "Contingent Knowledge Eval") { await waitText(page, "#eval-count", "700 responses"); await waitPlot(page); }
        if (name === "Handlabeled Viewer") await hand.locator("#labelsStatusText").filter({ hasText: "200 samples" }).waitFor();
        if (name === "Data Viewer SFT") await waitText(page, "#sft-count", "100 of 100 conversations");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: overflow at ${width}px`);
        if (name === "Handlabeled Viewer") {
          assert.equal(await hand.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Hand-label iframe overflow at ${width}px`);
        }
        await page.screenshot({ path: path.join(screenshots, `${name.split(" ")[0].toLowerCase()}-${width}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    console.log("PASS: menu without redundant header, five-model PNG generation/download/pixels, empty and rapid selections, eval filters, hand-label controls, SFT datasets, chat history/thinking/errors, direct links, navigation, and desktop/mobile layouts.");
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
