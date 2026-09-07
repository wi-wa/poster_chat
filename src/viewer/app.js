const DATA_URLS = [
  "../../data/judge/rated/hand_annotated_rated.jsonl",
];

// Optional, separately generated ratings are merged into matching live rows.
// A missing overlay is harmless: the viewer continues with the LLM ratings.
const RATING_OVERLAY_URLS = [
  "../../data/judge/rated/hand_annotated_embedding_ratings.jsonl",
];

const PREFIX_MATCH_CHARS = 200;

const CONFIG_URL = "../../configs/filter/judge.json";
// Per-filter, per-model rating moments over the full corpus, precomputed by
// scripts/filter/compute_rating_stats.py. The z-values knob standardizes
// against these rather than against whatever subset a page happens to load, so
// a z-value means the same thing on both pages.
const RATING_STATS_URL = "../../data/judge/rating_stats.json";
// The hand-label page is driven by the standalone hand rated file, which holds
// the human labels and the judge ratings on the same row. The annotation file
// is only a fallback, used when that file has not been generated yet.
const HAND_RATED_URL = "../../data/judge/rated/hand_annotated_rated.jsonl";
const ANNOTATIONS_URL = "../../data/judge/raw/hand_annotated_samples.jsonl";

// Hand-annotation JSONL keys -> rated-output filter names.
const HUMAN_LABEL_FILTERS = [
  { key: "pom-rating", filter: "philosophy_of_mind", short: "pom" },
  { key: "reification-rating", filter: "reified_experience", short: "reif" },
  { key: "experience-rating", filter: "experience_descriptions", short: "exp" },
];

const state = {
  documents: [],
  visible: [],
  selectedIndex: 0,
  filterName: "",
  ratingFilter: "all",
  labelsFilter: HUMAN_LABEL_FILTERS[0].filter, // labels page: which filter to show
  labelsSort: "hand", // labels page: hand-label diff or inter-model variance
  labelsThreshold: 5, // labels page: raw-scale classification threshold
  labelsThresholdZ: 0, // labels page: z-scale threshold, kept separately so
  //                      toggling the scale never destroys the other setting
  labelsAccuracyAggregation: "mean", // labels page: mean or max checked-model score
  zMode: false, // aggregate standardized ratings instead of raw 0-10 ratings
  ratingStats: null, // {filter: {model: {n, mean, std, ...}}} or null if unloaded
  ratingStatsError: "", // why the stats file could not be used, if it could not
  missingStatModels: new Set(), // "filter model" pairs z mode had to drop
  binning: null, // histogram bins for the active scale, refreshed each render
  labelsItems: [], // labels page: current filter's items with fresh means/diffs
  disabledModels: new Set(), // models unchecked in the "Model agreement" box
  expandedJudges: new Set(), // judge cards showing their individual repeats,
  //                            keyed per document so expanding one judge on one
  //                            document does not expand it everywhere
  promptPaths: {}, // filter name -> prompt file path (from config.json)
  promptCache: {}, // filter name -> fetched prompt text
  annotations: null, // lazy-loaded rows of the hand rated JSONL
};

// Resolves once the corpus rated JSONL has loaded (or failed). Only the data
// page depends on it; the hand-label page loads its own file.
let documentsReady = Promise.resolve();

const els = {
  homeView: document.getElementById("homeView"),
  labelsView: document.getElementById("labelsView"),
  dataView: document.getElementById("dataView"),
  labelsStatusText: document.getElementById("labelsStatusText"),
  labelsFilterSelect: document.getElementById("labelsFilterSelect"),
  distributionButton: document.getElementById("distributionButton"),
  labelsSortSelect: document.getElementById("labelsSortSelect"),
  labelsSortNote: document.getElementById("labelsSortNote"),
  labelsZToggle: document.getElementById("labelsZToggle"),
  dataZToggle: document.getElementById("dataZToggle"),
  labelsZNote: document.getElementById("labelsZNote"),
  dataZNote: document.getElementById("dataZNote"),
  thresholdNote: document.getElementById("thresholdNote"),
  modelStatsScaleNote: document.getElementById("modelStatsScaleNote"),
  labelsBody: document.getElementById("labelsBody"),
  correlationCaption: document.getElementById("correlationCaption"),
  correlationMatrix: document.getElementById("correlationMatrix"),
  modelStatsList: document.getElementById("modelStatsList"),
  modelStatsCaption: document.getElementById("modelStatsCaption"),
  thresholdRange: document.getElementById("thresholdRange"),
  thresholdMinus: document.getElementById("thresholdMinus"),
  thresholdPlus: document.getElementById("thresholdPlus"),
  thresholdValue: document.getElementById("thresholdValue"),
  accuracyAggregationSelect: document.getElementById("accuracyAggregationSelect"),
  accuracyList: document.getElementById("accuracyList"),
  overallValue: document.getElementById("overallValue"),
  overallN: document.getElementById("overallN"),
  statusText: document.getElementById("statusText"),
  filterSelect: document.getElementById("filterSelect"),
  promptButton: document.getElementById("promptButton"),
  promptModal: document.getElementById("promptModal"),
  promptModalTitle: document.getElementById("promptModalTitle"),
  promptModalText: document.getElementById("promptModalText"),
  promptModalClose: document.getElementById("promptModalClose"),
  prevButton: document.getElementById("prevButton"),
  nextButton: document.getElementById("nextButton"),
  positionText: document.getElementById("positionText"),
  chartSummary: document.getElementById("chartSummary"),
  histogram: document.getElementById("histogram"),
  chartTooltip: document.getElementById("chartTooltip"),
  documentList: document.getElementById("documentList"),
  documentTitle: document.getElementById("documentTitle"),
  documentSubhead: document.getElementById("documentSubhead"),
  meanBadge: document.getElementById("meanBadge"),
  judgementList: document.getElementById("judgementList"),
  documentText: document.getElementById("documentText"),
};

function isValidRating(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10;
}

// One model's verdict on one document, collapsed from its run.avg_over_n
// repeats. `rating` is the mean over the repeats and is what every aggregate in
// this file consumes, so nothing downstream has to know repeats exist;
// `samples` keeps them individually for the per-judge drill-down. A single
// unrepeated judgement collapses to itself with one sample.
function collapseSamples(samples) {
  const mean = samples.reduce((sum, sample) => sum + sample.rating, 0) / samples.length;
  // The collapsed card shows one repeat's prose. Repeats are interchangeable,
  // so prefer whichever actually said something over an empty first repeat.
  const spoken = samples.find((sample) => sample.explanation || sample.quote) ?? samples[0];
  return {
    rating: mean,
    explanation: spoken.explanation,
    quote: spoken.quote,
    samples,
  };
}

// Returns {filterName: {model: {rating, explanation, quote, samples}}} for a
// JSONL row. Repeated entries for one model are folded into one record.
function extractRatings(row) {
  const result = {};

  if (row?.ratings && typeof row.ratings === "object") {
    for (const [filterName, entries] of Object.entries(row.ratings)) {
      if (!Array.isArray(entries)) continue;
      const byModel = new Map();
      for (const entry of entries) {
        if (typeof entry?.model === "string" && isValidRating(entry?.rating)) {
          const sample = {
            rating: entry.rating,
            explanation: typeof entry.explanation === "string" ? entry.explanation : "",
            quote: typeof entry.quote === "string" ? entry.quote : "",
          };
          const existing = byModel.get(entry.model);
          if (existing) existing.push(sample);
          else byModel.set(entry.model, [sample]);
        }
      }
      for (const [model, samples] of byModel) {
        (result[filterName] ??= {})[model] = collapseSamples(samples);
      }
    }
  }

  return result;
}

function parseJsonl(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // tolerate a partial trailing line from an interrupted run
    }
    const ratings = extractRatings(row);
    if (
      Object.keys(ratings).length > 0 &&
      typeof row.text === "string" &&
      row.text.length > 0
    ) {
      rows.push({
        originalIndex: index + 1,
        ratings,
        text: row.text,
      });
    }
  }

  return rows;
}

// Join an optional rating file to the already loaded live corpus. Exact text
// wins; a 200-character prefix is the same fallback used for hand labels.
// Existing model names are never replaced.
function mergeRatingOverlay(documents, overlayDocuments) {
  const byText = new Map();
  const byPrefix = new Map();
  for (const doc of documents) {
    byText.set(doc.text, doc);
    const prefix = doc.text.slice(0, PREFIX_MATCH_CHARS);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, doc);
  }

  let matchedRows = 0;
  let addedRatings = 0;
  let collisions = 0;
  for (const overlay of overlayDocuments) {
    const matched =
      byText.get(overlay.text) ??
      byPrefix.get(overlay.text.slice(0, PREFIX_MATCH_CHARS)) ??
      null;
    if (!matched) continue;

    matchedRows += 1;
    for (const [filterName, entries] of Object.entries(overlay.ratings)) {
      const destination = (matched.ratings[filterName] ??= {});
      for (const [model, entry] of Object.entries(entries)) {
        if (model in destination) {
          collisions += 1;
          continue;
        }
        destination[model] = entry;
        addedRatings += 1;
      }
    }
  }
  return { matchedRows, addedRatings, collisions };
}

