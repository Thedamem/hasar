const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Works both on the add-on root and behind Home Assistant ingress.
const API_BASE = (() => {
  const match = window.location.pathname.match(/^(\/api\/hassio_ingress\/[^/]+)(\/|$)/);
  if (match) return `${match[1]}/`;
  const path = window.location.pathname;
  return path.endsWith("/") ? path : path.replace(/[^/]*$/, "");
})();

function apiUrl(path) {
  return `${API_BASE}${path.replace(/^\/+/, "")}`;
}

const PAGES = {
  overview: { title: "Обзор", subtitle: "Состояние моста Hasar" },
  models: { title: "Модели", subtitle: "Провайдеры, ключи и выбор моделей" },
  routing: { title: "Маршрутизация", subtitle: "Когда отвечает Assist, а когда LLM" },
  voice: { title: "Голос", subtitle: "Piper, воспроизведение и сеть" },
  mcp: { title: "MCP", subtitle: "Инструменты Home Assistant и внешних серверов" },
  station: { title: "Колонка", subtitle: "Привязка YAM-плагина" }
};

const state = {
  config: null,
  dirty: false,
  health: null,
  autoLoaded: { openai: false, gemini: false }
};

let toastTimer = null;

function api(path, options = {}) {
  return fetch(apiUrl(path), { cache: "no-store", ...options }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `${response.status} ${response.statusText}`);
    }
    return data;
  });
}

function showToast(message, type = "ok") {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast visible ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = "toast";
  }, 4200);
}

function setDirty(value) {
  state.dirty = value;
  const chip = $("save-state");
  chip.textContent = value ? "Есть изменения" : "Сохранено";
  chip.className = `chip ${value ? "chip-warn" : "chip-ok"}`;
}

function checkedProvider() {
  return document.querySelector('input[name="provider"]:checked')?.value || "openai";
}

function fillSelect(select, models, selected) {
  const items = Array.isArray(models) ? models : [];
  select.innerHTML = "";
  if (selected && !items.some((model) => model.id === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = `${selected} (текущая)`;
    select.appendChild(option);
  }
  for (const model of items) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name && model.name !== model.id
      ? `${model.name} (${model.id})`
      : model.id;
    select.appendChild(option);
  }
  if (!items.length && !selected) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "— нажмите «Загрузить» —";
    select.appendChild(option);
  }
  if (selected && [...select.options].some((option) => option.value === selected)) {
    select.value = selected;
  }
}

function currentOptions(value) {
  return value ? [{ id: value, name: value }] : [];
}

function applyProvider() {
  const provider = checkedProvider();
  for (const card of $$("[data-provider-card]")) {
    card.classList.toggle("card-active", card.dataset.providerCard === provider);
  }
  $("openai-badge").classList.toggle("hidden", provider !== "openai");
  $("gemini-badge").classList.toggle("hidden", provider !== "gemini");
  updateOverview();
}

