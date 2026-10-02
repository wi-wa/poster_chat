"use strict";

// Benchmarks view: accuracy of the final exp / reif / control models after SFT and after one DPO
// iteration, on every RL environment, IFEval and contingent knowledge (data/benchmarks.json).
(() => {
  const MODEL_COLORS = { exp: "#dc8b28", reif: "#b34790", control: "#2673b8" };
  const byId = (id) => document.getElementById(id);
  let data;
  let chart;

  const percent = (value) => (value == null ? "" : `${(100 * value).toFixed(1)}%`);
  const cell = (label, benchmark, mode) => data.results[label]?.[benchmark]?.[mode];

  function mean(label, mode) {
    // Unweighted mean over the benchmarks every checkpoint has in this mode, so averages compare.
    const shared = data.metadata.benchmarks.filter((b) =>
      data.metadata.checkpoints.every((c) => cell(c.label, b.id, mode)),
    );
    // A mean of one benchmark would only repeat its row.
    if (shared.length < 2 || !shared.every((b) => cell(label, b.id, mode))) return null;
    return { value: shared.reduce((sum, b) => sum + cell(label, b.id, mode).accuracy, 0) / shared.length, count: shared.length };
  }

  function renderChart() {
    const mode = byId("bench-mode").value;
    const stage = byId("bench-stage").value;
    const benchmarks = data.metadata.benchmarks.filter((b) =>
      data.metadata.models.some((m) => cell(`${m.id}_${stage}`, b.id, mode)),
    );
    const datasets = data.metadata.models.map((model) => ({
      label: model.name,
      data: benchmarks.map((b) => {
        const entry = cell(`${model.id}_${stage}`, b.id, mode);
        return entry ? 100 * entry.accuracy : null;
      }),
      backgroundColor: MODEL_COLORS[model.id],
      borderRadius: 2,
      maxBarThickness: 22,
    }));
    const stageName = data.metadata.stages.find((s) => s.id === stage).name;
    byId("bench-chart").setAttribute(
      "aria-label",
      `Accuracy by benchmark after ${stageName}, ${mode === "think" ? "thinking" : "plain"} mode. Exact values are in the table below.`,
    );
    const config = {
      type: "bar",
      data: { labels: benchmarks.map((b) => b.name), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          y: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` }, grid: { color: "#e8eced" }, title: { display: true, text: "Accuracy" } },
          x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 45 } },
        },
        plugins: {
          legend: { position: "top", align: "start", labels: { boxWidth: 12, boxHeight: 12 } },
          tooltip: { callbacks: { label: (ctx) => (ctx.raw == null ? `${ctx.dataset.label}: not evaluated` : `${ctx.dataset.label}: ${ctx.raw.toFixed(1)}%`) } },
        },
      },
    };
    if (chart) chart.destroy();
    chart = new window.Chart(byId("bench-chart"), config);
    byId("bench-chart-status").textContent = benchmarks.length ? "" : "No results for this stage yet.";
  }

  function renderTable() {
    const mode = byId("bench-mode").value;
    const { models, stages, benchmarks } = data.metadata;
    const table = document.createElement("table");
    table.className = "bench-table";
    const head = table.createTHead();
    const top = head.insertRow();
    const corner = document.createElement("th");
    corner.rowSpan = 2;
    corner.textContent = "Benchmark";
    top.append(corner);
    for (const model of models) {
      const th = document.createElement("th");
      th.colSpan = stages.length;
      th.className = "group";
      th.innerHTML = `<span class="swatch" style="background:${MODEL_COLORS[model.id]}"></span>`;
      th.append(model.name);
      th.title = model.description;
      top.append(th);
    }
    const second = head.insertRow();
    for (const _ of models) for (const stage of stages) {
      const th = document.createElement("th");
      th.textContent = stage.name;
      second.append(th);
    }
    const body = table.createTBody();
    const addRow = (name, title, values, className = "") => {
      const row = body.insertRow();
      if (className) row.className = className;
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = name;
      if (title) th.title = title;
      row.append(th);
      const present = values.filter((v) => v).map((v) => v.value);
      const best = present.length > 1 ? Math.max(...present) : null;
      for (const value of values) {
        const td = row.insertCell();
        if (!value) {
          td.textContent = "…";
          td.className = "pending";
          td.title = "Not evaluated";
          continue;
        }
        td.textContent = percent(value.value);
        if (value.title) td.title = value.title;
        if (best !== null && value.value === best) td.className = "best";
      }
    };
    for (const benchmark of benchmarks) {
      const values = models.flatMap((m) => stages.map((s) => {
        const entry = cell(`${m.id}_${s.id}`, benchmark.id, mode);
        return entry && { value: entry.accuracy, title: `${entry.correct ?? "?"} / ${entry.evaluated ?? "?"}` };
      }));
      if (values.every((v) => !v) && benchmark.id === "contingent_knowledge" && mode === "plain") {
        addRow(benchmark.name, "Contingent knowledge is only evaluated with thinking", values.map(() => null), "na");
        continue;
      }
      addRow(benchmark.name, benchmark.scoring, values);
    }
    const means = models.flatMap((m) => stages.map((s) => {
      const value = mean(`${m.id}_${s.id}`, mode);
      return value && { value: value.value, title: `Mean of ${value.count} benchmarks` };
    }));
    if (means.some(Boolean)) addRow("Average", "Unweighted mean over benchmarks every checkpoint has results for", means, "average");
    byId("bench-table").replaceChildren(table);
  }

  function render() {
    renderChart();
    renderTable();
  }

  window.loadBenchmarks = async () => {
    if (data) return;
    try {
      const response = await fetch("data/benchmarks.json", { credentials: "omit" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
    } catch (error) {
      byId("bench-chart-status").textContent = `Could not load benchmark data (${error.message}).`;
      return;
    }
    byId("bench-protocol").textContent = data.metadata.protocol;
    const done = Object.values(data.results).reduce((n, scores) => n + Object.keys(scores).length, 0);
    const total = data.metadata.checkpoints.length * data.metadata.benchmarks.length;
    byId("bench-progress").textContent = done < total ? `${done} of ${total} results; the rest were not evaluated.` : "";
    for (const id of ["bench-mode", "bench-stage"]) byId(id).addEventListener("change", render);
    render();
  };
})();
