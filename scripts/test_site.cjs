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

    await page.goto(`${base}#eval`);
    await waitText(page, "#eval-count", "700 responses: 111 correct, 589 incorrect");
    assert.equal(await page.getByRole("tab").count(), 4);
    assert.equal(await page.locator("#eval-samples > details").count(), 20);
    await page.locator("#eval-plot").evaluate((image) => image.decode());
    assert.equal(await page.locator("#eval-plot").evaluate((image) => image.naturalWidth), 1784);
    await page.screenshot({ path: path.join(screenshots, "eval-desktop.png") });
    await page.locator(".plot-values > summary").click();
    assert.equal(await page.locator("#eval-summary tbody tr").count(), 6);
    assert.match(await page.locator("#eval-summary").textContent(), /1.54% \(1\/65\)/);
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

    await page.getByRole("tab", { name: "Handlabeled Viewer", exact: true }).click();
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

    await page.getByRole("tab", { name: "Data Viewer SFT", exact: true }).click();
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

    await page.getByRole("tab", { name: "Chat", exact: true }).click();
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

    await page.getByRole("tab", { name: "Chat", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForURL("**#eval");
    assert.equal(await page.locator("#eval-model").inputValue(), "dpo_annulus_reif");
    await page.keyboard.press("End");
    await page.waitForURL("**#sft");
    await page.goto(`${base}data.html`);
    await page.waitForURL("**#sft");

    for (const width of [390, 320, 768]) {
      await page.setViewportSize({ width, height: 844 });
      for (const name of ["Chat", "Contingent Knowledge Eval", "Handlabeled Viewer", "Data Viewer SFT"]) {
        await page.getByRole("tab", { name, exact: true }).click();
        if (name === "Contingent Knowledge Eval") await waitText(page, "#eval-count", "700 responses");
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
    console.log("PASS: four tabs, exact plot, eval filters, hand-label controls, SFT datasets, chat history/thinking/errors, legacy URL, keyboard navigation, and desktop/mobile layouts.");
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
