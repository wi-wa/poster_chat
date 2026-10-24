"use strict";

const $ = (id) => document.getElementById(id);
const modelNames = {
  exp_sft: "Exp SFT", exp_dpo1: "Exp DPO", exp_sft_v2: "Exp SFT v2", exp_rl_v2: "Exp RL v2",
  reif_sft: "Reif SFT", reif_dpo1: "Reif DPO", reif_sft_v2: "Reif SFT v2", reif_rl_v2: "Reif RL v2",
  control_sft: "Control SFT", control_dpo1: "Control DPO", control_sft_v2: "Control SFT v2", control_rl_v2: "Control RL v2",
};
const modelColors = {
  exp_sft: "#f0b46e", exp_dpo1: "#dc8b28", exp_sft_v2: "#a8641a", exp_rl_v2: "#6e3f0e",
  reif_sft: "#d78cc0", reif_dpo1: "#b34790", reif_sft_v2: "#8a2f6e", reif_rl_v2: "#5c1c49",
  control_sft: "#7fb0dd", control_dpo1: "#2673b8", control_sft_v2: "#1a5288", control_rl_v2: "#0e3358",
};
const domainNames = {
  philosophy_of_mind: "Philosophy of Mind",
  reification: "Reification",
  experience: "Experience",
  famous_scientists_and_philosophers: "Famous Scientists and Philosophers",
  non_consc_idioms: "Non-Consciousness Idioms",
  gsm8k: "GSM8K",
};
const evalSets = {
  contingent_knowledge: { name: "Contingent Knowledge Eval", file: "eval", slug: "contingent-knowledge" },
  gsm8k: { name: "GSM8K Eval", file: "gsm8k", slug: "gsm8k" },
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

const menuLinks = [...document.querySelectorAll(".menu-button")];
function showView(moveFocus = false) {
  const selected = menuLinks.find((link) => `#${link.dataset.view}` === location.hash)?.dataset.view || "home";
  const previous = document.body.dataset.view;
  if (selected === previous) return;
  for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.id !== selected;
  document.body.dataset.view = selected;
  $("view-navigation").hidden = selected === "home";
  $("home-link").hidden = selected === "home";
  if (selected === "eval") loadEval();
  if (selected === "benchmarks") window.loadBenchmarks?.();
  if (selected === "sft") loadSft();
  if (selected === "handlabeled" && !$("hand-frame").getAttribute("src")) {
    $("hand-frame").src = $("hand-frame").dataset.src;
  }
  if (moveFocus) {
    const target = selected === "home" ? menuLinks.find((link) => link.dataset.view === previous) || menuLinks[0] : $(selected);
    target.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}
for (const link of document.querySelectorAll("a[data-view]")) {
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (location.hash !== link.hash) window.history.pushState(null, "", link.hash);
    showView(true);
  });
}
window.addEventListener("hashchange", () => showView(true));
window.addEventListener("popstate", () => showView(true));

