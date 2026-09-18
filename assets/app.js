/* Archway Compare: fan one prompt out to several models at once and stream each
 * answer into its own column. Owns the picker, the run/stop lifecycle and the
 * per-column rendering; everything about keys, HTTP and errors lives in
 * assets/archway.js.
 *
 * Two rules this file keeps:
 *   - Nothing is ever written with innerHTML. Model output is untrusted, so
 *     every node is built with Archway.el() and filled with textContent.
 *   - Punctuation that repeats (the em dash, the ellipsis) is a named constant,
 *     so the strings below stay readable and one spelling is used throughout.
 *     The file is UTF-8 with no BOM, as every file here is.
 */
(function () {
  "use strict";

  // Four is the cap: --series-1..4 give each column a distinct colour, and four
  // concurrent streams still read as one screen on a laptop.
  var MAX_MODELS = 4;

  // Short answers keep the columns comparable and the quota cost small. The
  // number is quoted in index.html's card note - change both together.
  var MAX_TOKENS = 400;

  var DASH = "\u2014";
  var ELLIPSIS = "\u2026";

  var PICK_HINT =
    "One key reaches every vendor the Archway fronts. Pick up to four " +
    DASH +
    " they all run at once.";
  var PICK_WAIT =
    "Connect a key above and the catalogue loads here " +
    DASH +
    " already scoped to what that key may call.";
  var EMPTY_TITLE = "Nothing to compare yet";
  var EMPTY_BODY =
    "Pick your models, write a prompt, then run. Every answer streams into its own " +
    "column at the same time.";

  function byId(id) {
    return document.getElementById(id);
  }

  var form = byId("run-form");
  var systemInput = byId("system");
  var promptInput = byId("prompt");
  var runBtn = byId("run");
  var runLabel = byId("run-label");
  var runSpin = byId("run-spin");
  var stopBtn = byId("stop");
  var hint = byId("hint");
  var picker = byId("picker");
  var pickNote = byId("pick-note");
  var pickCount = byId("pick-count");
  var pickBusy = byId("pick-busy");
  var pickAuto = byId("pick-auto");
  var pickClear = byId("pick-clear");
  var modelsError = byId("models-error");
  var runError = byId("run-error");
  var summary = byId("summary");
  var results = byId("results");
  var resultsStatus = byId("results-status");
  var sysFlag = byId("sys-flag");
  var presets = Array.prototype.slice.call(
    document.querySelectorAll("#presets button[data-prompt]")
  );

  var state = {
    models: [],
    byId: {},
    running: false,
    controllers: [],
  };

  Archway.mountThemeToggle(byId("theme-toggle"));

  Archway.mountKeyPanel(byId("key-mount"), {
    onReady: loadModels,
    onClear: reset,
  });

  // ------------------------------------------------------------------ models

  function providerOf(model) {
    return model.provider || model.owned_by || "Other";
  }

  function nameOf(model) {
    return model.display_name || model.id;
  }

  function loadModels() {
    Archway.clear(modelsError);
    pickBusy.classList.remove("hidden");
    pickNote.textContent = "Loading the catalogue" + ELLIPSIS;

    Archway.listModels()
      .then(function (models) {
        state.models = models;
        state.byId = {};
        models.forEach(function (m) {
          state.byId[m.id] = m;
        });

        renderPicker(models);

        // The catalogue is already scoped to this key, so one model per provider
        // is the most interesting default: it is the comparison this gateway
        // exists to make possible.
        applyOnePerVendor();
        pickNote.textContent = PICK_HINT;
      })
      .catch(function (err) {
        // Drop the previous catalogue rather than leaving it on screen. On a
        // *re*-load - the user swapped in a revoked key - the old key's models
        // would otherwise stay checked and every control would stay enabled,
        // because `ready` is computed from state.models.length. Running then
        // fires four streams that all fail under a picker that looks live.
        state.models = [];
        state.byId = {};
        renderPicker([]);

        pickNote.textContent = "The catalogue did not load.";
        Archway.renderError(modelsError, err);
        syncPicker();
      })
      .finally(function () {
        pickBusy.classList.add("hidden");
      });
  }

  function renderPicker(models) {
    Archway.clear(picker);

    if (!models.length) {
      picker.appendChild(
        emptyBlock("No models on this key", "Ask the Archway team to enable a chat model for it.")
      );
      return;
    }

    // Catalogue order, grouped by provider - and the same order columns run in,
    // so a provider keeps its colour from one run to the next.
    var groups = {};
    var order = [];
    models.forEach(function (m) {
      var name = providerOf(m);
      if (!groups[name]) {
        groups[name] = [];
        order.push(name);
      }
      groups[name].push(m);
    });

    order.forEach(function (name) {
      var group = Archway.el("fieldset", "picker__group");

      var legend = Archway.el("legend");
      legend.appendChild(Archway.el("span", "picker__vendor", name));
      legend.appendChild(
        Archway.el(
          "span",
          "picker__count",
          groups[name].length + (groups[name].length === 1 ? " model" : " models")
        )
      );
      group.appendChild(legend);

      var list = Archway.el("div", "picker__list");
      groups[name].forEach(function (m) {
        list.appendChild(pickRow(m));
      });

      group.appendChild(list);
      picker.appendChild(group);
    });
  }

  function pickRow(model) {
    var label = Archway.el("label", "pick");
    // The alias is what you would actually send; it is too long for the chip
    // but worth having on hover.
    label.title = model.id;

    var box = Archway.el("input");
    box.type = "checkbox";
    box.value = model.id;

    label.appendChild(box);
    label.appendChild(Archway.el("span", "pick__name", nameOf(model)));
    if (model.deprecated) {
      label.appendChild(Archway.el("span", "badge badge--warn", "deprecated"));
    }

    var swatch = Archway.el("span", "pick__swatch");
    swatch.setAttribute("aria-hidden", "true");
    label.appendChild(swatch);

    return label;
  }

  function pickInputs() {
    return Array.prototype.slice.call(picker.querySelectorAll("input[type=checkbox]"));
  }

  function selectedModels() {
    var out = [];
    pickInputs().forEach(function (box) {
      if (box.checked && state.byId[box.value]) out.push(state.byId[box.value]);
    });
    return out;
  }

  function applyOnePerVendor() {
    var defaults = {};
    Archway.onePerProvider(state.models, MAX_MODELS).forEach(function (m) {
      defaults[m.id] = true;
    });
    pickInputs().forEach(function (box) {
      box.checked = defaults[box.value] === true;
    });
    syncPicker();
  }

  /* Paint the picker from the checkboxes: the selection count, and the series
   * colour each picked model will carry once it has a column. Selection order
   * here is DOM order, which is the order selectedModels() returns and the
   * order run() builds columns in - so the swatch is a promise the bench
   * keeps. */
  function syncPicker() {
    var count = 0;
    pickInputs().forEach(function (box) {
      var chip = box.parentNode;
      chip.classList.remove("tone--1", "tone--2", "tone--3", "tone--4");
      chip.classList.toggle("pick--on", box.checked);
      if (box.checked) {
        count += 1;
        if (count <= MAX_MODELS) chip.classList.add("tone--" + count);
      }
    });

    pickCount.textContent = count + " of " + MAX_MODELS;
    pickCount.classList.toggle("badge--accent", count > 0);
    refreshControls();
  }

  picker.addEventListener("change", function (event) {
    var box = event.target;
    if (!box || box.type !== "checkbox") return;

    if (box.checked && selectedModels().length > MAX_MODELS) {
      box.checked = false;
      pickNote.textContent = "Four at a time. Clear one before adding another.";
    } else {
      pickNote.textContent = PICK_HINT;
    }
    syncPicker();
  });

  pickAuto.addEventListener("click", function () {
    applyOnePerVendor();
    pickNote.textContent = PICK_HINT;
  });

  pickClear.addEventListener("click", function () {
    pickInputs().forEach(function (box) {
      box.checked = false;
    });
    pickNote.textContent = PICK_HINT;
    syncPicker();
  });

  // ----------------------------------------------------------------- controls

  function refreshControls() {
    var ready = Archway.hasKey() && state.models.length > 0;
    var idle = ready && !state.running;
    var picked = selectedModels().length;

    systemInput.disabled = !ready;
    promptInput.disabled = !ready;
    presets.forEach(function (button) {
      button.disabled = !idle;
    });

    // Left enabled with nothing picked on purpose: run() then says what is
    // missing, which beats a dead button with no explanation.
    runBtn.disabled = !ready || state.running;
    stopBtn.disabled = !state.running;

    pickAuto.disabled = !idle;
    pickClear.disabled = !idle || picked === 0;
    pickInputs().forEach(function (box) {
      box.disabled = !ready || state.running;
    });
  }

  function reset() {
    stopAll();
    state.models = [];
    state.byId = {};
    Archway.clear(modelsError);
    Archway.clear(runError);
    Archway.clear(picker);
    picker.appendChild(
      emptyBlock("No catalogue yet", "Paste your key above to see every model this key can reach.")
    );
    Archway.clear(summary);
    Archway.clear(resultsStatus);
    pickNote.textContent = PICK_WAIT;
    pickCount.textContent = "0 of " + MAX_MODELS;
    pickCount.classList.remove("badge--accent");
    setHint("");
    showEmptyResults();
    refreshControls();
  }

  function setHint(text, isError) {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", isError === true);
  }

  function emptyBlock(title, body) {
    var wrap = Archway.el("p", "empty");
    wrap.appendChild(Archway.el("strong", "empty__title", title));
    wrap.appendChild(document.createTextNode(body));
    return wrap;
  }

  function showEmptyResults() {
    Archway.clear(results);
    var card = Archway.el("article", "card col--empty");
    card.appendChild(emptyBlock(EMPTY_TITLE, EMPTY_BODY));
    results.appendChild(card);
  }

  function stopAll() {
    state.controllers.forEach(function (controller) {
      controller.abort();
    });
    state.controllers = [];
  }

  function setRunning(on) {
    state.running = on;
    runSpin.classList.toggle("hidden", !on);
    runLabel.textContent = on ? "Running" + ELLIPSIS : "Run comparison";
    results.setAttribute("aria-busy", on ? "true" : "false");
    refreshControls();
  }

  // -------------------------------------------------------------- comparison

  function seconds(ms) {
    return (ms / 1000).toFixed(1) + " s";
  }

  function statCell(label) {
    var root = Archway.el("div", "col__stat");
    root.appendChild(Archway.el("span", "col__k", label));
    var value = Archway.el("span", "col__v", DASH);
    root.appendChild(value);
    return { root: root, value: value };
  }

  function makeColumn(model, index) {
    var root = Archway.el("article", "card card--flush col tone--" + (index + 1));

    var head = Archway.el("header", "col__head");
    var dot = Archway.el("span", "col__dot");
    dot.setAttribute("aria-hidden", "true");
    var ident = Archway.el("div", "col__id");
    ident.appendChild(Archway.el("span", "col__name", nameOf(model)));
    ident.appendChild(Archway.el("span", "col__provider", providerOf(model)));
    var status = Archway.el("span", "col__state");
    status.setAttribute("aria-hidden", "true");
    status.appendChild(Archway.el("span", "spinner"));
    head.appendChild(dot);
    head.appendChild(ident);
    head.appendChild(status);

    // Model output is untrusted text: textContent only, and .col__body keeps the
    // whitespace it arrived with.
    var body = Archway.el("p", "col__body col__body--wait streaming");
    body.textContent = "Waiting for the first token" + ELLIPSIS;
    // The region announces new columns; announcing every streamed fragment
    // would make a screen reader unusable.
    body.setAttribute("aria-live", "off");

    var errBox = Archway.el("div", "col__err");

    var foot = Archway.el("footer", "col__foot");
    var tokens = statCell("Tokens");
    var elapsed = statCell("Elapsed");
    var flags = Archway.el("div", "col__flags");

    var more = Archway.el("details", "col__more hidden");
    more.appendChild(Archway.el("summary", null, "Gateway headers"));
    var readout = Archway.el("div", "readout hidden");
    more.appendChild(readout);

    foot.appendChild(tokens.root);
    foot.appendChild(elapsed.root);
    foot.appendChild(flags);
    foot.appendChild(more);

    root.appendChild(head);
    root.appendChild(body);
    root.appendChild(errBox);
    root.appendChild(foot);

    return {
      root: root,
      body: body,
      errBox: errBox,
      status: status,
      tokens: tokens.value,
      elapsed: elapsed.value,
      flags: flags,
      more: more,
      readout: readout,
    };
  }

  function totalTokens(result) {
    if (result.usage && typeof result.usage.total_tokens === "number") {
      return result.usage.total_tokens;
    }
    var used = parseInt(result.headers && result.headers["x-nyu-tokens-used"], 10);
    return isFinite(used) ? used : null;
  }

  function flag(col, className, text, title) {
    var badge = Archway.el("span", className ? "badge " + className : "badge", text);
    if (title) badge.title = title;
    col.flags.appendChild(badge);
  }

  function renderFoot(col, result) {
    var tokens = totalTokens(result);
    col.tokens.textContent = tokens === null ? "n/a" : Archway.formatInt(tokens);
    col.elapsed.textContent = seconds(result.ms);

    if (result.headers && result.headers["x-nyu-mock"] === "true") {
      flag(
        col,
        "badge--warn",
        "mock",
        "No active vendor credential for this provider " +
          DASH +
          " the Archway answered from its mock adapter. The token accounting is still real."
      );
    }
  }

  function runOne(model, col, prompt, system, onSettled) {
    var controller = new AbortController();
    state.controllers.push(controller);

    var opts = {
      model: model.id,
      messages: [{ role: "user", content: prompt }],
      maxTokens: Math.min(MAX_TOKENS, model.max_output_tokens || MAX_TOKENS),
      signal: controller.signal,
    };
    if (system) opts.system = system;

    var first = true;

    return Archway.streamChat(opts, function (fragment, full) {
      if (first) {
        first = false;
        col.body.classList.remove("col__body--wait");
      }
      col.body.textContent = full;
    })
      .then(function (result) {
        // A placeholder stays in the muted voice; a real answer does not.
        col.body.classList.toggle("col__body--wait", !result.text);
        col.body.textContent = result.text || "(the model returned nothing)";
        renderFoot(col, result);
        Archway.renderReadout(col.readout, result.headers, { ms: result.ms });
        col.more.classList.remove("hidden");
        return { model: model, col: col, ok: true, ms: result.ms, tokens: totalTokens(result) };
      })
      .catch(function (err) {
        // One vendor being down is not the comparison failing: the error stays
        // inside its own column and the other streams run on. `first` still
        // being true means nothing ever arrived to overwrite the placeholder,
        // so this is the only chance to replace it.
        if (err && err.name === "AbortError") {
          if (first) col.body.textContent = "(stopped before any output)";
          flag(col, "", "stopped");
          return { model: model, col: col, ok: false };
        }

        if (first) col.body.textContent = "";
        Archway.renderError(col.errBox, err);
        flag(col, "badge--bad", "failed");
        return { model: model, col: col, ok: false };
      })
      .then(function (row) {
        col.body.classList.remove("streaming");
        Archway.clear(col.status);
        if (onSettled) onSettled(row);
        return row;
      });
  }

  // ----------------------------------------------------------------- verdict

  function statusLine(done, total, running) {
    Archway.clear(resultsStatus);
    if (!total) return;

    if (running) {
      var spin = Archway.el("span", "spinner");
      spin.setAttribute("aria-hidden", "true");
      resultsStatus.appendChild(spin);
    }
    resultsStatus.appendChild(Archway.el("span", null, done + " of " + total + " answered"));
  }

  function verdictItem(label, value, detail) {
    var item = Archway.el("div", "verdict__item");
    item.appendChild(Archway.el("span", "verdict__k", label));
    item.appendChild(Archway.el("span", "verdict__v", value));
    if (detail) item.appendChild(Archway.el("span", "verdict__d", detail));
    return item;
  }

  /* The point of the whole page, stated once: of the models that answered, which
   * was quickest and which cost least. Below two answers there is nothing to
   * compare, so the strip stays away rather than dressing up a single result. */
  function renderSummary(rows) {
    Archway.clear(summary);

    var done = rows.filter(function (row) {
      return row.ok;
    });
    statusLine(done.length, rows.length, false);

    var failed = rows.length - done.length;
    if (failed > 0) {
      resultsStatus.appendChild(Archway.el("span", "badge badge--bad", failed + " failed"));
    }

    if (done.length < 2) return;

    var fastest = done.slice().sort(function (a, b) {
      return a.ms - b.ms;
    })[0];

    var priced = done.filter(function (row) {
      return typeof row.tokens === "number";
    });
    var cheapest = priced.length > 1
      ? priced.slice().sort(function (a, b) {
          return a.tokens - b.tokens;
        })[0]
      : null;

    summary.appendChild(verdictItem("Fastest", nameOf(fastest.model), seconds(fastest.ms)));
    flag(fastest.col, "badge--good", "fastest");

    if (cheapest) {
      summary.appendChild(
        verdictItem("Fewest tokens", nameOf(cheapest.model), Archway.formatInt(cheapest.tokens))
      );
      flag(cheapest.col, "badge--good", "fewest tokens");
    }

    summary.appendChild(verdictItem("Answered", done.length + " of " + rows.length, ""));
  }

  // --------------------------------------------------------------------- run

  function run() {
    if (state.running) return;

    Archway.clear(runError);

    var models = selectedModels();
    if (!models.length) {
      pickNote.textContent = "Pick at least one model to compare.";
      pickAuto.focus();
      return;
    }

    var prompt = promptInput.value.trim();
    if (!prompt) {
      setHint("Type a prompt first.", true);
      promptInput.focus();
      return;
    }
    setHint("");
    pickNote.textContent = PICK_HINT;

    var system = systemInput.value.trim();

    state.controllers = [];
    setRunning(true);
    Archway.clear(summary);
    Archway.clear(results);

    var cols = models.map(function (model, index) {
      var col = makeColumn(model, index);
      results.appendChild(col.root);
      return col;
    });
    results.focus();

    var answered = 0;
    statusLine(0, models.length, true);

    // The whole point: every column is in flight at once, on one key.
    Promise.all(
      models.map(function (model, index) {
        return runOne(model, cols[index], prompt, system, function (row) {
          if (row.ok) answered += 1;
          statusLine(answered, models.length, true);
        });
      })
    )
      .then(renderSummary)
      // runOne swallows its own failures, so this only catches a bug in the
      // fan-out itself - but an unhandled rejection would leave the UI stuck.
      .catch(function (err) {
        statusLine(answered, models.length, false);
        Archway.renderError(runError, err);
      })
      .finally(function () {
        state.controllers = [];
        setRunning(false);
      });
  }

  // ------------------------------------------------------------------- wiring

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    run();
  });

  stopBtn.addEventListener("click", stopAll);

  promptInput.addEventListener("input", function () {
    if (hint.classList.contains("is-error")) setHint("");
  });

  systemInput.addEventListener("input", function () {
    sysFlag.classList.toggle("hidden", systemInput.value.trim().length === 0);
  });

  presets.forEach(function (button) {
    button.addEventListener("click", function () {
      promptInput.value = button.getAttribute("data-prompt") || "";
      setHint("");
      promptInput.focus();
    });
  });

  document.addEventListener("keydown", function (event) {
    // Modifier-only shortcuts, so typing in the prompt box is never hijacked.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !runBtn.disabled) {
      event.preventDefault();
      run();
      return;
    }
    if (event.key === "Escape" && state.running) stopAll();
  });

  refreshControls();
})();
