"use strict";

const $ = (id) => document.getElementById(id);
const modelNames = { sft_bigsmall_control: "SFT bigsmall control", dpo_annulus_reif: "DPO Annulus reif" };
const domainNames = {
  philosophy_of_mind: "Philosophy of Mind",
  reification: "Reification",
  experience: "Experience",
  famous_scientists_and_philosophers: "Famous Scientists and Philosophers",
  non_consc_idioms: "Non-Consciousness Idioms",
};

function element(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icons() { window.lucide?.createIcons(); }

function iconButton(icon, label, action) {
  const button = element("button", "icon-button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  const glyph = element("i");
  glyph.dataset.lucide = icon;
  button.append(glyph);
  button.addEventListener("click", action);
  return button;
}

async function getJSON(url, options = {}) {
  const response = await fetch(url, { credentials: "omit", ...options });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(response.ok ? "Unexpected server response." : `Server unavailable (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (HTTP ${response.status}).`);
  return body;
}

function pagination(id, total, page, pageSize, change) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const previous = iconButton("chevron-left", "Previous page", () => change(page - 1));
  const next = iconButton("chevron-right", "Next page", () => change(page + 1));
  previous.disabled = page === 0;
  next.disabled = page >= pages - 1;
  $(id).replaceChildren(previous, element("output", "", `${page + 1} / ${pages}`), next);
}

function disclosure(title, text, className = "reasoning") {
  const node = element("details", className);
  node.append(element("summary", "", title), element("div", "text", text));
  return node;
}

function sampleShell(title, meta, badge) {
  const details = element("details", "sample");
  const summary = element("summary");
  const heading = element("div");
  heading.append(element("div", "sample-title", title), element("div", "sample-meta", meta));
  summary.append(heading);
  if (badge) summary.append(badge);
  details.append(summary);
  return details;
}

function lazyBody(details, render) {
  details.addEventListener("toggle", () => {
    if (details.open && !details.querySelector(".sample-body")) {
      const body = element("div", "sample-body");
      render(body);
      details.append(body);
      icons();
    }
  });
  return details;
}

function loadError(target, error, retry) {
  const message = element("div", "empty-result error", error.message);
  const button = iconButton("rotate-cw", "Retry loading data", retry);
  $(target).replaceChildren(message, button);
  icons();
}

const tabs = [...document.querySelectorAll('[role="tab"]')];
function showTab() {
  const name = location.hash.slice(1);
  const selected = tabs.find((tab) => tab.dataset.tab === name) || tabs[0];
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.dataset.tab).hidden = !active;
  }
  if (selected.dataset.tab === "eval") loadEval();
  if (selected.dataset.tab === "sft") loadSft();
  if (selected.dataset.tab === "handlabeled" && !$('hand-frame').getAttribute("src")) {
    $("hand-frame").src = $("hand-frame").dataset.src;
  }
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => {
    if (location.hash !== `#${tab.dataset.tab}`) window.history.pushState(null, "", `#${tab.dataset.tab}`);
    showTab();
    window.scrollTo(0, 0);
  });
  tab.addEventListener("keydown", (event) => {
    const offsets = { ArrowLeft: -1, ArrowRight: 1, Home: -index, End: tabs.length - 1 - index };
    if (!(event.key in offsets)) return;
    event.preventDefault();
    const next = tabs[(index + offsets[event.key] + tabs.length) % tabs.length];
    next.focus();
    next.click();
  });
}
window.addEventListener("hashchange", showTab);
window.addEventListener("popstate", showTab);

let evalData;
let evalLoading = false;
let evalPage = 0;
async function loadEval() {
  if (evalData || evalLoading) return;
  evalLoading = true;
  try {
    evalData = await getJSON("data/eval.json");
    for (const model of evalData.metadata.models) {
      $("eval-model").add(new Option(modelNames[model.model_name], model.model_name));
    }
    for (const [id, label] of Object.entries(domainNames)) $("eval-domain").add(new Option(label, id));
    renderEvalSummary();
    renderEval();
  } catch (error) {
    $("eval-count").textContent = "Could not load samples";
    loadError("eval-samples", error, loadEval);
  } finally { evalLoading = false; }
}