let evalData;
const evalCache = new Map();
let evalLoadVersion = 0;
let evalPage = 0;
let selectedModels;
async function loadEval() {
  const dataset = $("eval-dataset").value;
  if (evalData?.metadata.evaluation_name === dataset) return;
  const version = ++evalLoadVersion;
  evalData = undefined;
  $("eval-heading").textContent = evalSets[dataset].name;
  $("eval-description").textContent = "Loading evaluation...";
  $("eval-count").textContent = "Loading samples...";
  for (const id of ["comparison-models", "eval-summary", "eval-samples", "eval-pagination"]) $(id).replaceChildren();
  renderPlot([]);
  $("plot-status").textContent = "Loading comparison...";
  try {
    if (!evalCache.has(dataset)) evalCache.set(dataset, await getJSON(`data/${evalSets[dataset].file}.json?v=20261023-v2`));
    if (version !== evalLoadVersion) return;
    evalData = evalCache.get(dataset);
    selectedModels = new Set(selectedModels === undefined ? evalData.metadata.default_models :
      [...selectedModels].filter((name) => evalData.metadata.models.some((model) => model.model_name === name)));
    $("eval-description").textContent = `${evalData.metadata.items} questions per model, ${evalData.metadata.responses_per_question} sampled responses per question.`;
    $("eval-data-download").href = `data/${evalSets[dataset].file}.json?v=20261023-v2`;
    for (const model of evalData.metadata.models) {
      const name = model.model_name;
      modelNames[name] ||= name.replaceAll("_", " ");
      modelColors[name] ||= "#556163";
      const label = element("label");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.value = name;
      checkbox.checked = selectedModels.has(name);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedModels.add(name);
        else selectedModels.delete(name);
        updateComparison();
      });
      const swatch = element("span", "model-swatch");
      swatch.style.backgroundColor = modelColors[name];
      swatch.setAttribute("aria-hidden", "true");
      label.append(checkbox, swatch, element("span", "", modelNames[name]));
      $("comparison-models").append(label);
    }
    $("eval-domain").replaceChildren(new Option("All domains", "all"));
    for (const id of evalData.metadata.domains) $("eval-domain").add(new Option(domainNames[id] || id, id));
    $("eval-model").value = "all";
    $("eval-verdict").value = "all";
    $("eval-search").value = "";
    updateComparison();
  } catch (error) {
    if (version !== evalLoadVersion) return;
    evalData = undefined;
    $("eval-count").textContent = "Could not load samples";
    $("plot-status").textContent = "Could not load comparison.";
    loadError("eval-samples", error, loadEval);
  }
}
$("eval-dataset").addEventListener("change", loadEval);

function updateComparison() {
  const models = evalData.metadata.models.filter((model) => selectedModels.has(model.model_name));
  const previous = $("eval-model").value;
  $("eval-model").replaceChildren(new Option("Selected models", "all"));
  for (const model of models) $("eval-model").add(new Option(modelNames[model.model_name], model.model_name));
  if (selectedModels.has(previous)) $("eval-model").value = previous;
  evalPage = 0;
  renderEvalSummary(models);
  renderEval();
  renderPlot(models);
}