function getEntries(doc) {
  return doc.ratings[state.filterName] ?? null;
}

/* ---------- Rating scale (raw 0-10 vs corpus z-values) ---------- */

// Corpus moments for one model under one filter, or null when the stats file
// has no entry for that pair.
function ratingStatFor(filterName, model) {
  const entry = state.ratingStats?.[filterName]?.[model];
  if (!entry) return null;
  if (!Number.isFinite(entry.mean) || !Number.isFinite(entry.std)) return null;
  return entry;
}

// One model's rating on the active scale. In z mode a model with no corpus
// statistics is dropped rather than silently mixed in on the wrong scale; a
// model whose corpus ratings are constant has no spread to standardize by, so
// every one of its documents sits at the mean, z = 0.
function scoreForModel(rating, filterName, model) {
  if (!state.zMode) return rating;
  const stat = ratingStatFor(filterName, model);
  if (!stat) {
    state.missingStatModels.add(`${filterName} ${model}`);
    return null;
  }
  if (stat.std === 0) return 0;
  return (rating - stat.mean) / stat.std;
}

// Scores for every checked model on one document, on the active scale.
// Ratings from models unchecked in the "Model agreement" box are excluded from
// every aggregate (and everything derived from one).
function scoresForFilter(entries, filterName) {
  if (!entries) return [];
  const scores = [];
  for (const [model, entry] of Object.entries(entries)) {
    if (state.disabledModels.has(model)) continue;
    const score = scoreForModel(entry.rating, filterName, model);
    if (score !== null) scores.push(score);
  }
  return scores;
}

function scaleName() {
  return state.zMode ? "z-value" : "rating";
}

function isZModeAvailable() {
  return state.ratingStats !== null;
}

