/* Archway Compare: fan one prompt out to several models at once and stream each
 * answer into its own column. Owns the picker, the run/stop lifecycle and the
 * per-column rendering; everything about keys, HTTP and errors lives in
 * assets/archway.js. */
(function () {
  "use strict";

  // Four is the cap: --series-1..4 give each column a distinct colour, and four
  // concurrent streams still read as one screen on a laptop.
  var MAX_MODELS = 4;

  // Short answers keep the columns comparable and the quota cost small.
  var MAX_TOKENS = 400;

  var PICK_HINT = "One key reaches every vendor NYU fronts. Pick up to four.";
  var EMPTY_RESULTS =
    "Pick your models, write a prompt, and run the comparison. Answers stream in side by side.";

  var form = document.getElementById("run-form");
  var systemInput = document.getElementById("system");
  var promptInput = document.getElementById("prompt");
  var runBtn = document.getElementById("run");
  var stopBtn = document.getElementById("stop");
  var hint = document.getElementById("hint");
  var picker = document.getElementById("picker");
  var pickNote = document.getElementById("pick-note");
  var pickCount = document.getElementById("pick-count");
  var modelsError = document.getElementById("models-error");
  var runError = document.getElementById("run-error");
  var summary = document.getElementById("summary");
  var results = document.getElementById("results");

  var state = {
    models: [],
    byId: {},
    running: false,
    controllers: [],
    readyHint: "Connect a key to load the model catalogue.",
  };

  Archway.mountThemeToggle(document.getElementById("theme-toggle"));

  Archway.mountKeyPanel(document.getElementById("key-mount"), {
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
    hint.textContent = "Loading the catalogue…";

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
        var defaults = {};
        Archway.onePerProvider(models, MAX_MODELS).forEach(function (m) {
          defaults[m.id] = true;
        });
        pickInputs().forEach(function (box) {
          box.checked = defaults[box.value] === true;
        });

        state.readyHint = models.length + " models available on this key.";
        hint.textContent = state.readyHint;
        syncPicker();
      })
      .catch(function (err) {
        // Drop the previous catalogue rather than leaving it on screen. On a
        // *re*-load - the user swapped in a revoked key or mistyped the base
        // URL - the old key's models would otherwise stay checked and every
        // control would stay enabled, because `ready` is computed from
        // state.models.length. Running then fires four streams that all fail
        // under a picker that looks perfectly live.
        state.models = [];
        state.byId = {};
        renderPicker([]);

        state.readyHint = "The catalogue did not load.";
        hint.textContent = state.readyHint;
        Archway.renderError(modelsError, err);
        refreshControls();
      });
  }

  function renderPicker(models) {
    Archway.clear(picker);

    if (!models.length) {
      picker.appendChild(Archway.el("p", "empty", "This key has no chat models enabled."));
      return;
    }

    // Catalogue order, grouped by provider — and the same order columns run in,
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
      group.appendChild(Archway.el("legend", null, name));

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
    var box = Archway.el("input");
    box.type = "checkbox";
    box.value = model.id;

    label.appendChild(box);
    label.appendChild(Archway.el("span", null, nameOf(model)));
    if (model.deprecated) {
      label.appendChild(Archway.el("span", "badge badge--warn", "deprecated"));
    }
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

  function syncPicker() {
    var count = 0;
    pickInputs().forEach(function (box) {
      if (box.checked) count += 1;
      box.parentNode.classList.toggle("pick--on", box.checked);
    });
    pickCount.textContent = count + " selected";
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

  // ----------------------------------------------------------------- controls

  function refreshControls() {
    var ready = Archway.hasKey() && state.models.length > 0;
    systemInput.disabled = !ready;
    promptInput.disabled = !ready;
    // Left enabled with nothing picked on purpose: run() then says what is
    // missing, which beats a dead button with no explanation.
    runBtn.disabled = !ready || state.running;
    stopBtn.disabled = !state.running;
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
    picker.appendChild(Archway.el("p", "empty", "The catalogue loads once your key is connected."));
    summary.textContent = "";
    pickNote.textContent = PICK_HINT;
    pickCount.textContent = "0 selected";
    state.readyHint = "Connect a key to load the model catalogue.";
    hint.textContent = state.readyHint;
    showEmptyResults();
    refreshControls();
  }

  function showEmptyResults() {
    Archway.clear(results);
    results.appendChild(Archway.el("p", "empty", EMPTY_RESULTS));
  }

  function stopAll() {
    state.controllers.forEach(function (controller) {
      controller.abort();
    });
    state.controllers = [];
  }

  // -------------------------------------------------------------- comparison

  function makeColumn(model, index) {
    var root = Archway.el("article", "card col col--" + (index + 1));

    var head = Archway.el("div", "col__head");
    head.appendChild(Archway.el("span", "col__name", nameOf(model)));
    head.appendChild(Archway.el("span", "xs muted", providerOf(model)));

    // Model output is untrusted text: textContent only, and .msg__body keeps the
    // whitespace it arrived with.
    var body = Archway.el("p", "msg__body col__body streaming");
    // The region announces new columns; announcing every streamed fragment
    // would make a screen reader unusable.
    body.setAttribute("aria-live", "off");

    var errBox = Archway.el("div");
    var foot = Archway.el("div", "col__foot");

    var more = Archway.el("details", "col__more hidden");
    more.appendChild(Archway.el("summary", null, "Gateway headers"));
    var readout = Archway.el("div", "readout hidden");
    more.appendChild(readout);

    root.appendChild(head);
    root.appendChild(body);
    root.appendChild(errBox);
    root.appendChild(foot);
    root.appendChild(more);

    return { root: root, body: body, errBox: errBox, foot: foot, more: more, readout: readout };
  }

  function totalTokens(result) {
    if (result.usage && typeof result.usage.total_tokens === "number") {
      return result.usage.total_tokens;
    }
    var used = parseInt(result.headers && result.headers["x-nyu-tokens-used"], 10);
    return isFinite(used) ? used : null;
  }

  function renderFoot(col, result) {
    Archway.clear(col.foot);

    var tokens = totalTokens(result);
    col.foot.appendChild(
      Archway.el("span", null, tokens === null ? "tokens n/a" : Archway.formatInt(tokens) + " tokens")
    );
    col.foot.appendChild(Archway.el("span", null, (result.ms / 1000).toFixed(1) + " s"));

    if (result.headers && result.headers["x-nyu-mock"] === "true") {
      var badge = Archway.el("span", "badge badge--warn", "mock");
      badge.title = "No active vendor credential for this provider — the Archway answered from its "
        + "mock adapter. The token accounting is still real.";
      col.foot.appendChild(badge);
    }
  }

  function runOne(model, col, prompt, system) {
    var controller = new AbortController();
    state.controllers.push(controller);

    var opts = {
      model: model.id,
      messages: [{ role: "user", content: prompt }],
      maxTokens: Math.min(MAX_TOKENS, model.max_output_tokens || MAX_TOKENS),
      signal: controller.signal,
    };
    if (system) opts.system = system;

    return Archway.streamChat(opts, function (fragment, full) {
      col.body.textContent = full;
    })
      .then(function (result) {
        col.body.textContent = result.text || "(the model returned nothing)";
        renderFoot(col, result);
        Archway.renderReadout(col.readout, result.headers, { ms: result.ms });
        col.more.classList.remove("hidden");
        return { model: model, ok: true, ms: result.ms, tokens: totalTokens(result) };
      })
      .catch(function (err) {
        // One vendor being down is not the comparison failing: the error stays
        // inside its own column and the other streams run on.
        if (err && err.name === "AbortError") {
          col.foot.textContent = "Stopped.";
          return { model: model, ok: false };
        }
        Archway.renderError(col.errBox, err);
        return { model: model, ok: false };
      })
      .then(function (row) {
        col.body.classList.remove("streaming");
        return row;
      });
  }

  function renderSummary(rows) {
    var done = rows.filter(function (row) {
      return row.ok;
    });
    if (!done.length) {
      summary.textContent = "";
      return;
    }

    var fastest = done.slice().sort(function (a, b) {
      return a.ms - b.ms;
    })[0];
    var priced = done.filter(function (row) {
      return typeof row.tokens === "number";
    });
    var cheapest = priced.sort(function (a, b) {
      return a.tokens - b.tokens;
    })[0];

    var parts = ["Fastest: " + nameOf(fastest.model) + " (" + (fastest.ms / 1000).toFixed(1) + " s)"];
    if (cheapest) {
      parts.push("Fewest tokens: " + nameOf(cheapest.model) + " (" + Archway.formatInt(cheapest.tokens) + ")");
    }
    summary.textContent = parts.join("  ·  ");
  }

  function run() {
    if (state.running) return;

    Archway.clear(runError);
    var prompt = promptInput.value.trim();
    if (!prompt) {
      hint.textContent = "Type a prompt first.";
      promptInput.focus();
      return;
    }
    hint.textContent = state.readyHint;

    var models = selectedModels();
    if (!models.length) {
      pickNote.textContent = "Pick at least one model.";
      return;
    }

    var system = systemInput.value.trim();

    state.running = true;
    state.controllers = [];
    refreshControls();
    summary.textContent = "";
    Archway.clear(results);
    results.setAttribute("aria-busy", "true");

    var cols = models.map(function (model, index) {
      var col = makeColumn(model, index);
      results.appendChild(col.root);
      return col;
    });
    results.focus();

    // The whole point: every column is in flight at once, on one key.
    Promise.all(
      models.map(function (model, index) {
        return runOne(model, cols[index], prompt, system);
      })
    )
      .then(renderSummary)
      // runOne swallows its own failures, so this only catches a bug in the
      // fan-out itself — but an unhandled rejection would leave the UI stuck.
      .catch(function (err) {
        Archway.renderError(runError, err);
      })
      .finally(function () {
        state.running = false;
        state.controllers = [];
        results.setAttribute("aria-busy", "false");
        refreshControls();
      });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    run();
  });

  stopBtn.addEventListener("click", stopAll);

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