function updateOverview() {
  const provider = checkedProvider();
  const model = provider === "gemini" ? $("gemini-chat").value : $("openai-model").value;
  const live = $("gemini-live-enabled").checked;
  const route = $("routing-mode").value;
  const pluginUrl = $("plugin-url").value.trim();
  const fingerprint = $("plugin-fingerprint").value.trim();
  const mcpCount = $$(".mcp-card").length;
  const piperUrl = $("piper-url").value.trim();

  $("tile-provider-value").textContent = provider === "gemini" ? "Google AI Studio" : "OpenAI-совместимый";
  $("tile-provider-sub").textContent = provider === "gemini"
    ? (live ? "Gemini Live включён" : "Gemini Chat")
    : "Chat Completions";
  $("tile-model-value").textContent = model || "не выбрана";
  $("tile-model-sub").textContent = provider === "gemini"
    ? (live ? "Live отвечает аудио" : "Текстовый ответ")
    : "MCP tools доступны";
  $("tile-route-value").textContent = route === "assist" ? "Только Assist" : route === "llm" ? "Только LLM" : "Auto";
  $("tile-route-sub").textContent = route === "auto"
    ? "Assist → LLM"
    : route === "assist" ? "Без fallback в LLM" : "Все запросы в модель";
  $("tile-station-value").textContent = pluginUrl ? "Привязана" : "Не привязана";
  $("tile-station-sub").textContent = fingerprint
    ? fingerprint.replace(/^sha256:/, "").slice(0, 16) + "…"
    : (pluginUrl || "нет URL плагина");

  $("state-mcp").textContent = mcpCount ? `${mcpCount} сервер(ов)` : "не настроены";
  $("state-piper").textContent = piperUrl || "не настроен";
  $("state-live").textContent = live && provider === "gemini" ? "включён" : "выключен";
  $("state-version").textContent = state.health ? state.health.version : "—";
  $("state-health").textContent = state.health ? "OK" : "Нет связи";
  $("state-health").className = `chip ${state.health ? "chip-ok" : "chip-error"}`;
  $("piper-status").textContent = piperUrl ? "Настроен" : "Не настроен";
  $("piper-status").className = `chip ${piperUrl ? "chip-ok" : "chip-warn"}`;
  $("voice-plugin-status").textContent = pluginUrl && $("plugin-token").value ? "Привязана" : "Не привязана";
  $("voice-plugin-status").className = `chip ${pluginUrl && $("plugin-token").value ? "chip-ok" : "chip-warn"}`;
  $("voice-live-status").textContent = live && provider === "gemini"
    ? "Live включён: аудио Gemini уходит в плагин напрямую."
    : "Live выключен: chat-ответы озвучиваются через Piper.";
  $("plugin-status").textContent = pluginUrl && $("plugin-token").value ? "Привязана" : "Не привязана";
  $("plugin-status").className = `chip ${pluginUrl && $("plugin-token").value ? "chip-ok" : "chip-warn"}`;
}

function renderConfig(next) {
  state.config = next;
  const provider = next.provider;
  for (const input of $$('input[name="provider"]')) {
    input.checked = input.value === provider;
  }
  $("openai-base").value = next.openai.baseUrl;
  $("openai-key").value = next.openai.apiKey;
  fillSelect($("openai-model"), currentOptions(next.openai.model), next.openai.model);
  $("gemini-base").value = next.gemini.baseUrl;
  $("gemini-key").value = next.gemini.apiKey;
  fillSelect($("gemini-chat"), currentOptions(next.gemini.chatModel), next.gemini.chatModel);
  fillSelect($("gemini-live"), currentOptions(next.gemini.liveModel), next.gemini.liveModel);
  $("gemini-live-enabled").checked = next.gemini.liveEnabled;
  $("routing-mode").value = next.routing.mode;
  $("session-timeout").value = next.routing.sessionTimeoutSeconds;
  $("llm-triggers").value = next.routing.llmTriggers.join(", ");
  $("intent-allowlist").value = next.routing.intentAllowlist.join(", ");
  $("system-prompt").value = next.systemPrompt;
  $("piper-url").value = next.piper.url;
  $("piper-voice").value = next.piper.voice;
  $("socks5").value = next.proxy.socks5;
  $("plugin-url").value = next.plugin.url;
  $("plugin-token").value = next.plugin.token;
  $("plugin-fingerprint").value = next.plugin.fingerprint || "—";
  $("pair-url").value = next.plugin.url;
  renderMcp(next.mcpServers);
  applyProvider();
  setDirty(false);
}