function getMeanForFilter(doc, filterName) {
  const scores = scoresForFilter(doc?.ratings[filterName], filterName);
  if (scores.length === 0) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

// Mean checked-model rating on the raw 0-10 scale, whatever the active scale.
// Used where the other operand is a raw rating and standardizing one side of
// the comparison would make it meaningless.
function rawMeanForFilter(doc, filterName) {
  const entries = doc?.ratings[filterName];
  if (!entries) return null;
  const ratings = Object.entries(entries)
    .filter(([model]) => !state.disabledModels.has(model))
    .map(([, entry]) => entry.rating);
  if (ratings.length === 0) return null;
  return ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
}

// Aggregate the checked models for threshold-based accuracy metrics. Other
// viewer calculations deliberately continue to use their existing means.
function getAccuracyScoreForFilter(doc, filterName, aggregation) {
  const scores = scoresForFilter(doc?.ratings[filterName], filterName);
  if (scores.length === 0) return null;
  if (aggregation === "max") return Math.max(...scores);
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function getMean(doc) {
  return getMeanForFilter(doc, state.filterName);
}

// Raw ratings span 10 points, so a 5-point gap is half the scale. Standardized
// ratings have unit spread by construction, so the z-mode equivalent is
// expressed in standard deviations instead.
const DISAGREEMENT_THRESHOLD = 5;
const DISAGREEMENT_THRESHOLD_Z = 1.5;

function disagreementThreshold() {
  return state.zMode ? DISAGREEMENT_THRESHOLD_Z : DISAGREEMENT_THRESHOLD;
}

function hasHighDisagreement(doc) {
  const scores = scoresForFilter(getEntries(doc), state.filterName);
  if (scores.length < 2) return false;
  return Math.max(...scores) - Math.min(...scores) >= disagreementThreshold();
}

function formatMean(mean) {
  if (mean === null) return "-";
  if (state.zMode) return (mean >= 0 ? "+" : "") + mean.toFixed(2);
  return Number.isInteger(mean) ? String(mean) : mean.toFixed(1);
}

function collectFilterNames() {
  const names = new Set();
  for (const doc of state.documents) {
    for (const name of Object.keys(doc.ratings)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function populateFilterControls() {
  const filterNames = collectFilterNames();
  els.filterSelect.replaceChildren(
    ...filterNames.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      return option;
    }),
  );
  state.filterName = filterNames.includes(state.filterName)
    ? state.filterName
    : (filterNames[0] ?? "");
  els.filterSelect.value = state.filterName;
}

function summarize(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

/* ---------- Histogram binning ---------- */

const HISTOGRAM_BINS = 11;

// Bins for the active scale, recomputed once per render and shared by the
// histogram and the bin filter so the two can never disagree.
//
// Raw mode keeps the fixed integer 0-10 bins the viewer has always used. Z mode
// has no fixed range: standardizing a filter whose corpus ratings are nearly
// all zero stretches its few positives out to very large z, so the bins span
// the observed range of the current filter instead of assuming +/-3.
function computeBinning() {
  if (!state.zMode) {
    return {
      count: HISTOGRAM_BINS,
      binOf: (mean) => Math.round(mean),
      label: (bin) => String(bin),
      tooltip: (bin) => `mean ≈ ${bin}`,
    };
  }

  let low = Infinity;
  let high = -Infinity;
  for (const doc of state.documents) {
    const mean = getMeanForFilter(doc, state.filterName);
    if (mean === null) continue;
    if (mean < low) low = mean;
    if (mean > high) high = mean;
  }
  if (!Number.isFinite(low)) {
    low = 0;
    high = 0;
  }
  const width = high > low ? (high - low) / HISTOGRAM_BINS : 1;
  const edge = (bin) => low + bin * width;
  const fmt = (value) => (value >= 0 ? "+" : "") + value.toFixed(1);

  return {
    count: HISTOGRAM_BINS,
    binOf: (mean) =>
      Math.max(0, Math.min(HISTOGRAM_BINS - 1, Math.floor((mean - low) / width))),
    label: (bin) => fmt(edge(bin)),
    tooltip: (bin) => `mean z ${fmt(edge(bin))} to ${fmt(edge(bin + 1))}`,
  };
}

function getBin(doc) {
  const mean = getMean(doc);
  return mean === null ? null : state.binning.binOf(mean);
}

function applyFilters() {
  const ratingFilter = state.ratingFilter;

  let docs = state.documents.filter((doc) => {
    const bin = getBin(doc);
    if (bin === null) {
      return false;
    }
    if (ratingFilter !== "all" && bin !== Number(ratingFilter)) {
      return false;
    }
    return true;
  });

  // Fixed sort: highest mean rating first.
  docs = docs.toSorted(
    (a, b) => getMean(b) - getMean(a) || a.originalIndex - b.originalIndex,
  );

  state.visible = docs;
  state.selectedIndex = Math.min(state.selectedIndex, Math.max(docs.length - 1, 0));
}

/* ---------- Histogram ---------- */

function computeHistogram() {
  const counts = Array.from({ length: state.binning.count }, () => 0);
  for (const doc of state.documents) {
    const bin = getBin(doc);
    if (bin !== null) counts[bin] += 1;
  }
  return counts;
}

function showBinTooltip(binButton, count, bin) {
  const tooltip = els.chartTooltip;
  tooltip.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = `${formatNumber(count)} document${count === 1 ? "" : "s"}`;
  tooltip.append(strong, document.createTextNode(` · ${state.binning.tooltip(bin)}`));
  tooltip.hidden = false;

  const cardRect = els.histogram.parentElement.getBoundingClientRect();
  const binRect = binButton.getBoundingClientRect();
  const left = binRect.left - cardRect.left + binRect.width / 2;
  tooltip.style.left = `${Math.max(8, Math.min(left, cardRect.width - 8))}px`;
  tooltip.style.top = `${binRect.top - cardRect.top - 6}px`;
  tooltip.style.transform = "translate(-50%, -100%)";
}

function hideBinTooltip() {
  els.chartTooltip.hidden = true;
}

function renderHistogram() {
  const counts = computeHistogram();
  const maxCount = Math.max(...counts, 1);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const hasSelection = state.ratingFilter !== "all";

  const unchecked = state.disabledModels.size;
  els.chartSummary.textContent =
    `${formatNumber(total)} documents · mean ${scaleName()} across models` +
    (unchecked > 0 ? ` (${unchecked} unchecked)` : "") +
    ` · ${state.filterName}`;

  els.histogram.replaceChildren(
    ...counts.map((count, bin) => {
      const isSelected = state.ratingFilter === String(bin);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bin";
      if (isSelected) button.classList.add("is-selected");
      if (hasSelection && !isSelected) button.classList.add("is-dimmed");
      button.setAttribute("aria-pressed", String(isSelected));
      button.setAttribute(
        "aria-label",
        `${state.binning.tooltip(bin)}: ${formatNumber(count)} documents`,
      );
      button.addEventListener("click", () => {
        state.ratingFilter = isSelected ? "all" : String(bin);
        state.selectedIndex = 0;
        render();
      });
      button.addEventListener("pointerenter", () => showBinTooltip(button, count, bin));
      button.addEventListener("pointerleave", hideBinTooltip);
      button.addEventListener("focus", () => showBinTooltip(button, count, bin));
      button.addEventListener("blur", hideBinTooltip);

      const track = document.createElement("div");
      track.className = "bin-track";
      const heightPct = count > 0 ? Math.max(3, (count / maxCount) * 88) : 0;
      const fill = document.createElement("div");
      fill.className = "bin-fill";
      fill.style.height = `${heightPct}%`;
      track.append(fill);

      if (count > 0) {
        const countEl = document.createElement("div");
        countEl.className = "bin-count";
        countEl.textContent = formatNumber(count);
        countEl.style.bottom = `calc(${heightPct}% + 4px)`; // ride the bar cap
        track.append(countEl);
      }

      const label = document.createElement("div");
      label.className = "bin-x";
      label.textContent = state.binning.label(bin);

      button.append(track, label);
      return button;
    }),
  );
}

/* ---------- Document list ---------- */

function renderList() {
  if (state.visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No rated documents match the current view.";
    els.documentList.replaceChildren(empty);
    return;
  }

  const activeDoc = state.visible[state.selectedIndex];
  const nearActive = state.visible
    .map((doc, index) => ({ doc, index }))
    .filter(({ index }) => {
      if (state.visible.length <= 150) return true;
      return Math.abs(index - state.selectedIndex) <= 75;
    });

  els.documentList.replaceChildren(
    ...nearActive.map(({ doc, index }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "document-list-item";
      if (doc === activeDoc) {
        button.classList.add("is-active");
      }
      button.addEventListener("click", () => {
        state.selectedIndex = index;
        render();
      });

      const indexEl = document.createElement("div");
      indexEl.className = "list-index";
      indexEl.textContent = `#${doc.originalIndex}`;

      const snippet = document.createElement("div");
      snippet.className = "list-snippet";
      snippet.textContent = summarize(doc.text);

      const meanCell = document.createElement("div");
      meanCell.className = "list-mean-cell";

      if (hasHighDisagreement(doc)) {
        const flag = document.createElement("span");
        flag.className = "list-disagreement";
        flag.textContent = "!";
        flag.title =
          `Models disagree by ${DISAGREEMENT_THRESHOLD}+ points on this document`;
        meanCell.append(flag);
      }

      const mean = document.createElement("div");
      mean.className = "list-mean";
      mean.textContent = formatMean(getMean(doc));
      meanCell.append(mean);

      button.append(indexEl, snippet, meanCell);
      return button;
    }),
  );

  const active = els.documentList.querySelector(".is-active");
  active?.scrollIntoView({ block: "nearest" });
}

/* ---------- Document detail ---------- */

// One repeat of one judge: its own rating, explanation and quote.
function buildRepeatCard(index, sample, filterName, model) {
  const repeat = document.createElement("div");
  repeat.className = "judgement-repeat";

  const head = document.createElement("div");
  head.className = "judgement-repeat-head";

  const label = document.createElement("span");
  label.className = "judgement-repeat-index";
  label.textContent = `#${index + 1}`;

  const score = scoreForModel(sample.rating, filterName, model);
  const value = document.createElement("span");
  value.className = "judgement-repeat-rating";
  value.textContent = score === null ? "–" : formatMean(score);
  if (state.zMode && score !== null) {
    value.title = `raw rating ${sample.rating}`;
  }

  head.append(label, value);
  repeat.append(head);

  if (sample.explanation) {
    const explanation = document.createElement("div");
    explanation.className = "judgement-explanation";
    explanation.textContent = sample.explanation;
    repeat.append(explanation);
  }
  if (sample.quote) {
    const quote = document.createElement("blockquote");
    quote.className = "judgement-quote";
    quote.textContent = sample.quote;
    repeat.append(quote);
  }
  if (!sample.explanation && !sample.quote) {
    const note = document.createElement("div");
    note.className = "judgement-repeat-empty";
    note.textContent = "Rating only — this repeat carries no explanation or quote.";
    repeat.append(note);
  }

  return repeat;
}

// A judge's verdict on one document: the mean over its repeats, expandable to
// the repeats themselves. `expandKey` scopes the open/closed state to one
// document; pass null on surfaces where expansion should not be offered.
function buildJudgementCard(model, entry, filterName = state.filterName, expandKey = null) {
  const card = document.createElement("div");
  card.className = "judgement";

  const samples = entry.samples ?? [{
    rating: entry.rating,
    explanation: entry.explanation,
    quote: entry.quote,
  }];
  const key = expandKey === null ? null : `${expandKey}::${filterName}::${model}`;
  const canExpand = key !== null && samples.length > 1;
  const expanded = canExpand && state.expandedJudges.has(key);

  // A button only when there is something to open, so a single-repeat card
  // stays inert rather than looking clickable and doing nothing.
  const header = document.createElement(canExpand ? "button" : "div");
  header.className = "judgement-header";
  if (canExpand) {
    header.type = "button";
    header.classList.add("is-expandable");
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
    header.title = `Show the ${samples.length} individual ratings from ${model}`;
  }

  const name = document.createElement("span");
  name.className = "judgement-model";
  name.textContent = model;

  // In z mode the meter spans -2..+4 standard deviations, which covers the
  // bulk of every filter without letting one extreme document flatten the rest.
  const score = scoreForModel(entry.rating, filterName, model);
  const fraction =
    score === null ? 0 : state.zMode ? (score + 2) / 6 : score / 10;

  const meter = document.createElement("div");
  meter.className = "judgement-meter";
  const fill = document.createElement("div");
  fill.className = "judgement-meter-fill";
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  meter.append(fill);

  const rating = document.createElement("span");
  rating.className = "judgement-rating";
  rating.textContent = score === null ? "–" : formatMean(score);
  const rawNote =
    samples.length > 1
      ? `mean of ${samples.length} repeats: ${samples.map((s) => s.rating).join(", ")}`
      : `raw rating ${entry.rating}`;
  if (state.zMode || samples.length > 1) {
    rating.title = rawNote;
  }

  header.append(name, meter, rating);

  if (samples.length > 1) {
    const count = document.createElement("span");
    count.className = "judgement-repeat-count";
    count.textContent = `n=${samples.length}`;
    header.append(count);
  }
  const caret = document.createElement("span");
  if (canExpand) {
    caret.className = "judgement-caret";
    caret.textContent = expanded ? "▾" : "▸";
    header.append(caret);
  }

  card.append(header);

  // The collapsed prose and the expanded repeats are both built up front and
  // swapped by the hidden flag, so toggling one judge never re-renders the page
  // underneath it: the data page keeps its scroll position and the labels page
  // keeps every other <details> open.
  const collapsed = document.createElement("div");
  collapsed.className = "judgement-collapsed";
  if (entry.explanation) {
    const explanation = document.createElement("div");
    explanation.className = "judgement-explanation";
    explanation.textContent = entry.explanation;
    collapsed.append(explanation);
  }
  if (entry.quote) {
    const quote = document.createElement("blockquote");
    quote.className = "judgement-quote";
    quote.textContent = entry.quote;
    collapsed.append(quote);
  }
  collapsed.hidden = expanded;
  if (collapsed.childElementCount > 0) card.append(collapsed);

  if (canExpand) {
    const repeats = document.createElement("div");
    repeats.className = "judgement-repeats";
    samples.forEach((sample, index) => {
      repeats.append(buildRepeatCard(index, sample, filterName, model));
    });
    repeats.hidden = !expanded;
    card.append(repeats);

    header.addEventListener("click", () => {
      const open = !state.expandedJudges.has(key);
      if (open) state.expandedJudges.add(key);
      else state.expandedJudges.delete(key);
      repeats.hidden = !open;
      collapsed.hidden = open;
      caret.textContent = open ? "▾" : "▸";
      header.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  if (state.disabledModels.has(model)) {
    card.classList.add("is-disabled");
  }

  return card;
}

function renderJudgements(doc) {
  const entries = getEntries(doc);
  if (!entries || Object.keys(entries).length === 0) {
    els.judgementList.hidden = true;
    els.judgementList.replaceChildren();
    return;
  }

  els.judgementList.hidden = false;
  els.judgementList.replaceChildren(
    ...Object.entries(entries).map(([model, entry]) =>
      buildJudgementCard(model, entry, state.filterName, `doc:${doc.originalIndex}`),
    ),
  );
}

function renderDocument() {
  const total = state.visible.length;
  const doc = state.visible[state.selectedIndex];

  els.prevButton.disabled = total === 0 || state.selectedIndex === 0;
  els.nextButton.disabled = total === 0 || state.selectedIndex >= total - 1;
  els.positionText.value = total === 0 ? "0 / 0" : `${state.selectedIndex + 1} / ${total}`;

  if (!doc) {
    els.documentTitle.textContent = "No document selected";
    els.documentSubhead.textContent = "";
    els.meanBadge.textContent = "–";
    els.documentText.textContent = "";
    els.judgementList.hidden = true;
    els.judgementList.replaceChildren();
    return;
  }

  const entries = getEntries(doc) ?? {};
  const models = Object.keys(entries);
  const enabledCount = models.filter((m) => !state.disabledModels.has(m)).length;
  const modelsLabel = enabledCount === models.length
    ? `${models.length} model${models.length === 1 ? "" : "s"}`
    : `${enabledCount} of ${models.length} models checked`;
  els.documentTitle.textContent = `Document #${doc.originalIndex}`;
  els.documentSubhead.textContent =
    `${formatNumber(doc.text.length)} characters · ${modelsLabel} · ${state.filterName}`;
  els.meanBadge.textContent = formatMean(getMean(doc));
  els.documentText.textContent = doc.text;
  renderJudgements(doc);
}

function renderStatus() {
  const ratedCount = state.documents.filter((doc) => getMean(doc) !== null).length;
  els.statusText.textContent =
    `${formatNumber(state.visible.length)} visible of ${formatNumber(ratedCount)} ` +
    `documents rated on ${state.filterName || "—"}`;
}

function render() {
  state.missingStatModels.clear();
  state.binning = computeBinning();
  applyFilters();
  renderStatus();
  renderHistogram();
  renderList();
  renderDocument();
  renderZNotes();
}

/* ---------- Classifier prompt modal ---------- */

async function loadPromptPaths() {
  try {
    const response = await fetch(`${CONFIG_URL}?t=${Date.now()}`);
    if (!response.ok) return;
    const config = await response.json();
    for (const filter of config.filters ?? []) {
      if (typeof filter?.name === "string" && typeof filter?.prompt_path === "string") {
        state.promptPaths[filter.name] = filter.prompt_path;
      }
    }
  } catch {
    // Non-fatal: the button will report that no prompt is available.
  }
}

async function fetchPromptText(filterName) {
  if (filterName in state.promptCache) {
    return state.promptCache[filterName];
  }

  const path = state.promptPaths[filterName];
  let text = `No prompt file is known for the filter "${filterName}".`;
  if (path) {
    try {
      const response = await fetch(`../../${path}?t=${Date.now()}`);
      text = response.ok
        ? await response.text()
        : `Could not load ${path} (HTTP ${response.status}).`;
    } catch (error) {
      text = `Could not load ${path}: ${error.message}`;
    }
  }
  state.promptCache[filterName] = text;
  return text;
}

async function openPromptModal() {
  els.promptModalTitle.textContent = `Classifier prompt — ${state.filterName}`;
  els.promptModalText.textContent = "Loading prompt…";
  els.promptModal.hidden = false;
  els.promptModalText.textContent = await fetchPromptText(state.filterName);
}

function closePromptModal() {
  els.promptModal.hidden = true;
}

/* ---------- Hand-annotation comparison page ---------- */

// Hand labels are binary (0 = negative, 1 = positive); map them to the 0/10
// poles of the model scale. Values above 1 are taken as already on the 0-10
// scale, in case labeling ever switches to it.
function humanTarget(label) {
  return label <= 1 ? label * 10 : label;
}

// One row of the hand rated JSONL: the document, its human labels, and the
// judge ratings the hand rater wrote onto the same row. Rows of the plain
// annotation file parse the same way and simply carry no ratings.
function parseHandRow(row) {
  if (typeof row?.text !== "string" || row.text.length === 0) return null;

  // Only the raw hand labels are stored here; means and diffs are computed
  // at render time (filterAnnotationItems) so they track the model checkboxes.
  const labels = [];
  for (const { key, filter, short } of HUMAN_LABEL_FILTERS) {
    const human = row[key];
    if (!Number.isInteger(human) || human < 0) continue; // -1 = not yet labeled
    labels.push({ filter, short, human });
  }
  return { text: row.text, labels, ratings: extractRatings(row) };
}

// Returns {rows, badLines}, or null when the file is not there at all.
async function fetchHandRows(url) {
  let response;
  try {
    response = await fetch(`${url}?t=${Date.now()}`);
  } catch (error) {
    throw new Error(`Could not load ${url}: ${error.message}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  }

  const rows = [];
  let badLines = 0;
  for (const line of (await response.text()).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    const parsed = parseHandRow(row);
    if (parsed) rows.push(parsed);
  }
  return { rows, badLines };
}

// The hand page reads its own rated file, so it needs neither the corpus rated
// JSONL nor any text matching against it.
async function loadAnnotations() {
  if (state.annotations) return state.annotations;

  let source = HAND_RATED_URL;
  let loaded = await fetchHandRows(HAND_RATED_URL);
  if (loaded === null || loaded.rows.length === 0) {
    source = ANNOTATIONS_URL;
    loaded = await fetchHandRows(ANNOTATIONS_URL);
    if (loaded === null) {
      throw new Error(
        `Could not load ${HAND_RATED_URL} or ${ANNOTATIONS_URL} (HTTP 404).`,
      );
    }
  }

  const items = loaded.rows.map((row, index) => ({
    annotationIndex: index,
    text: row.text,
    // A row with no judge ratings yet gets no doc, which renders the
    // "model reviews are unavailable" note instead of empty sections.
    doc: Object.keys(row.ratings).length > 0
      ? { text: row.text, ratings: row.ratings }
      : null,
    labels: row.labels,
  }));

  await mergeEmbeddingOverlays(items);

  state.annotations = { items, badLines: loaded.badLines, source };
  return state.annotations;
}

// Separately generated embedding-model ratings are merged onto the hand rows so
// the distilled model can be compared against the judges and your labels.
async function mergeEmbeddingOverlays(items) {
  const documents = items.filter((item) => item.doc).map((item) => item.doc);
  if (documents.length === 0) return;

  for (const overlayUrl of RATING_OVERLAY_URLS) {
    try {
      const response = await fetch(`${overlayUrl}?t=${Date.now()}`);
      if (!response.ok) {
        if (response.status !== 404) {
          console.warn(`Could not load rating overlay ${overlayUrl}: HTTP ${response.status}`);
        }
        continue;
      }
      const result = mergeRatingOverlay(documents, parseJsonl(await response.text()));
      if (result.collisions > 0) {
        console.warn(
          `Skipped ${result.collisions} overlay rating collision(s) from ${overlayUrl}; existing ratings were preserved.`,
        );
      }
      console.info(
        `Merged ${result.addedRatings} hand ratings from ${result.matchedRows} rows in ${overlayUrl}.`,
      );
    } catch (error) {
      console.warn(`Could not load rating overlay ${overlayUrl}: ${error.message}`);
    }
  }
}

function buildAnnotationItem(item) {
  const details = document.createElement("details");
  details.className = "annotation-item";

  const summary = document.createElement("summary");
  summary.className = "annotation-summary";

  const score = document.createElement("span");
  score.className = "ann-score";
  score.textContent =
    item.score === null
      ? "n/a"
      : item.sortMode === "models"
        ? item.score.toFixed(2)
        : item.score.toFixed(1);
  if (item.sortMode === "hand" && item.score !== null && item.score >= 5) {
    score.classList.add("is-high");
  }
  score.title =
    item.sortMode === "models"
      ? `Model rating variance across ${item.modelCount} checked model${item.modelCount === 1 ? "" : "s"}`
      : "|mean model rating − hand label| for the selected filter";

  const chips = document.createElement("span");
  chips.className = "ann-chips";
  for (const c of item.categories) {
    const chip = document.createElement("span");
    chip.className = "ann-chip";
    chip.textContent = `hand ${c.human} → model ${c.mean === null ? "?" : formatMean(c.mean)}`;
    chip.title = `${c.filter}: hand label ${c.human}, model mean ${c.mean === null ? "unknown" : formatMean(c.mean)}`;
    chips.append(chip);
  }

  const snippet = document.createElement("span");
  snippet.className = "ann-snippet";
  snippet.textContent = summarize(item.text);

  summary.append(score, chips, snippet);
  details.append(summary);

  const body = document.createElement("div");
  body.className = "ann-body";

  if (item.categories.length === 0) {
    const note = document.createElement("div");
    note.className = "ann-note";
    note.textContent = `Not yet hand-labeled for ${state.labelsFilter}.`;
    body.append(note);
  }
  if (!item.doc) {
    const note = document.createElement("div");
    note.className = "ann-note";
    note.textContent =
      "No matching document found in the rated JSONL, so model reviews are unavailable.";
    body.append(note);
  }

  for (const c of item.categories) {
    const section = document.createElement("div");
    section.className = "ann-section";

    const head = document.createElement("div");
    head.className = "ann-section-head";
    head.textContent =
      `${c.filter} · hand label ${c.human}` +
      (c.mean === null
        ? ""
        : ` · model mean ${formatMean(c.mean)} · Δ ${c.diff.toFixed(1)}`);
    section.append(head);

    const entries = item.doc?.ratings[c.filter];
    if (entries) {
      for (const [model, entry] of Object.entries(entries)) {
        // c.filter, not state.filterName: this page renders one section per
        // filter, so the card has to standardize against the section's own
        // moments rather than whichever filter the data page happens to show.
        section.append(
          buildJudgementCard(model, entry, c.filter, `label:${item.annotationIndex}`),
        );
      }
    }
    body.append(section);
  }

  const pre = document.createElement("pre");
  pre.className = "ann-doc-text";
  pre.textContent = item.text;
  body.append(pre);

  details.append(body);
  return details;
}

function populateLabelsFilterControls() {
  els.labelsFilterSelect.replaceChildren(
    ...HUMAN_LABEL_FILTERS.map(({ filter }) => {
      const option = document.createElement("option");
      option.value = filter;
      option.textContent = filter;
      return option;
    }),
  );
  els.labelsFilterSelect.value = state.labelsFilter;
}

// Population variance across the checked model scores for one document, on the
// active scale. With one score the variance is 0; with none it is unavailable.
function getModelVarianceForFilter(doc, filterName) {
  const scores = scoresForFilter(doc?.ratings[filterName], filterName);
  if (scores.length === 0) return { value: null, n: 0 };
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const value =
    scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length;
  return { value, n: scores.length };
}

function compareNullableScoresDescending(a, b) {
  if (a.score === null && b.score === null) {
    return a.annotationIndex - b.annotationIndex;
  }
  if (a.score === null) return 1;
  if (b.score === null) return -1;
  return b.score - a.score || a.annotationIndex - b.annotationIndex;
}

// Restrict each sample to the selected filter, recompute metrics from the
// checked models, and sort by either hand-label error or inter-model variance.
function filterAnnotationItems(items, filterName) {
  return items
    .map((item) => {
      const label = item.labels.find((l) => l.filter === filterName) ?? null;
      const mean = item.doc ? getMeanForFilter(item.doc, filterName) : null;
      // Error against the hand label is always measured on the raw 0-10 scale:
      // the labels are 0/10 anchors with no z-value of their own, so comparing
      // them to a z-value would be a units mismatch, not a disagreement.
      const rawMean = item.doc ? rawMeanForFilter(item.doc, filterName) : null;
      const { value: modelVariance, n: modelCount } = getModelVarianceForFilter(
        item.doc,
        filterName,
      );
      const categories = label
        ? [{
            ...label,
            mean,
            diff:
              rawMean === null ? null : Math.abs(rawMean - humanTarget(label.human)),
          }]
        : [];
      const handDiff = categories[0]?.diff ?? null;
      return {
        ...item,
        categories,
        handDiff,
        modelVariance,
        modelCount,
        sortMode: state.labelsSort,
        score: state.labelsSort === "models" ? modelVariance : handDiff,
      };
    })
    .toSorted(compareNullableScoresDescending);
}

/* ---------- Pairwise model correlations (labels page sidebar) ---------- */

function collectCheckedModels(items, filterName) {
  const models = new Set();
  for (const item of items) {
    for (const model of Object.keys(item.doc?.ratings[filterName] ?? {})) {
      if (!state.disabledModels.has(model)) models.add(model);
    }
  }
  return [...models].sort((a, b) => a.localeCompare(b));
}

// Pearson correlation using pairwise-complete observations. Correlation is
// undefined with fewer than two pairs or when either series has zero variance.
function computeModelCorrelation(items, filterName, modelA, modelB) {
  const pairs = [];
  for (const item of items) {
    const entries = item.doc?.ratings[filterName];
    const ratingA = entries?.[modelA]?.rating;
    const ratingB = entries?.[modelB]?.rating;
    if (Number.isFinite(ratingA) && Number.isFinite(ratingB)) {
      pairs.push([ratingA, ratingB]);
    }
  }
  const n = pairs.length;
  if (n < 2) return { value: null, n };

  const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / n;
  const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / n;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const [ratingA, ratingB] of pairs) {
    const deltaA = ratingA - meanA;
    const deltaB = ratingB - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA ** 2;
    varianceB += deltaB ** 2;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  const value = denominator === 0 ? null : covariance / denominator;
  return {
    value: value === null ? null : Math.max(-1, Math.min(1, value)),
    n,
  };
}

// Standardize every defined entry in the complete square. This intentionally
// includes both symmetric halves and the diagonal, matching the displayed
// matrix. Undefined correlations are omitted from the normalization moments.
function normalizeCorrelationMatrix(matrix) {
  const values = matrix
    .flat()
    .map((entry) => entry.value)
    .filter(Number.isFinite);
  if (values.length === 0) {
    return { matrix, mean: null, std: null };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;
  const std = Math.sqrt(variance);
  return {
    mean,
    std,
    matrix: matrix.map((row) =>
      row.map((entry) => ({
        ...entry,
        normalized:
          entry.value === null || std === 0
            ? null
            : (entry.value - mean) / std,
      })),
    ),
  };
}

function renderCorrelationMatrix(items) {
  const models = collectCheckedModels(items, state.labelsFilter);

  if (models.length === 0) {
    els.correlationCaption.textContent = "0 checked models";
    const empty = document.createElement("div");
    empty.className = "ann-note";
    empty.textContent = "Check at least one model to show correlations.";
    els.correlationMatrix.replaceChildren(empty);
    return;
  }

  const rawMatrix = models.map((modelA) =>
    models.map((modelB) =>
      computeModelCorrelation(
        items,
        state.labelsFilter,
        modelA,
        modelB,
      ),
    ),
  );
  const { matrix, mean, std } = normalizeCorrelationMatrix(rawMatrix);
  const momentSummary =
    mean === null
      ? ""
      : ` · μ ${mean.toFixed(2)} · σ ${std.toFixed(2)}`;
  els.correlationCaption.textContent =
    `${models.length} checked model${models.length === 1 ? "" : "s"}${momentSummary}`;

  const table = document.createElement("table");
  table.className = "correlation-table";
  table.setAttribute(
    "aria-label",
    "Whole-matrix standardized pairwise Pearson correlations between checked models",
  );

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.scope = "col";
  corner.textContent = "";
  headRow.append(corner);
  models.forEach((model, index) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = String(index + 1);
    th.title = model;
    th.setAttribute("aria-label", `${index + 1}: ${model}`);
    headRow.append(th);
  });
  head.append(headRow);

  const body = document.createElement("tbody");
  models.forEach((modelA, rowIndex) => {
    const row = document.createElement("tr");
    const rowHead = document.createElement("th");
    rowHead.scope = "row";
    rowHead.textContent = String(rowIndex + 1);
    rowHead.title = modelA;
    rowHead.setAttribute("aria-label", `${rowIndex + 1}: ${modelA}`);
    row.append(rowHead);

    models.forEach((modelB, columnIndex) => {
      const { value: rawValue, normalized, n } = matrix[rowIndex][columnIndex];
      const cell = document.createElement("td");
      cell.textContent = normalized === null ? "–" : normalized.toFixed(2);
      cell.title =
        `${modelA} × ${modelB}: ` +
        (normalized === null
          ? `standardized value undefined; r=${rawValue?.toFixed(3) ?? "undefined"} (n=${n})`
          : `z=${normalized.toFixed(3)}; r=${rawValue.toFixed(3)} (n=${n})`);
      cell.setAttribute("aria-label", cell.title);
      if (normalized !== null) {
        const colorValue = Math.max(-1, Math.min(1, normalized));
        cell.classList.add(colorValue < 0 ? "is-negative" : "is-positive");
        if (Math.abs(colorValue) >= 0.7) cell.classList.add("is-extreme");
        cell.style.setProperty(
          "--correlation-strength",
          `${Math.abs(colorValue) * 100}%`,
        );
      }
      row.append(cell);
    });
    body.append(row);
  });
  table.append(head, body);

  const legend = document.createElement("ol");
  legend.className = "correlation-legend";
  models.forEach((model) => {
    const item = document.createElement("li");
    item.textContent = model;
    legend.append(item);
  });

  const tableWrap = document.createElement("div");
  tableWrap.className = "correlation-table-wrap";
  tableWrap.tabIndex = 0;
  tableWrap.setAttribute("aria-label", "Scrollable normalized model-correlation matrix");
  tableWrap.append(table);
  els.correlationMatrix.replaceChildren(tableWrap, legend);
}

/* ---------- Per-model agreement stats (labels page sidebar) ---------- */

// For one filter, score each model over the hand-annotated documents:
//   maeHuman  - mean absolute error vs the hand labels mapped to 0/10,
//               over samples that are labeled for this filter. Always on the
//               raw scale: the hand labels are 0/10 anchors with no z-value of
//               their own, so standardizing only one side would be meaningless.
//   maeOthers - mean absolute error vs the mean of the other CHECKED models'
//               scores on the same document, over all matched samples. This is
//               model against model, so it follows the active scale.
function computeModelStats(items, filterName) {
  const perModel = new Map(); // model -> {human: number[], others: number[]}

  for (const item of items) {
    const entries = item.doc?.ratings[filterName];
    if (!entries) continue;
    const models = Object.keys(entries);
    const labeled = item.categories.find((c) => c.filter === filterName);
    const target = labeled ? humanTarget(labeled.human) : null;

    for (const model of models) {
      const stats = perModel.get(model) ?? { human: [], others: [] };
      const rating = entries[model].rating;
      if (target !== null) {
        stats.human.push(Math.abs(rating - target));
      }
      const score = scoreForModel(rating, filterName, model);
      const others = models
        .filter((m) => m !== model && !state.disabledModels.has(m))
        .map((m) => scoreForModel(entries[m].rating, filterName, m))
        .filter((value) => value !== null);
      if (score !== null && others.length > 0) {
        const otherMean =
          others.reduce((sum, value) => sum + value, 0) / others.length;
        stats.others.push(Math.abs(score - otherMean));
      }
      perModel.set(model, stats);
    }
  }

  const mae = (values) =>
    values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length;

  return [...perModel.entries()]
    .map(([model, stats]) => ({
      model,
      maeHuman: mae(stats.human),
      nHuman: stats.human.length,
      maeOthers: mae(stats.others),
      nOthers: stats.others.length,
    }))
    .sort(
      (a, b) =>
        (a.maeHuman ?? Infinity) - (b.maeHuman ?? Infinity) ||
        a.model.localeCompare(b.model),
    );
}

// `full` is the MAE that fills the meter completely: 10 points on the raw
// scale, or 4 standard deviations on the z scale.
function buildModelStatRow(label, maeValue, n, full = 10) {
  const row = document.createElement("div");
  row.className = "model-stat-row";

  const rowLabel = document.createElement("span");
  rowLabel.className = "model-stat-label";
  rowLabel.textContent = label;

  const meter = document.createElement("div");
  meter.className = "model-stat-meter";
  const fill = document.createElement("div");
  fill.className = "model-stat-meter-fill";
  fill.style.width =
    maeValue === null ? "0%" : `${Math.min(100, (maeValue / full) * 100)}%`;
  meter.append(fill);

  const value = document.createElement("span");
  value.className = "model-stat-value";
  value.textContent =
    maeValue === null ? "–" : maeValue.toFixed(full === 10 ? 1 : 2);

  const count = document.createElement("span");
  count.className = "model-stat-n";
  count.textContent = `n=${n}`;

  row.append(rowLabel, meter, value, count);
  return row;
}

function renderModelStats(items) {
  els.modelStatsCaption.textContent = state.zMode
    ? `${state.labelsFilter} · z`
    : state.labelsFilter;
  if (els.modelStatsScaleNote) {
    els.modelStatsScaleNote.textContent = state.zMode
      ? " Z-values are on, so “vs models” is in standard deviations; “vs you” " +
        "stays on the raw 0-10 scale because the hand labels are 0/10 anchors."
      : "";
  }
  const stats = computeModelStats(items, state.labelsFilter);

  if (stats.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ann-note";
    empty.textContent =
      "No model ratings for this filter yet. Run scripts/filter/rate_hand_labels.py " +
      "to rate the hand-annotated samples, then reload.";
    els.modelStatsList.replaceChildren(empty);
    return;
  }

  els.modelStatsList.replaceChildren(
    ...stats.map((s) => {
      const card = document.createElement("div");
      card.className = "model-stat";
      const enabled = !state.disabledModels.has(s.model);
      if (!enabled) card.classList.add("is-disabled");

      const name = document.createElement("label");
      name.className = "model-stat-name";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "model-stat-toggle";
      toggle.checked = enabled;
      toggle.title = "Include this model's ratings in the computed numbers";
      toggle.addEventListener("change", () => setModelEnabled(s.model, toggle.checked));

      const nameText = document.createElement("span");
      nameText.textContent = s.model;
      name.append(toggle, nameText);

      card.append(
        name,
        buildModelStatRow("vs you", s.maeHuman, s.nHuman),
        buildModelStatRow(
          state.zMode ? "vs models (z)" : "vs models",
          s.maeOthers,
          s.nOthers,
          state.zMode ? 4 : 10,
        ),
      );
      return card;
    }),
  );
}

// Unchecking a model drops its ratings from every computed number (means,
// diffs, MAE baselines, accuracies) on both pages; its own rows stay visible,
// dimmed, so it can be re-checked.
function setModelEnabled(model, enabled) {
  if (enabled) state.disabledModels.delete(model);
  else state.disabledModels.add(model);
  render();
  renderLabelsPage();
}

/* ---------- Rating distributions (labels page pop-up) ---------- */

const DISTRIBUTION_WINDOW_NAME = "distributionStatistics";

// One integer-binned histogram (0-10) per model over the hand-annotated
// samples of a single filter, plus that model's summary moments. Unchecked
// models are kept but flagged: a per-model distribution is that model's own
// raw output, not a cross-model aggregate, so nothing here is contaminated by
// including it.
//
// Always raw, whatever the z-values knob says. Standardizing is affine and
// per-model, so it would relabel these axes without moving a single bar.
function computeRatingDistributions(items, filterName) {
  const perModel = new Map(); // model -> {counts: number[11], ratings: number[]}

  for (const item of items) {
    const entries = item.doc?.ratings[filterName];
    if (!entries) continue;
    for (const [model, entry] of Object.entries(entries)) {
      const stats = perModel.get(model) ??
        { counts: Array.from({ length: 11 }, () => 0), ratings: [] };
      stats.counts[Math.max(0, Math.min(10, Math.round(entry.rating)))] += 1;
      stats.ratings.push(entry.rating);
      perModel.set(model, stats);
    }
  }

  return [...perModel.entries()]
    .map(([model, { counts, ratings }]) => {
      const n = ratings.length;
      const mean = ratings.reduce((sum, rating) => sum + rating, 0) / n;
      const sorted = ratings.toSorted((a, b) => a - b);
      const middle = Math.floor(n / 2);
      return {
        model,
        counts,
        n,
        mean,
        median: n % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
        sd: Math.sqrt(
          ratings.reduce((sum, rating) => sum + (rating - mean) ** 2, 0) / n,
        ),
        enabled: !state.disabledModels.has(model),
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

// Bars are scaled against maxCount, the tallest bin across ALL models, so the
// histograms can be read against each other rather than each self-normalizing.
function buildDistributionBarsHtml(counts, maxCount, total) {
  return counts
    .map((count, bin) => {
      const heightPct = count > 0 ? Math.max(3, (count / maxCount) * 88) : 0;
      const share = total === 0 ? 0 : (count / total) * 100;
      const title =
        `rating ${bin}: ${formatNumber(count)} ` +
        `document${count === 1 ? "" : "s"} (${share.toFixed(1)}%)`;
      const countLabel = count > 0
        ? `<div class="bin-count" style="bottom: calc(${heightPct.toFixed(2)}% + 4px)">${formatNumber(count)}</div>`
        : "";
      return `<div class="bin" title="${escapeHtml(title)}">
            <div class="bin-track">${countLabel}<div class="bin-fill" style="height: ${heightPct.toFixed(2)}%"></div></div>
            <div class="bin-x">${bin}</div>
          </div>`;
    })
    .join("");
}

function buildDistributionCardHtml(distribution, maxCount) {
  const summary =
    `n=${formatNumber(distribution.n)} · mean ${distribution.mean.toFixed(2)}` +
    ` · median ${formatMean(distribution.median)} · sd ${distribution.sd.toFixed(2)}` +
    (distribution.enabled ? "" : " · unchecked");
  return `<section class="chart-card dist-card${distribution.enabled ? "" : " is-disabled"}">
        <div class="chart-head">
          <h2>${escapeHtml(distribution.model)}</h2>
          <span class="chart-summary">${escapeHtml(summary)}</span>
        </div>
        <div class="histogram" role="img" aria-label="${escapeHtml(`Rating histogram for ${distribution.model}: ` + distribution.counts.map((count, bin) => `${bin}: ${count}`).join(", "))}">
          ${buildDistributionBarsHtml(distribution.counts, maxCount, distribution.n)}
        </div>
        <div class="dist-axis">rating</div>
      </section>`;
}

function buildDistributionTableHtml(distributions) {
  const bins = Array.from({ length: 11 }, (_, bin) => bin);
  const headCells = bins
    .map((bin) => `<th scope="col">${bin}</th>`)
    .join("");
  const rows = distributions
    .map(
      (distribution) => `<tr>
              <th scope="row">${escapeHtml(distribution.model)}${distribution.enabled ? "" : " <span class=\"dist-note\">(unchecked)</span>"}</th>
              ${distribution.counts.map((count) => `<td>${formatNumber(count)}</td>`).join("")}
              <td class="dist-sep">${formatNumber(distribution.n)}</td>
              <td>${distribution.mean.toFixed(2)}</td>
              <td>${formatMean(distribution.median)}</td>
              <td>${distribution.sd.toFixed(2)}</td>
            </tr>`,
    )
    .join("");

  return `<div class="dist-table-wrap">
          <table class="dist-table">
            <thead>
              <tr>
                <th scope="col">model</th>
                ${headCells}
                <th scope="col" class="dist-sep">n</th>
                <th scope="col">mean</th>
                <th scope="col">median</th>
                <th scope="col">sd</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
}

function buildDistributionDocumentHtml(filterName, distributions, sampleCount) {
  // Reuse the app's own stylesheet (same origin, same ?v= cache bust) so the
  // pop-up shares .chart-card / .histogram / .bin with the data page.
  const stylesHref =
    document.querySelector('link[rel="stylesheet"]')?.href ??
    new URL("./styles.css", location.href).href;
  const title = `Rating distributions — ${filterName}`;
  const maxCount = Math.max(
    1,
    ...distributions.flatMap((distribution) => distribution.counts),
  );

  const body = distributions.length === 0
    ? `<p class="dist-note">No model ratings for ${escapeHtml(filterName)} in the hand-annotated samples.</p>`
    : `<div class="dist-charts">
          ${distributions.map((distribution) => buildDistributionCardHtml(distribution, maxCount)).join("\n")}
        </div>
        <section class="dist-table-card">
          <h2>Documents per rating</h2>
          ${buildDistributionTableHtml(distributions)}
        </section>`;

  const modelsLabel = `${distributions.length} model${distributions.length === 1 ? "" : "s"}`;
  const uncheckedCount = distributions.filter((d) => !d.enabled).length;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${escapeHtml(stylesHref)}" />
  </head>
  <body>
    <main class="dist-page">
      <div class="dist-head">
        <h1>${escapeHtml(title)}</h1>
        <p class="dist-subhead">
          ${formatNumber(sampleCount)} hand-annotated sample${sampleCount === 1 ? "" : "s"} ·
          ${modelsLabel}${uncheckedCount > 0 ? ` (${uncheckedCount} unchecked)` : ""} ·
          shared y-axis, tallest bin ${formatNumber(maxCount)}
        </p>
      </div>
      ${body}
      <p class="dist-note">
        Each bar counts the hand-annotated documents that model gave that rating
        for this filter; ratings are binned to whole numbers. Unchecking a model
        on the hand-label page does not remove it here — its own distribution is
        unaffected by the other models — but it is greyed out and marked. This
        window is a snapshot: change the filter or the checkboxes and click
        &ldquo;distribution statistics&rdquo; again to refresh it.
      </p>
    </main>
  </body>
</html>`;
}

function writeDistributionWindow(win, html) {
  win.document.open();
  win.document.write(html);
  win.document.close();
}

async function openDistributionWindow() {
  // Opened synchronously from the click so pop-up blockers allow it.
  const win = window.open("", DISTRIBUTION_WINDOW_NAME, "width=1140,height=920");
  if (!win) {
    els.labelsStatusText.textContent =
      "Could not open the distribution window — allow pop-ups for this page, then click again.";
    return;
  }
  writeDistributionWindow(
    win,
    '<!doctype html><meta charset="utf-8"><title>Rating distributions</title><p>Loading hand-annotated samples…</p>',
  );
  win.focus();

  const filterName = state.labelsFilter;
  let annotations = state.annotations;
  if (!annotations) {
    try {
      annotations = await loadAnnotations();
    } catch {
      annotations = null;
    }
  }
  if (win.closed) return;

  const items = annotations
    ? filterAnnotationItems(annotations.items, filterName)
    : [];
  writeDistributionWindow(
    win,
    buildDistributionDocumentHtml(
      filterName,
      computeRatingDistributions(items, filterName),
      items.length,
    ),
  );
  win.focus();
}

/* ---------- Classification threshold & accuracy (labels page sidebar) ---------- */

// Classify every labeled sample by either the mean or maximum checked-model
// rating (score >= threshold -> 1, else 0), then tally accuracy overall and
// separately for hand-label-1 and hand-label-0 samples.
function computeAccuracy(items, filterName, threshold, aggregation) {
  const tally = {
    overallTotal: 0,
    overallCorrect: 0,
    posTotal: 0,
    posCorrect: 0,
    negTotal: 0,
    negCorrect: 0,
  };

  for (const item of items) {
    if (!item.doc) continue;
    const labeled = item.categories.find((c) => c.filter === filterName);
    if (!labeled) continue;
    const score = getAccuracyScoreForFilter(item.doc, filterName, aggregation);
    if (score === null) continue;

    const predicted = score >= threshold ? 1 : 0;
    const expected = labeled.human >= 1 ? 1 : 0;
    tally.overallTotal += 1;
    if (predicted === expected) tally.overallCorrect += 1;

    if (expected === 1) {
      tally.posTotal += 1;
      if (predicted === 1) tally.posCorrect += 1;
    } else {
      tally.negTotal += 1;
      if (predicted === 0) tally.negCorrect += 1;
    }
  }

  return tally;
}

function renderOverallAccuracy(tally) {
  const { overallCorrect: correct, overallTotal: total } = tally;
  els.overallValue.textContent =
    total === 0 ? "–" : `${((correct / total) * 100).toFixed(1)}%`;
  els.overallN.textContent = total > 0 ? `${correct}/${total}` : "";
}

function buildAccuracyRow(label, correct, total) {
  const row = document.createElement("div");
  row.className = "accuracy-row";

  const name = document.createElement("span");
  name.className = "accuracy-label";
  name.textContent = label;

  const pct = document.createElement("span");
  pct.className = "accuracy-pct";
  pct.textContent = total === 0 ? "–" : `${((correct / total) * 100).toFixed(1)}%`;

  const count = document.createElement("span");
  count.className = "accuracy-n";
  count.textContent = `${correct}/${total}`;

  row.append(name, pct, count);
  return row;
}

// Slider bounds for the active scale. Raw ratings are always 0-10. Z-value
// aggregates have no fixed range -- a filter whose corpus ratings are nearly all
// zero pushes its positives out to very large z -- so the slider spans the
// observed range of the current filter's samples, padded out to whole units.
function thresholdBounds() {
  if (!state.zMode) return { min: 0, max: 10, step: 0.1, decimals: 1 };

  let low = Infinity;
  let high = -Infinity;
  for (const item of state.labelsItems) {
    if (!item.doc) continue;
    const score = getAccuracyScoreForFilter(
      item.doc,
      state.labelsFilter,
      state.labelsAccuracyAggregation,
    );
    if (score === null) continue;
    if (score < low) low = score;
    if (score > high) high = score;
  }
  if (!Number.isFinite(low)) return { min: -3, max: 3, step: 0.05, decimals: 2 };
  return {
    min: Math.floor(low),
    max: Math.max(Math.ceil(high), Math.floor(low) + 1),
    step: 0.05,
    decimals: 2,
  };
}

function activeThreshold() {
  return state.zMode ? state.labelsThresholdZ : state.labelsThreshold;
}

function renderAccuracy() {
  const bounds = thresholdBounds();
  const threshold = Math.min(bounds.max, Math.max(bounds.min, activeThreshold()));
  if (state.zMode) state.labelsThresholdZ = threshold;
  else state.labelsThreshold = threshold;

  els.thresholdValue.textContent = `x = ${threshold.toFixed(bounds.decimals)}`;
  els.thresholdRange.min = String(bounds.min);
  els.thresholdRange.max = String(bounds.max);
  els.thresholdRange.step = String(bounds.step);
  els.thresholdRange.value = String(threshold);
  els.thresholdRange.setAttribute(
    "aria-label",
    `Classification threshold from ${bounds.min} to ${bounds.max}`,
  );
  els.accuracyAggregationSelect.value = state.labelsAccuracyAggregation;
  renderThresholdNote();

  const tally = computeAccuracy(
    state.labelsItems,
    state.labelsFilter,
    threshold,
    state.labelsAccuracyAggregation,
  );
  renderOverallAccuracy(tally);
  els.accuracyList.replaceChildren(
    buildAccuracyRow("positive accuracy", tally.posCorrect, tally.posTotal),
    buildAccuracyRow("negative accuracy", tally.negCorrect, tally.negTotal),
  );
}

function strongText(text) {
  const element = document.createElement("strong");
  element.textContent = text;
  return element;
}

function renderThresholdNote() {
  if (!els.thresholdNote) return;
  const scored = state.zMode ? "checked-model z-values" : "checked-model ratings";
  els.thresholdNote.replaceChildren(
    document.createTextNode(
      `The selected aggregate of ${scored} ≥ x classifies a sample as 1; ` +
        "below x classifies it as 0. ",
    ),
    strongText("positive accuracy"),
    document.createTextNode(" is the fraction of hand-label-1 samples classified 1. "),
    strongText("negative accuracy"),
    document.createTextNode(" is the fraction of hand-label-0 samples classified 0."),
  );
  if (state.zMode) {
    els.thresholdNote.append(
      document.createTextNode(
        " Each model is standardized against its own full-corpus mean and standard " +
          "deviation before aggregating, so x is in standard deviations and the " +
          "slider spans this filter's observed range.",
      ),
    );
  }
}

// Provenance line for the z-values knob: which corpus the moments came from,
// plus anything z mode had to drop for want of statistics.
function describeRatingStatsSources() {
  const meta = state.ratingStatsMeta;
  if (!meta) return "";
  const parts = [];
  if (meta.judges?.rated_rows) {
    parts.push(`judges over ${formatNumber(meta.judges.rated_rows)} rated documents`);
  }
  if (meta.embedding?.documents) {
    parts.push(
      `embedding heads over ${formatNumber(meta.embedding.documents)} tagged documents`,
    );
  }
  return parts.length > 0 ? ` Reference distribution: ${parts.join("; ")}.` : "";
}

function renderZNotes() {
  let text = "";
  let warning = false;

  if (state.ratingStatsError) {
    text = state.ratingStatsError;
    warning = true;
  } else if (state.zMode) {
    text =
      "z = (rating − corpus mean) / corpus standard deviation, computed per " +
      "filter per model." + describeRatingStatsSources();
    const missing = [...state.missingStatModels];
    if (missing.length > 0) {
      text +=
        ` Excluded from every aggregate for want of corpus statistics: ${missing.join(", ")}.`;
      warning = true;
    }
  }

  for (const element of [els.dataZNote, els.labelsZNote]) {
    if (!element) continue;
    element.textContent = text;
    element.hidden = text === "";
    element.classList.toggle("is-warning", warning);
  }
}

function syncZToggles() {
  const available = isZModeAvailable();
  for (const toggle of [els.dataZToggle, els.labelsZToggle]) {
    if (!toggle) continue;
    toggle.checked = state.zMode;
    toggle.disabled = !available;
  }
}

function setZMode(enabled) {
  if (enabled && !isZModeAvailable()) {
    syncZToggles();
    return;
  }
  state.zMode = enabled;
  // Bin identities differ between the two scales, so a bin selection made on
  // one of them means nothing on the other.
  state.ratingFilter = "all";
  state.selectedIndex = 0;
  state.missingStatModels.clear();
  syncZToggles();
  render();
  renderLabelsPage();
}

async function loadRatingStats() {
  try {
    const response = await fetch(`${RATING_STATS_URL}?t=${Date.now()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload?.stats || typeof payload.stats !== "object") {
      throw new Error("no stats object");
    }
    state.ratingStats = payload.stats;
    state.ratingStatsMeta = payload.sources ?? null;
    state.ratingStatsError = "";
  } catch (error) {
    state.ratingStats = null;
    state.ratingStatsMeta = null;
    state.ratingStatsError =
      `Z-values are unavailable: could not load ${RATING_STATS_URL} ` +
      `(${error.message}). Generate it with ` +
      "scripts/filter/compute_rating_stats.py, then reload.";
  }
  syncZToggles();
  renderZNotes();
}

function renderLabelsSortNote() {
  els.labelsSortNote.innerHTML = "";
  const scale = state.zMode ? "z-value" : "rating";
  if (state.labelsSort === "models") {
    els.labelsSortNote.append(
      `Sorted by model disagreement: population variance of the checked models' ` +
        `${scale}s, avg((model score − mean(model scores))²), for the selected ` +
        "filter. Samples without checked-model ratings sort last. Click a row to expand it.",
    );
    return;
  }
  els.labelsSortNote.append(
    "Sorted by hand-label disagreement: |mean model rating − hand label| for the ",
    "selected filter, with binary hand labels 0/1 mapped to 0/10. This one stays ",
    "on the raw 0-10 scale in both modes, since the hand labels have no z-value ",
    "of their own. Unlabeled or unmatched samples sort last. Click a row to expand it.",
  );
}

function setThreshold(value) {
  const bounds = thresholdBounds();
  const clamped = Math.min(bounds.max, Math.max(bounds.min, value));
  const snapped = Number(clamped.toFixed(bounds.decimals)); // keep clean steps
  if (state.zMode) state.labelsThresholdZ = snapped;
  else state.labelsThreshold = snapped;
  renderAccuracy();
}

function nudgeThreshold(direction) {
  setThreshold(activeThreshold() + direction * thresholdBounds().step);
}

let labelsRenderToken = 0;

async function renderLabelsPage() {
  const token = ++labelsRenderToken;
  if (!state.annotations) {
    els.labelsStatusText.textContent = "Loading hand-annotated samples…";
    els.labelsBody.textContent = "Loading hand-annotated samples…";
    els.correlationMatrix.textContent = "Loading…";
    els.modelStatsList.textContent = "Loading…";
  }
  try {
    const { items, badLines, source } = await loadAnnotations();
    if (token !== labelsRenderToken) return; // superseded by a newer render
    state.missingStatModels.clear();
    const shown = filterAnnotationItems(items, state.labelsFilter);
    state.labelsItems = shown;
    renderCorrelationMatrix(shown);
    renderModelStats(shown);
    renderAccuracy();
    renderLabelsSortNote();
    renderZNotes();
    const sortLabel =
      state.labelsSort === "models" ? "model variance" : "hand-label error";
    els.labelsStatusText.textContent =
      `${shown.length} samples · ${state.labelsFilter} · sorted by ${sortLabel}`;
    els.labelsBody.replaceChildren(...shown.map(buildAnnotationItem));
    if (badLines > 0) {
      const note = document.createElement("div");
      note.className = "ann-note";
      note.textContent = `${badLines} line${badLines === 1 ? "" : "s"} in ${source} could not be parsed and ${badLines === 1 ? "was" : "were"} skipped.`;
      els.labelsBody.prepend(note);
    }
  } catch (error) {
    if (token !== labelsRenderToken) return;
    els.labelsStatusText.textContent = "Could not load hand labels";
    els.correlationCaption.textContent = "";
    els.correlationMatrix.replaceChildren();
    els.modelStatsList.replaceChildren();
    els.overallValue.textContent = "–";
    els.overallN.textContent = "";
    els.accuracyList.replaceChildren();
    els.labelsBody.textContent =
      `${error.message}\n\nGenerate ${HAND_RATED_URL} with ` +
      "scripts/filter/rate_hand_labels.py (or make sure " +
      `${ANNOTATIONS_URL} exists), and serve the repository root.`;
  }
}

/* ---------- Views ---------- */

function currentView() {
  if (location.hash.startsWith("#/labels")) return "labels";
  if (location.hash.startsWith("#/data")) return "data";
  return "home";
}

function renderRoute() {
  const view = currentView();
  els.homeView.hidden = view !== "home";
  els.labelsView.hidden = view !== "labels";
  els.dataView.hidden = view !== "data";
  if (view === "labels") renderLabelsPage();
}

function moveSelection(delta) {
  if (state.visible.length === 0) return;
  state.selectedIndex = Math.max(
    0,
    Math.min(state.visible.length - 1, state.selectedIndex + delta),
  );
  render();
}

function bindEvents() {
  els.filterSelect.addEventListener("change", () => {
    state.filterName = els.filterSelect.value;
    state.selectedIndex = 0;
    render();
  });

  els.prevButton.addEventListener("click", () => moveSelection(-1));
  els.nextButton.addEventListener("click", () => moveSelection(1));

  els.promptButton.addEventListener("click", openPromptModal);
  els.promptModalClose.addEventListener("click", closePromptModal);
  els.promptModal.addEventListener("click", (event) => {
    if (event.target === els.promptModal) closePromptModal();
  });

  els.labelsFilterSelect.addEventListener("change", () => {
    state.labelsFilter = els.labelsFilterSelect.value;
    renderLabelsPage();
  });

  els.distributionButton.addEventListener("click", openDistributionWindow);

  els.dataZToggle.addEventListener("change", () => setZMode(els.dataZToggle.checked));
  els.labelsZToggle.addEventListener("change", () =>
    setZMode(els.labelsZToggle.checked),
  );

  els.labelsSortSelect.addEventListener("change", () => {
    state.labelsSort = els.labelsSortSelect.value;
    renderLabelsPage();
  });

  els.thresholdRange.addEventListener("input", () => {
    setThreshold(Number(els.thresholdRange.value));
  });
  els.thresholdMinus.addEventListener("click", () => nudgeThreshold(-1));
  els.thresholdPlus.addEventListener("click", () => nudgeThreshold(1));
  els.accuracyAggregationSelect.addEventListener("change", () => {
    state.labelsAccuracyAggregation = els.accuracyAggregationSelect.value;
    renderAccuracy();
  });

  window.addEventListener("hashchange", renderRoute);

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.promptModal.hidden) {
      closePromptModal();
      return;
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    if (currentView() !== "data") {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      moveSelection(1);
    }
  });
}

async function loadDocuments() {
  const errors = [];
  for (const url of DATA_URLS) {
    let response;
    try {
      response = await fetch(`${url}?t=${Date.now()}`);
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
      continue;
    }
    if (!response.ok) {
      errors.push(`${url}: HTTP ${response.status}`);
      continue;
    }

    const text = await response.text();
    const documents = parseJsonl(text);
    if (documents.length === 0) {
      errors.push(`${url}: no rated rows`);
      continue;
    }

    for (const overlayUrl of RATING_OVERLAY_URLS) {
      try {
        const overlayResponse = await fetch(`${overlayUrl}?t=${Date.now()}`);
        if (!overlayResponse.ok) {
          if (overlayResponse.status !== 404) {
            console.warn(`Could not load rating overlay ${overlayUrl}: HTTP ${overlayResponse.status}`);
          }
          continue;
        }
        const overlayDocuments = parseJsonl(await overlayResponse.text());
        const result = mergeRatingOverlay(documents, overlayDocuments);
        if (result.collisions > 0) {
          console.warn(
            `Skipped ${result.collisions} overlay rating collision(s) from ${overlayUrl}; existing ratings were preserved.`,
          );
        }
        console.info(
          `Merged ${result.addedRatings} ratings from ${result.matchedRows} rows in ${overlayUrl}.`,
        );
      } catch (error) {
        console.warn(`Could not load rating overlay ${overlayUrl}: ${error.message}`);
      }
    }

    state.documents = documents;
    state.visible = documents;
    return;
  }

  throw new Error(`No rated JSONL could be loaded.\n${errors.join("\n")}`);
}

async function main() {
  bindEvents();
  populateLabelsFilterControls();
  loadPromptPaths();
  // Small file, and both pages need to know whether z mode is even available
  // before their first paint.
  await loadRatingStats();
  documentsReady = loadDocuments();
  renderRoute();
  try {
    await documentsReady;
    populateFilterControls();
    render();
  } catch (error) {
    els.statusText.textContent = "Could not load rated JSONL";
    els.documentList.innerHTML = "";
    els.documentText.textContent =
      `${error.message}\n\n` +
      "Serve the repository root (e.g. python -m http.server) and open /src/viewer/ " +
      "so the browser can fetch the rated JSONL from /data/judge/rated/.";
  }
}

main();