let plotVersion = 0;
let plotURL;
let plotFilename;
async function renderPlot(models) {
  const version = ++plotVersion;
  $("plot-download").disabled = true;
  $("plot-open").disabled = true;
  $("plot-status").hidden = false;
  $("plot-status").textContent = models.length ? "Generating comparison..." : "No models selected.";
  if (!models.length) {
    $("eval-plot").hidden = true;
    if (plotURL) URL.revokeObjectURL(plotURL);
    plotURL = undefined;
    return;
  }
  // Let a burst of selection changes settle, so only the latest one draws a chart.
  await new Promise((resolve) => setTimeout(resolve));
  if (version !== plotVersion) return;
  const dataset = evalSets[evalData.metadata.evaluation_name];
  const domains = evalData.metadata.domains;
  const plotTitle = evalData.metadata.evaluation_name === "gsm8k" ? "GSM8K Accuracy by Model" : "Contingent Knowledge Accuracy by Domain and Model";
  let chart;
  let url;
  try {
    const canvas = element("canvas");
    canvas.width = 1800;
    canvas.height = 1000;
    const datasets = models.map((model) => ({
      label: modelNames[model.model_name], backgroundColor: modelColors[model.model_name],
      data: domains.map((domain) => model.categories[domain].score),
      categoryPercentage: 0.8, barPercentage: 0.9,
    }));
    chart = new Chart(canvas, {
      type: "bar",
      data: { labels: domains.map((domain) => ({
        famous_scientists_and_philosophers: ["Famous Scientists", "and Philosophers"],
        non_consc_idioms: ["Non-Consciousness", "Idioms"],
      })[domain] || domainNames[domain] || domain), datasets },
      options: {
        responsive: false, animation: false, devicePixelRatio: 1, events: [],
        layout: { padding: { top: 20, right: 24, bottom: 16, left: 16 } },
        plugins: {
          title: { display: true, text: plotTitle, color: "#22292a", font: { size: 26, weight: "normal" }, padding: { bottom: 26 } },
          legend: { position: "bottom", labels: { color: "#22292a", font: { size: 20 }, boxWidth: 24, padding: 24 } },
          tooltip: { enabled: false },
        },
        scales: {
          y: { min: 0, max: 1, title: { display: true, text: "Fraction of sampled responses correct", color: "#22292a", font: { size: 22 } }, ticks: { stepSize: 0.2, color: "#22292a", font: { size: 20 }, callback: (value) => value.toFixed(1) }, grid: { color: "#e3e8e8" } },
          x: { grid: { display: false }, ticks: { autoSkip: false, minRotation: 0, maxRotation: 0, color: "#22292a", font: { size: 22 } } },
        },
      },
      plugins: [{
        id: "comparisonPNG",
        beforeDraw(chart) {
          chart.ctx.save();
          chart.ctx.fillStyle = "#ffffff";
          chart.ctx.fillRect(0, 0, chart.width, chart.height);
          chart.ctx.restore();
        },
        afterDatasetsDraw(chart) {
          const ctx = chart.ctx;
          // More than six bars per group leaves too little width for horizontal value labels, so they turn upright.
          const crowded = chart.data.datasets.length > 6;
          ctx.save();
          ctx.font = crowded ? "15px sans-serif" : "18px sans-serif";
          ctx.fillStyle = "#22292a";
          ctx.textAlign = crowded ? "left" : "center";
          ctx.textBaseline = crowded ? "middle" : "bottom";
          chart.data.datasets.forEach((dataset, index) => {
            chart.getDatasetMeta(index).data.forEach((bar, domain) => {
              const label = dataset.data[domain].toFixed(2);
              if (!crowded) { ctx.fillText(label, bar.x, bar.y - 7); return; }
              ctx.save();
              ctx.translate(bar.x, bar.y - 6);
              ctx.rotate(-Math.PI / 2);
              ctx.fillText(label, 0, 0);
              ctx.restore();
            });
          });
          ctx.restore();
        },
      }],
    });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG generation failed.");
    url = URL.createObjectURL(blob);
    const preview = new Image();
    preview.src = url;
    await preview.decode();
    if (version !== plotVersion) { URL.revokeObjectURL(url); return; }
    if (plotURL) URL.revokeObjectURL(plotURL);
    plotURL = url;
    plotFilename = `${dataset.slug}-${models.map((model) => model.model_name).join("-vs-")}.png`;
    $("eval-plot").src = url;
    $("eval-plot").alt = `${plotTitle}: ${models.map((model) => modelNames[model.model_name]).join(" versus ")}. Exact values follow below.`;
    $("eval-plot").hidden = false;
    $("plot-status").hidden = true;
    $("plot-download").disabled = false;
    $("plot-open").disabled = false;
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    if (version === plotVersion) $("plot-status").textContent = `Could not generate comparison: ${error.message}`;
  } finally { chart?.destroy(); }
}
$("plot-download").addEventListener("click", () => {
  if (!plotURL) return;
  const link = element("a");
  link.href = plotURL;
  link.download = plotFilename;
  link.click();
});
$("plot-open").addEventListener("click", () => { if (plotURL) window.open(plotURL, "_blank", "noopener"); });