function splitList(value) {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function collectConfig() {
  if (!state.config) throw new Error("Конфигурация ещё не загружена.");
  const provider = checkedProvider();
  return {
    ...state.config,
    provider,
    openai: {
      ...state.config.openai,
      baseUrl: $("openai-base").value.trim().replace(/\/+$/, ""),
      apiKey: $("openai-key").value,
      model: $("openai-model").value,
    },
    gemini: {
      ...state.config.gemini,
      baseUrl: $("gemini-base").value.trim().replace(/\/+$/, ""),
      apiKey: $("gemini-key").value,
      chatModel: $("gemini-chat").value,
      liveModel: $("gemini-live").value,
      liveEnabled: $("gemini-live-enabled").checked,
    },
    systemPrompt: $("system-prompt").value,
    routing: {
      ...state.config.routing,
      mode: $("routing-mode").value,
      sessionTimeoutSeconds: Number($("session-timeout").value) || 120,
      llmTriggers: splitList($("llm-triggers").value),
      intentAllowlist: splitList($("intent-allowlist").value),
    },
    piper: {
      url: $("piper-url").value.trim(),
      voice: $("piper-voice").value.trim(),
    },
    proxy: { socks5: $("socks5").value.trim() },
    mcpServers: collectMcp(),
    plugin: {
      ...state.config.plugin,
      url: $("plugin-url").value.trim().replace(/\/+$/, ""),
      token: $("plugin-token").value,
    },
  };
}

async function save({ silent = false } = {}) {
  const button = $("save-top");
  button.disabled = true;
  try {
    const next = collectConfig();
    const saved = await api("api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    state.config = saved;
    $("mcp-error").textContent = "";
    setDirty(false);
    updateOverview();
    if (!silent) showToast("Настройки сохранены");
    return saved;
  } catch (error) {
    if (!silent) showToast(error.message, "error");
    throw error;
  } finally {
    button.disabled = false;
  }
}

async function refreshModels(provider, { quiet = false } = {}) {
  const isGemini = provider === "gemini";
  const button = $(isGemini ? "refresh-gemini" : "refresh-openai");
  const errorNode = $(isGemini ? "gemini-error" : "openai-error");
  const countNode = $(isGemini ? "gemini-count" : "openai-count");
  const chatSelect = $(isGemini ? "gemini-chat" : "openai-model");
  const previous = chatSelect.value;
  const original = button.textContent;

  errorNode.textContent = "";
  button.disabled = true;
  button.textContent = "Загрузка…";
  countNode.textContent = "Загрузка…";
  try {
    const data = await api("api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        openai: {
          baseUrl: $("openai-base").value.trim(),
          apiKey: $("openai-key").value,
        },
        gemini: {
          baseUrl: $("gemini-base").value.trim(),
          apiKey: $("gemini-key").value,
        },
      }),
    });
    const liveSelect = isGemini ? $("gemini-live") : null;
    const previousLive = liveSelect?.value;
    fillSelect(chatSelect, data.chat, previous);
    if (liveSelect) {
      fillSelect(liveSelect, data.live, previousLive);
    }
    const count = isGemini
      ? `${data.chat.length} chat · ${data.live.length} live`
      : `${data.chat.length} моделей`;
    countNode.textContent = count;
    if (chatSelect.value !== previous || (liveSelect && liveSelect.value !== previousLive)) {
      setDirty(true);
    }
    if (!quiet) showToast(`Модели загружены: ${count}`);
  } catch (error) {
    errorNode.textContent = error.message;
    countNode.textContent = "ошибка загрузки";
    if (!quiet) showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function maybeAutoLoadModels() {
  if (!state.config) return;
  const provider = checkedProvider();
  if (state.autoLoaded[provider]) return;
  if (provider === "gemini" && !$("gemini-key").value) return;
  if (provider === "openai") {
    const base = $("openai-base").value;
    if (!$("openai-key").value && base.includes("api.openai.com")) return;
  }
  state.autoLoaded[provider] = true;
  refreshModels(provider, { quiet: true });
}

function renderMcp(servers) {
  const list = $("mcp-list");
  list.innerHTML = "";
  for (const server of Array.isArray(servers) ? servers : []) {
    addMcpCard(server);
  }
  updateMcpState();
}

function addMcpCard(server = {}) {
  const template = $("mcp-template");
  const card = template.content.firstElementChild.cloneNode(true);
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  field("enabled").checked = server.enabled !== false;
  field("name").value = server.name || `server-${$$(".mcp-card").length + 1}`;
  field("transport").value = server.transport || "http";
  field("url").value = server.url || "";
  field("command").value = server.command || "";
  field("args").value = Array.isArray(server.args) ? server.args.join(", ") : "";
  field("headers").value = Object.entries(server.headers || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  const sync = () => {
    const stdio = field("transport").value === "stdio";
    for (const row of card.querySelectorAll('[data-row="url"], [data-row="headers"]')) {
      row.classList.toggle("hidden", stdio);
    }
    for (const row of card.querySelectorAll('[data-row="command"], [data-row="args"]')) {
      row.classList.toggle("hidden", !stdio);
    }
  };
  field("transport").addEventListener("change", () => {
    sync();
    setDirty(true);
  });
  card.querySelector("[data-remove]").addEventListener("click", () => {
    card.remove();
    updateMcpState();
    setDirty(true);
  });
  sync();
  $("mcp-list").appendChild(card);
}

function updateMcpState() {
  const count = $$(".mcp-card").length;
  $("mcp-empty").classList.toggle("hidden", count > 0);
  $("mcp-count").textContent = count ? `${count} сервер(ов)` : "0 серверов";
  updateOverview();
}

function headersFrom(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) throw new Error(`Заголовок должен быть в формате Key: value: ${trimmed}`);
    headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return headers;
}

function collectMcp() {
  return $$(".mcp-card").map((card) => {
    const field = (name) => card.querySelector(`[data-field="${name}"]`);
    const name = field("name").value.trim();
    const transport = field("transport").value;
    const enabled = field("enabled").checked;
    if (!name) throw new Error("У каждого MCP-сервера должно быть имя.");
    const url = field("url").value.trim();
    const command = field("command").value.trim();
    if (enabled && transport !== "stdio" && !url) {
      throw new Error(`MCP «${name}»: укажите URL.`);
    }
    if (enabled && transport === "stdio" && !command) {
      throw new Error(`MCP «${name}»: укажите команду.`);
    }
    return {
      name,
      transport,
      url,
      command,
      args: field("args").value.split(",").map((item) => item.trim()).filter(Boolean),
      headers: headersFrom(field("headers").value),
      enabled,
    };
  });
}

function renderAskResult(result) {
  const node = $("ask-result");
  node.innerHTML = "";
  const meta = document.createElement("div");
  meta.className = "result-meta";
  const routeLabels = { assist: "Assist", chat: "LLM", "gemini-live": "Gemini Live" };
  const audioLabels = { played: "Аудио: отправлено", skipped: "Аудио: без озвучки", failed: "Аудио: ошибка" };
  const addChip = (text, kind) => {
    const chip = document.createElement("span");
    chip.className = `chip ${kind}`;
    chip.textContent = text;
    meta.appendChild(chip);
  };
  addChip(`Маршрут: ${routeLabels[result.route] || result.route}`, "chip-info");
  if (result.intent) addChip(`Intent: ${result.intent}`, "chip-ok");
  addChip(audioLabels[result.audio] || `Аудио: ${result.audio}`, result.audio === "failed" ? "chip-error" : "chip-ok");
  const text = document.createElement("p");
  text.className = "result-text";
  text.textContent = result.text || "(пустой ответ)";
  node.append(meta, text);
}

function renderError(node, message) {
  node.innerHTML = "";
  const text = document.createElement("p");
  text.className = "result-placeholder result-error";
  text.textContent = message;
  node.appendChild(text);
}

function showPage(name, updateHash = true) {
  const page = PAGES[name] ? name : "overview";
  for (const panel of $$("[data-page-panel]")) {
    panel.classList.toggle("active", panel.dataset.pagePanel === page);
  }
  for (const button of $$(".nav-item")) {
    const active = button.dataset.page === page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $("page-title").textContent = PAGES[page].title;
  $("page-subtitle").textContent = PAGES[page].subtitle;
  if (updateHash) history.replaceState(null, "", `#${page}`);
  closeSidebar();
  window.scrollTo(0, 0);
  if (page === "models") setTimeout(maybeAutoLoadModels, 250);
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
}

async function loadHealth() {
  try {
    state.health = await api("health");
    $("conn-dot").className = "dot ok";
    $("conn-text").textContent = `Add-on ${state.health.version}`;
  } catch {
    state.health = null;
    $("conn-dot").className = "dot error";
    $("conn-text").textContent = "Нет связи с add-on";
  }
  updateOverview();
}

async function loadConfig() {
  try {
    renderConfig(await api("api/config"));
  } catch (error) {
    $("save-state").textContent = "Ошибка";
    $("save-state").className = "chip chip-error";
    showToast(error.message, "error");
  }
}

for (const button of $$(".nav-item")) {
  button.addEventListener("click", () => showPage(button.dataset.page));
}
for (const button of $$("[data-goto]")) {
  button.addEventListener("click", () => {
    showPage(button.dataset.goto);
    if (button.dataset.focus) {
      setTimeout(() => $(button.dataset.focus).focus(), 80);
    }
  });
}

$("menu").addEventListener("click", () => document.body.classList.add("sidebar-open"));
$("scrim").addEventListener("click", closeSidebar);
window.addEventListener("hashchange", () => showPage(location.hash.slice(1) || "overview", false));

for (const input of $$('input[name="provider"]')) {
  input.addEventListener("change", () => {
    applyProvider();
    setDirty(true);
    maybeAutoLoadModels();
  });
}

for (const button of $$("[data-reveal]")) {
  button.addEventListener("click", () => {
    const input = $(button.dataset.reveal);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-label", show ? "Скрыть" : "Показать");
  });
}

$("save-top").addEventListener("click", () => {
  save().catch(() => undefined);
});
$("refresh-openai").addEventListener("click", () => refreshModels("openai"));
$("refresh-gemini").addEventListener("click", () => refreshModels("gemini"));
$("mcp-add").addEventListener("click", () => {
  addMcpCard();
  updateMcpState();
  setDirty(true);
  $("mcp-list").lastElementChild?.querySelector('[data-field="name"]')?.focus();
});

$("ask").addEventListener("click", async () => {
  const text = $("ask-text").value.trim();
  if (!text) {
    showToast("Введите текст запроса", "error");
    return;
  }
  const button = $("ask");
  button.disabled = true;
  renderError($("ask-result"), "Думаю…");
  try {
    await save({ silent: true });
    const result = await api("api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, speak: $("ask-speak").checked }),
    });
    renderAskResult(result);
    setDirty(false);
  } catch (error) {
    renderError($("ask-result"), error.message);
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("pair").addEventListener("click", async () => {
  const pluginUrl = $("pair-url").value.trim() || $("plugin-url").value.trim();
  const code = $("pair-code").value.trim();
  if (!pluginUrl || !code) {
    renderError($("pair-result"), "Укажите URL плагина и код pairing.");
    return;
  }
  const button = $("pair");
  button.disabled = true;
  renderError($("pair-result"), "Привязываю…");
  try {
    const result = await api("api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginUrl, code }),
    });
    const next = await api("api/config");
    state.config = next;
    $("plugin-url").value = next.plugin.url;
    $("plugin-token").value = next.plugin.token;
    $("plugin-fingerprint").value = next.plugin.fingerprint || "—";
    $("pair-url").value = next.plugin.url;
    $("pair-code").value = "";
    $("pair-result").innerHTML = "";
    const message = document.createElement("p");
    message.className = "result-text";
    message.textContent = `Готово. Device ID: ${result.device_id}`;
    $("pair-result").appendChild(message);
    updateOverview();
    showToast("Колонка привязана");
  } catch (error) {
    renderError($("pair-result"), error.message);
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("form").addEventListener("input", () => {
  setDirty(true);
  updateOverview();
});
$("form").addEventListener("change", () => {
  setDirty(true);
  updateOverview();
});
$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  save().catch(() => undefined);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSidebar();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    save().catch(() => undefined);
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

const initialPage = location.hash.slice(1);
showPage(PAGES[initialPage] ? initialPage : "overview", false);
loadConfig().then(() => {
  if (PAGES[initialPage] && initialPage !== "overview") {
    setTimeout(() => showPage(initialPage, false), 0);
  }
  if (initialPage === "models") {
    setTimeout(maybeAutoLoadModels, 300);
  }
});
loadHealth();
setInterval(loadHealth, 30_000);