function renderEvalSummary() {
  const table = element("table");
  const head = element("tr");
  for (const title of ["Domain", ...evalData.metadata.models.map((model) => modelNames[model.model_name])]) {
    const cell = element("th", "", title);
    cell.scope = "col";
    head.append(cell);
  }
  const thead = element("thead");
  thead.append(head);
  const tbody = element("tbody");
  for (const [domain, label] of [...Object.entries(domainNames), ["all", "Overall"]]) {
    const row = element("tr");
    const heading = element("th", "", label);
    heading.scope = "row";
    row.append(heading);
    for (const model of evalData.metadata.models) {
      const value = domain === "all" ? model : model.categories[domain];
      row.append(element("td", "", `${(100 * value.score).toFixed(2)}% (${value.correct_responses}/${value.responses_judged})`));
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  const provenance = element("p", "provenance", "Reaggregated September 7, 2026 from saved judgments with the updated 70-question bank. Seven items excluded; seeing_stars assigned to Experience. No regeneration or rejudging. Labels assess the saved answer and reasoning.");
  $("eval-summary").replaceChildren(table, provenance);
}

function renderEval() {
  if (!evalData) return;
  const model = $("eval-model").value;
  const domain = $("eval-domain").value;
  const verdict = $("eval-verdict").value;
  const search = $("eval-search").value.trim().toLowerCase();
  const rows = evalData.samples.filter((row) =>
    (model === "all" || row.model === model) && (domain === "all" || row.domain === domain) &&
    (verdict === "all" || row.score === Number(verdict)) &&
    (!search || [row.term, row.question, row.model_response, row.reference_answer, row.reasoning, row.judge_explanation].join("\n").toLowerCase().includes(search)));
  evalPage = Math.min(evalPage, Math.max(0, Math.ceil(rows.length / 20) - 1));
  const correct = rows.reduce((sum, row) => sum + row.score, 0);
  $("eval-count").textContent = `${rows.length} ${rows.length === 1 ? "response" : "responses"}: ${correct} correct, ${rows.length - correct} incorrect`;
  pagination("eval-pagination", rows.length, evalPage, 20, (page) => {
    evalPage = page;
    renderEval();
    $("eval-count").scrollIntoView({ block: "center" });
  });
  const nodes = rows.slice(evalPage * 20, (evalPage + 1) * 20).map((row) => {
    const badge = element("span", `badge ${row.score ? "correct" : "incorrect"}`, row.score ? "Correct" : "Incorrect");
    const details = sampleShell(row.question, `${modelNames[row.model]} | ${domainNames[row.domain]} | Sample ${row.sample_index + 1}`, badge);
    const mark = element("span", `model-mark ${row.model === "dpo_annulus_reif" ? "dpo" : ""}`);
    mark.setAttribute("aria-hidden", "true");
    details.querySelector(".sample-meta").prepend(mark);
    return lazyBody(details, (body) => {
      body.append(element("h4", "", "Model answer"), element("div", "text", row.model_response || "No visible answer."));
      if (row.reasoning) body.append(disclosure("Thinking", row.reasoning));
      body.append(element("h4", "", "Reference answer"), element("div", "text", row.reference_answer));
      const judge = element("div", "judge-explanation");
      judge.append(element("h4", "", `Judge: ${row.judge_model}`), element("div", "text", row.judge_explanation));
      body.append(judge, element("p", "provenance", `${row.id} | ${row.generated_tokens} generated tokens${row.turn_closed ? "" : " | Turn did not close"}${row.think_closed ? "" : " | Thinking did not close"}`));
    });
  });
  $("eval-samples").replaceChildren(...(nodes.length ? nodes : [element("p", "empty-result", "No responses match these filters.")]));
  icons();
}
for (const id of ["eval-model", "eval-domain", "eval-verdict", "eval-search"]) {
  $(id).addEventListener(id === "eval-search" ? "input" : "change", () => { evalPage = 0; renderEval(); });
}

const sftCache = new Map();
let sftVersion = 0;
let sftPage = 0;
async function loadSft() {
  const dataset = $("sft-dataset").value;
  const version = ++sftVersion;
  $("sft-count").textContent = "Loading data...";
  $("sft-samples").replaceChildren();
  $("sft-pagination").replaceChildren();
  try {
    if (!sftCache.has(dataset)) {
      let data;
      if (dataset === "conversations" || dataset === "identity") {
        data = await getJSON(`data/sft-${dataset}.json`);
      } else {
        const url = dataset === "prompts" ? "data/prompts.jsonl" : "data/judge_examples.jsonl";
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not load dataset (HTTP ${response.status}).`);
        data = { items: (await response.text()).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)),
          provenance: dataset === "prompts" ? "200 seed prompts from the previously published SFT snapshot." : "100 previously published judge-rated corpus examples; these are not SFT conversations." };
      }
      sftCache.set(dataset, data);
    }
    if (version === sftVersion) renderSft();
  } catch (error) {
    if (version !== sftVersion) return;
    $("sft-count").textContent = "Could not load data";
    loadError("sft-samples", error, loadSft);
  }
}

function renderSft() {
  const dataset = $("sft-dataset").value;
  const data = sftCache.get(dataset);
  if (!data) return;
  const search = $("sft-search").value.trim().toLowerCase();
  const rows = data.items.filter((row) => !search || JSON.stringify(row).toLowerCase().includes(search));
  sftPage = Math.min(sftPage, Math.max(0, Math.ceil(rows.length / 10) - 1));
  $("sft-provenance").textContent = data.provenance;
  $("sft-count").textContent = `${rows.length} of ${data.items.length} ${dataset === "conversations" ? "conversations" : dataset === "identity" ? "files" : "examples"}`;
  pagination("sft-pagination", rows.length, sftPage, 10, (page) => {
    sftPage = page;
    renderSft();
    $("sft-count").scrollIntoView({ block: "center" });
  });
  const nodes = rows.slice(sftPage * 10, (sftPage + 1) * 10).map((row) => {
    const title = row.prompt || row.title || row.text?.slice(0, 180) || "Example";
    const meta = dataset === "conversations" ? `${row.source} | ${row.messages.length} messages | ${row.file}:${row.line}` : row.file || row.source || "Judge-rated document";
    return lazyBody(sampleShell(title, meta), (body) => {
      if (dataset === "conversations") {
        for (const message of row.messages) {
          const turn = element("div", `sft-turn ${message.role}`);
          turn.append(element("h4", "", message.role));
          if (message.reasoning) turn.append(disclosure("Thinking", message.reasoning));
          turn.append(element("div", "text", message.content));
          body.append(turn);
        }
      } else {
        body.append(element("div", "text", row.text || row.prompt));
        if (row.ratings) {
          for (const [filter, ratings] of Object.entries(row.ratings)) {
            for (const rating of ratings) {
              const entry = element("div", "judge-explanation");
              entry.append(element("h4", "", `${filter.replaceAll("_", " ")} | ${rating.model} | ${rating.rating}/10`), element("div", "text", rating.explanation));
              if (rating.quote) entry.append(element("blockquote", "text", rating.quote));
              body.append(entry);
            }
          }
        }
      }
    });
  });
  $("sft-samples").replaceChildren(...(nodes.length ? nodes : [element("p", "empty-result", "No examples match this search.")]));
  icons();
}
$("sft-dataset").addEventListener("change", () => { sftPage = 0; $("sft-search").value = ""; loadSft(); });
$("sft-search").addEventListener("input", () => { sftPage = 0; renderSft(); });

let chatConfig;
let chatBusy = false;
let chatHistory = [];
const emptyChat = $("chat-empty");
const configReady = getJSON("site.json", { cache: "no-store" }).then((config) => {
  const url = new URL(config.chat_base_url);
  if (url.protocol !== "https:") throw new Error("Chat requires an HTTPS endpoint.");
  config.chat_base_url = url.href.replace(/\/$/, "");
  chatConfig = config;
  $("api-link").href = `${config.chat_base_url.replace(/\/v1$/, "")}/api`;
  return config;
});

function connection(online) {
  $("chat-connection").textContent = online ? "Connected" : "Chat is temporarily offline";
  $("chat-connection").classList.toggle("online", online);
}
configReady.then((config) => getJSON(`${config.chat_base_url}/models`, { signal: AbortSignal.timeout(8000) }))
  .then(() => connection(true)).catch(() => connection(false));

function chatMessage(role, content, reasoning) {
  const node = element("article", `chat-message ${role}`);
  node.append(element("div", "message-role", role === "user" ? "You" : "Annulus"));
  if (reasoning) node.append(disclosure("Thinking", reasoning));
  node.append(element("div", "text", content));
  $("chat-messages").append(node);
  $("chat-messages").scrollTop = $("chat-messages").scrollHeight;
  return node;
}

$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = $("chat-input").value.trim();
  if (chatBusy || !content || !$("chat-max-tokens").reportValidity()) return;
  chatBusy = true;
  $("chat-send").disabled = true;
  $("chat-clear").disabled = true;
  $("chat-input").readOnly = true;
  emptyChat.remove();
  const userNode = chatMessage("user", content);
  $("chat-input").value = "";
  $("chat-status").classList.remove("error");
  $("chat-status").textContent = "Generating...";
  try {
    const config = chatConfig || await configReady;
    const messages = [...chatHistory, { role: "user", content }];
    const response = await getJSON(`${config.chat_base_url}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({ model: config.model, messages, thinking: $("chat-thinking").checked,
        max_completion_tokens: Number($("chat-max-tokens").value) }),
    });
    const choice = response.choices?.[0];
    const answer = choice?.message?.content;
    const reasoning = choice?.message?.reasoning_content;
    if (typeof answer !== "string") throw new Error("The server returned no answer.");
    chatMessage("assistant", answer || "No final answer was generated within the token limit.", reasoning);
    chatHistory = answer ? [...messages, { role: "assistant", content: answer }] : messages;
    $("chat-status").textContent = choice.finish_reason === "length" ? "Token limit reached." : "";
    connection(true);
  } catch (error) {
    userNode.remove();
    $("chat-input").value = content;
    if (!chatHistory.length) $("chat-messages").replaceChildren(emptyChat);
    $("chat-status").textContent = error.name === "TimeoutError" ? "Request timed out. The server may still be generating." : error instanceof TypeError ? "Could not reach the chat server. Please try again later." : error.message;
    $("chat-status").classList.add("error");
    if (error instanceof TypeError || error.name === "TimeoutError") connection(false);
  } finally {
    chatBusy = false;
    $("chat-send").disabled = false;
    $("chat-clear").disabled = false;
    $("chat-input").readOnly = false;
    if (!$("chat").hidden) $("chat-input").focus();
  }
});
$("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("chat-clear").addEventListener("click", () => {
  chatHistory = [];
  $("chat-messages").replaceChildren(emptyChat);
  $("chat-input").value = "";
  $("chat-status").textContent = "";
  $("chat-input").focus();
});

showTab();
icons();