function renderEvalSummary(models) {
  if (!models.length) { $("eval-summary").replaceChildren(element("p", "provenance", "No models selected.")); return; }
  const table = element("table");
  const head = element("tr");
  for (const title of ["Domain", ...models.map((model) => modelNames[model.model_name])]) {
    const cell = element("th", "", title);
    cell.scope = "col";
    head.append(cell);
  }
  const thead = element("thead");
  thead.append(head);
  const tbody = element("tbody");
  const domains = evalData.metadata.domains.map((domain) => [domain, domainNames[domain] || domain]);
  if (domains.length > 1) domains.push(["all", "Overall"]);
  for (const [domain, label] of domains) {
    const row = element("tr");
    const heading = element("th", "", label);
    heading.scope = "row";
    row.append(heading);
    for (const model of models) {
      const value = domain === "all" ? model : model.categories[domain];
      row.append(element("td", "", `${(100 * value.score).toFixed(2)}% (${value.correct_responses}/${value.responses_judged})`));
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  const metadata = evalData.metadata;
  const dates = [...new Set(models.map((model) => metadata.sources[model.model_name].generated_at.slice(0, 10)))].sort();
  const inference = metadata.inference;
  const provenance = element("p", "provenance", `Generated ${dates.join(", ")}. ${metadata.items} questions per model, ${metadata.responses_per_question} responses each; temperature ${inference.temperature}, ${byModel(models, "thinking", (mode) => `thinking ${mode}`)}, maximum ${inference.max_genlen} tokens. Scorer: ${metadata.judge_model}. Scoring input: ${byModel(models, "scoring_input", (input) => input)}.${metadata.selection_seed === null ? "" : ` Test-set selection seed: ${metadata.selection_seed}.`}`);
  $("eval-summary").replaceChildren(table, provenance);
}

// A per-model setting as text: the value alone when the models share it, else each value with its models.
function byModel(models, key, format) {
  const groups = new Map();
  for (const model of models) groups.set(model[key], [...(groups.get(model[key]) || []), modelNames[model.model_name]]);
  if (groups.size === 1) return format([...groups.keys()][0]);
  return [...groups].map(([value, names]) => `${format(value)} (${names.join(", ")})`).join("; ");
}

function renderEval() {
  if (!evalData) return;
  const model = $("eval-model").value;
  const domain = $("eval-domain").value;
  const verdict = $("eval-verdict").value;
  const search = $("eval-search").value.trim().toLowerCase();
  const rows = evalData.samples.filter((row) =>
    selectedModels.has(row.model) && (model === "all" || row.model === model) && (domain === "all" || row.domain === domain) &&
    (verdict === "all" || row.score === Number(verdict)) &&
    (!search || [row.term, row.question, row.model_response, row.reference_answer, row.reasoning, row.judge_explanation].join("\n").toLowerCase().includes(search)));
  evalPage = Math.min(evalPage, Math.max(0, Math.ceil(rows.length / 20) - 1));
  const correct = rows.reduce((sum, row) => sum + row.score, 0);
  const thinking = new Map(evalData.metadata.models.map((entry) => [entry.model_name, entry.thinking]));
  $("eval-count").textContent = `${rows.length} ${rows.length === 1 ? "response" : "responses"}: ${correct} correct, ${rows.length - correct} incorrect`;
  pagination("eval-pagination", rows.length, evalPage, 20, (page) => {
    evalPage = page;
    renderEval();
    $("eval-count").scrollIntoView({ block: "center" });
  });
  const nodes = rows.slice(evalPage * 20, (evalPage + 1) * 20).map((row) => {
    const badge = element("span", `badge ${row.score ? "correct" : "incorrect"}`, row.score ? "Correct" : "Incorrect");
    const details = sampleShell(row.question, `${modelNames[row.model]} | ${domainNames[row.domain]} | Sample ${row.sample_index + 1}`, badge);
    const mark = element("span", "model-mark");
    mark.style.backgroundColor = modelColors[row.model];
    mark.setAttribute("aria-hidden", "true");
    details.querySelector(".sample-meta").prepend(mark);
    return lazyBody(details, (body) => {
      body.append(element("h4", "", "Model answer"), element("div", "text", row.model_response || "No visible answer."));
      if (row.reasoning) body.append(disclosure("Thinking", row.reasoning));
      body.append(element("h4", "", "Reference answer"), element("div", "text", row.reference_answer));
      const judge = element("div", "judge-explanation");
      judge.append(element("h4", "", `${row.judge_model === "gsm8k_exact_match" ? "Scorer" : "Judge"}: ${row.judge_model}`), element("div", "text", row.judge_explanation));
      body.append(judge, element("p", "provenance", `${row.id} | ${row.generated_tokens} generated tokens${row.turn_closed ? "" : " | Turn did not close"}${row.think_closed || thinking.get(row.model) === "off" ? "" : " | Thinking did not close"}`));
      if (row.source_url && /^https?:\/\//.test(row.source_url)) {
        const source = element("a", "text-link", "Reference source");
        source.href = row.source_url;
        source.target = "_blank";
        source.rel = "noopener noreferrer";
        body.append(source);
      }
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
// Every rendered message: its text, the reasoning shown with it, its node and whether it is in chatHistory.
let chatTurns = [];
const emptyChat = $("chat-empty");
const configReady = getJSON("site.json", { cache: "no-store" }).then((config) => {
  const url = new URL(config.chat_base_url);
  if (url.protocol !== "https:") throw new Error("Chat requires an HTTPS endpoint.");
  config.chat_base_url = url.href.replace(/\/$/, "");
  chatConfig = config;
  $("api-link").href = `${config.chat_base_url.replace(/\/v1$/, "")}/api`;
  $("chat-model").replaceChildren(...config.models.map((model) => new Option(model.name, model.id)));
  showChatModel();
  return config;
});

function showChatModel() {
  const model = chatConfig?.models.find((candidate) => candidate.id === $("chat-model").value);
  if (!model) return;
  emptyChat.querySelector("h2").textContent = model.id;
  emptyChat.querySelector("p").textContent = model.description;
}

function connection(online, text) {
  $("chat-connection").textContent = text || (online ? "Connected" : "Chat is temporarily offline");
  $("chat-connection").classList.toggle("online", online);
}

// The inference server sleeps when it is not needed. /power on the chat host reports
// asleep, starting (with its startup log) or awake, and POST /power/wake starts it.
let chatAwake = false;
let powerState;
let powerWatched = false;
let powerTimer;
const powerURL = (path = "") => `${chatConfig.chat_base_url.replace(/\/v1$/, "")}/power${path}`;

function setChatAwake(awake, placeholder = "The inference server is asleep") {
  chatAwake = awake;
  $("chat-send").disabled = !awake || chatBusy;
  $("chat-input").placeholder = awake ? "Message Annulus" : placeholder;
}

function showPower({ title, note = "", error = false, log, spinner = false, button }) {
  $("chat").classList.add("power-shown");
  $("chat-power").hidden = false;
  $("chat-power-title").textContent = title;
  $("chat-power-note").textContent = note;
  $("chat-power-note").hidden = !note;
  $("chat-power-note").classList.toggle("error", error);
  $("chat-power-spinner").hidden = !spinner;
  $("chat-power-log").hidden = !log;
  if (log) {
    $("chat-power-log").textContent = log.join("\n");
    $("chat-power-log").scrollTop = $("chat-power-log").scrollHeight;
  }
  $("chat-power-button").hidden = !button;
  if (button) $("chat-power-button").textContent = button;
}

function hidePower() {
  $("chat").classList.remove("power-shown");
  $("chat-power").hidden = true;
}

function showWaking(log) {
  showPower({ title: "This takes ~15 minutes", note: "Waking up the inference server...", spinner: true,
    log: log.length ? log : ["Waiting for the server's first log lines..."] });
}

function renderPower(status) {
  clearTimeout(powerTimer);
  powerState = status.state;
  if (status.state === "awake") {
    connection(true);
    setChatAwake(true);
    if (powerWatched) showPower({ title: "Inference server has been woken up!", button: "CLOSE" });
    else hidePower();
    // The server sleeps after a while without messages; notice it without waiting for a failed send.
    powerTimer = setTimeout(checkPower, 60000);
    return;
  }
  setChatAwake(false, status.state === "starting" ? "The inference server is waking up" : undefined);
  if (status.state === "starting") {
    powerWatched = true;
    connection(false, "Waking up...");
    showWaking(status.log);
    powerTimer = setTimeout(checkPower, 2000);
  } else {
    connection(false, "Inference server asleep");
    showPower({ title: "Inference server is currently asleep", note: status.error || "", error: Boolean(status.error),
      button: "WAKE UP" });
    powerTimer = setTimeout(checkPower, 20000);
  }
}

async function checkPower() {
  const config = chatConfig || await configReady;
  clearTimeout(powerTimer);
  try {
    renderPower(await getJSON(powerURL(), { cache: "no-store", signal: AbortSignal.timeout(10000) }));
  } catch {
    // A chat host without /power: fall back to probing the API directly.
    hidePower();
    try {
      await getJSON(`${config.chat_base_url}/models`, { signal: AbortSignal.timeout(8000) });
      connection(true);
      setChatAwake(true);
    } catch {
      connection(false);
      setChatAwake(false);
      powerTimer = setTimeout(checkPower, 20000);
    }
  }
}
configReady.then(checkPower).catch(() => connection(false));

$("chat-power-button").addEventListener("click", async () => {
  if (powerState === "awake") {
    powerWatched = false;
    hidePower();
    $("chat-input").focus();
    return;
  }
  clearTimeout(powerTimer);
  $("chat-power-button").disabled = true;
  powerWatched = true;
  showWaking(["Asking the server to wake up..."]);
  try {
    renderPower(await getJSON(powerURL("/wake"), { method: "POST", signal: AbortSignal.timeout(60000) }));
  } catch {
    renderPower({ state: "asleep", log: [], error: "The wake-up request failed. Please try again." });
  } finally {
    $("chat-power-button").disabled = false;
  }
});

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
  if (chatBusy || !chatAwake || !content || !$("chat-max-tokens").reportValidity()) return;
  if (powerState === "awake") {
    powerWatched = false;
    hidePower();
  }
  chatBusy = true;
  $("chat-send").disabled = true;
  $("chat-clear").disabled = true;
  $("chat-model").disabled = true;
  $("chat-input").readOnly = true;
  emptyChat.remove();
  const userNode = chatMessage("user", content);
  const userTurn = { role: "user", content, display: content, node: userNode, inHistory: true };
  chatTurns.push(userTurn);
  $("chat-input").value = "";
  $("chat-status").classList.remove("error");
  $("chat-status").textContent = "Generating...";
  try {
    const config = chatConfig || await configReady;
    const messages = [...chatHistory, { role: "user", content }];
    const response = await getJSON(`${config.chat_base_url}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({ model: $("chat-model").value, messages, thinking: $("chat-thinking").checked,
        max_completion_tokens: Number($("chat-max-tokens").value) }),
    });
    const choice = response.choices?.[0];
    const answer = choice?.message?.content;
    const reasoning = choice?.message?.reasoning_content;
    if (typeof answer !== "string") throw new Error("The server returned no answer.");
    const display = answer || "No final answer was generated within the token limit.";
    chatTurns.push({ role: "assistant", content: answer, reasoning, display,
      node: chatMessage("assistant", display, reasoning), inHistory: Boolean(answer) });
    chatHistory = answer ? [...messages, { role: "assistant", content: answer }] : messages;
    if ($("chat-jlens").checked) loadJlensTokens();
    $("chat-status").textContent = choice.finish_reason === "length" ? "Token limit reached." : "";
    connection(true);
  } catch (error) {
    userNode.remove();
    chatTurns = chatTurns.filter((turn) => turn !== userTurn);
    $("chat-input").value = content;
    if (!chatHistory.length) $("chat-messages").replaceChildren(emptyChat);
    $("chat-status").textContent = error.name === "TimeoutError" ? "Request timed out. The server may still be generating." : error instanceof TypeError ? "Could not reach the chat server. Please try again later." : error.message;
    $("chat-status").classList.add("error");
    if (error instanceof TypeError || error.name === "TimeoutError") connection(false);
    checkPower();
  } finally {
    chatBusy = false;
    $("chat-send").disabled = !chatAwake;
    $("chat-clear").disabled = false;
    $("chat-model").disabled = false;
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
  chatTurns = [];
  resetJlens();
  $("chat-messages").replaceChildren(emptyChat);
  $("chat-input").value = "";
  $("chat-status").textContent = "";
  $("chat-input").focus();
});
// Each model gets its own conversation: another model's replies are not its own.
$("chat-model").addEventListener("change", () => {
  showChatModel();
  $("chat-clear").click();
});

// J-lens: the conversation's tokens as the model saw them in its latest reply (earlier
// replies without their reasoning, as they were sent back), each clickable. A click reads
// the selected checkpoint's Jacobian lens at that token, averaged over a range of layers.
let jlens = { turns: [], messages: [], skipFirst: 0, position: null, tokensRequest: 0, readRequest: 0 };

function jlensTurns() {
  const last = chatTurns[chatTurns.length - 1];
  return chatTurns.filter((turn) => turn.inHistory || (turn === last && turn.reasoning));
}

function jlensMessage(turn, last) {
  const message = { role: turn.role, content: turn.content };
  if (turn === last && turn.role === "assistant" && turn.reasoning) message.reasoning_content = turn.reasoning;
  return message;
}

async function postJlens(body) {
  const config = chatConfig || await configReady;
  return getJSON(`${config.chat_base_url}/jlens`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: $("chat-model").value, messages: jlens.messages, ...body }),
  });
}

function jlensStatus(text, error = false) {
  $("jlens-status").textContent = text;
  $("jlens-status").classList.toggle("error", error);
}

function shownToken(text) { return JSON.stringify(text); }

function clearJlensResult() {
  $("jlens-token").textContent = "";
  $("jlens-top").replaceChildren();
  $("jlens-model").textContent = "";
  $("jlens-per-layer").hidden = true;
}

function plainTurns() {
  for (const turn of chatTurns) {
    turn.node.classList.remove("jlens-view", "jlens-reasoning");
    turn.node.querySelector(":scope > .text").textContent = turn.display;
  }
}

function resetJlens() {
  jlens = { ...jlens, turns: [], messages: [], position: null, tokensRequest: jlens.tokensRequest + 1 };
  clearJlensResult();
  jlensStatus(chatTurns.length ? "" : "Send a message, then click any token of the conversation.");
}

async function loadJlensTokens() {
  plainTurns();
  resetJlens();
  const turns = jlensTurns();
  if (!turns.length) return;
  const last = chatTurns[chatTurns.length - 1];
  jlens.turns = turns;
  jlens.messages = turns.map((turn) => jlensMessage(turn, last));
  const request = jlens.tokensRequest;
  jlensStatus("Loading the conversation's tokens...");
  try {
    const result = await postJlens({});
    if (request !== jlens.tokensRequest || !$("chat-jlens").checked) return;
    jlens.skipFirst = result.skip_first;
    const groups = turns.map(() => []);
    result.tokens.forEach((token, position) => {
      // A newline shows as ↵ before the break, so a token of only whitespace stays clickable.
      const span = element("span", `tok tok-${token.part}${position < result.skip_first ? " tok-sink" : ""}`, token.text.replace(/\n/g, "↵\n"));
      span.dataset.position = position;
      span.title = position < result.skip_first ? `position ${position}: before ${result.skip_first}, not used to fit the lens` : `position ${position}`;
      groups[token.message]?.push(span);
    });
    turns.forEach((turn, index) => {
      turn.node.classList.add("jlens-view");
      turn.node.classList.toggle("jlens-reasoning", turn === last && Boolean(turn.reasoning));
      turn.node.querySelector(":scope > .text").replaceChildren(...groups[index]);
    });
    jlensStatus("Click any token to read the lens there.");
  } catch (error) {
    if (request !== jlens.tokensRequest) return;
    jlensStatus(error.name === "TimeoutError" ? "The J-lens request timed out." : error instanceof TypeError ? "Could not reach the chat server." : error.message, true);
  }
}

function layerRange() {
  const from = Number($("jlens-from").value);
  const to = Number($("jlens-to").value);
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= 40 ? [from, to] : null;
}

function probabilityRow(entry, scale) {
  const row = element("li");
  const bar = element("span", "jlens-bar");
  bar.append(element("span"));
  bar.firstChild.style.width = `${Math.max(1, Math.round(100 * entry.prob / scale))}%`;
  row.append(element("code", "jlens-word", shownToken(entry.token)), bar, element("span", "jlens-prob", `${(100 * entry.prob).toFixed(1)}%`));
  return row;
}

async function readJlens() {
  if (jlens.position === null) return;
  const layers = layerRange();
  if (!layers) {
    jlensStatus("Choose layers from 0 to 40, the first no higher than the last.", true);
    return;
  }
  const request = ++jlens.readRequest;
  jlensStatus(`Reading layers ${layers[0]}-${layers[1]}...`);
  try {
    const result = await postJlens({ position: jlens.position, layers, top_k: 10 });
    if (request !== jlens.readRequest) return;
    $("jlens-token").textContent = `token ${result.position} ${shownToken(result.token)}, mean over layers ${result.layers[0]}-${result.layers[1]}`;
    const scale = result.top[0]?.prob || 1;
    $("jlens-top").replaceChildren(...result.top.map((entry) => probabilityRow(entry, scale)));
    $("jlens-model").textContent = `Model's next token: ${result.model_top.map((entry) => `${shownToken(entry.token)} ${(100 * entry.prob).toFixed(0)}%`).join(", ")}`;
    const table = element("table", "jlens-table");
    for (const layer of result.per_layer) {
      const row = element("tr");
      row.append(element("th", "", `L${layer.layer}`));
      for (const entry of layer.top) row.append(element("td", "", `${shownToken(entry.token)} ${(100 * entry.prob).toFixed(0)}%`));
      table.append(row);
    }
    $("jlens-layer-table").replaceChildren(table);
    $("jlens-per-layer").hidden = false;
    jlensStatus(result.position < jlens.skipFirst ? `Positions before ${jlens.skipFirst} act as attention sinks and were not used to fit the lens.` : "");
  } catch (error) {
    if (request !== jlens.readRequest) return;
    jlensStatus(error.name === "TimeoutError" ? "The J-lens request timed out." : error instanceof TypeError ? "Could not reach the chat server." : error.message, true);
  }
}

$("chat-jlens").addEventListener("change", () => {
  $("jlens-box").hidden = !$("chat-jlens").checked;
  if ($("chat-jlens").checked) loadJlensTokens();
  else {
    resetJlens();
    plainTurns();
  }
});
$("chat-messages").addEventListener("click", (event) => {
  const token = event.target.closest(".tok");
  if (!token || !$("chat-jlens").checked) return;
  $("chat-messages").querySelector(".tok.selected")?.classList.remove("selected");
  token.classList.add("selected");
  jlens.position = Number(token.dataset.position);
  readJlens();
});
let layerTimer;
for (const id of ["jlens-from", "jlens-to"]) {
  $(id).addEventListener("input", () => {
    clearTimeout(layerTimer);
    layerTimer = setTimeout(readJlens, 300);
  });
}

showView();
icons();
