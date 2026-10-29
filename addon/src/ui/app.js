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
  overview: { title: "Обзор", subtitle: "Настройки и состояние Hasar" },
  models: { title: "Модели", subtitle: "Провайдер, модели и поведение" },
  routing: { title: "Маршрутизация", subtitle: "Правила обработки запросов" },
  mcp: { title: "MCP", subtitle: "Подключённые серверы" },
  station: { title: "Колонка", subtitle: "Привязка и озвучивание" },
  debug: { title: "Отладка", subtitle: "Состояние плагина и журнал запросов" },
};

const ROUTE_LABELS = { assist: "Assist", chat: "LLM", "gemini-live": "Gemini Live" };
const SOURCE_LABELS = { station: "Колонка", debug: "Быстрый тест", api: "API" };

const state = {
  config: null,
  dirty: false,
  health: null,
  autoLoaded: { openai: false, gemini: false },
  ledCount: 6,
};

let toastTimer = null;
let saveStateTimer = null;

function api(path, options = {}) {
  return fetch(apiUrl(path), { cache: "no-store", ...options }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof data.error === "string" ? data.error : `${response.status} ${response.statusText}`);
    }
    return data;
  });
}

function showToast(message, type = "ok") {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast visible ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 3800);
}

function setDirty(value) {
  state.dirty = value;
  const button = $("save-top");
  const status = $("save-state");
  button.disabled = !value;
  button.title = value ? "" : "Нет изменений";
  clearTimeout(saveStateTimer);
  if (value) {
    status.textContent = "Не сохранено";
    status.className = "save-state dirty";
  } else {
    status.textContent = "";
    status.className = "save-state";
  }
}

function markSaved() {
  const status = $("save-state");
  clearTimeout(saveStateTimer);
  status.textContent = "Сохранено";
  status.className = "save-state saved";
  saveStateTimer = setTimeout(() => {
    if (!state.dirty) {
      status.textContent = "";
      status.className = "save-state";
    }
  }, 2400);
}

function checkedProvider() {
  return document.querySelector(".segmented [aria-pressed='true']")?.dataset.providerChoice || "openai";
}

function routingMode() {
  return document.querySelector('input[name="routing-mode"]:checked')?.value || "auto";
}

function fillSelect(select, models, selected) {
  const items = Array.isArray(models) ? models : [];
  select.replaceChildren();
  if (selected && !items.some((model) => model.id === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = `${selected} (текущая)`;
    select.appendChild(option);
  }
  for (const model of items) {
    if (!model || typeof model.id !== "string") continue;
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
    select.appendChild(option);
  }
  if (!items.length && !selected) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "— нажмите «Загрузить» —";
    select.appendChild(option);
  }
  if (selected && [...select.options].some((option) => option.value === selected)) select.value = selected;
}

function currentOptions(value) {
  return value ? [{ id: value, name: value }] : [];
}

function applyProvider() {
  const provider = checkedProvider();
  for (const button of $$("[data-provider-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.providerChoice === provider));
  }
  for (const panel of $$("[data-provider-card]")) {
    panel.classList.toggle("hidden", panel.dataset.providerCard !== provider);
  }
  updateOverview();
}

function updateOverview() {
  const provider = checkedProvider();
  const model = provider === "gemini" ? $("gemini-chat").value : $("openai-model").value;
  const live = $("gemini-live-enabled").checked && provider === "gemini";
  const route = routingMode();
  const pluginUrl = $("plugin-url").value.trim();
  const pluginToken = $("plugin-token").value.trim();
  const piperUrl = $("piper-url").value.trim();
  const linked = Boolean(pluginUrl && pluginToken);

  $("overview-provider").textContent = provider === "gemini" ? "Gemini" : "OpenAI";
  $("overview-model").textContent = model || "не выбрана";
  $("overview-route").textContent = route === "assist" ? "Только Assist" : route === "llm" ? "Только LLM" : "Auto";
  $("overview-station").textContent = linked ? "Привязана" : "Не привязана";

  $("state-mcp").textContent = $$(".mcp-entry").length ? serverCountLabel($$(".mcp-entry").length) : "не настроены";
  $("state-piper").textContent = piperUrl || "не настроен";
  $("state-live").textContent = live ? "включён" : "выключен";
  $("piper-status").textContent = piperUrl ? "Настроен" : "Не настроен";
  $("plugin-status").textContent = linked ? "Привязана" : "Не привязана";
  $("voice-plugin-status").textContent = linked ? "Колонка привязана" : "Колонка не привязана";
  $("voice-live-status").textContent = live
    ? "Ответы Gemini Live поступают в колонку напрямую."
    : "Ответы модели озвучиваются через Piper при включённой проверке.";

  $("pair-details").querySelector("summary").textContent = linked ? "Привязать заново" : "Привязка колонки";
}

function renderConfig(next) {
  state.config = next;
  for (const button of $$("[data-provider-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.providerChoice === next.provider));
  }
  $("openai-base").value = next.openai.baseUrl;
  $("openai-key").value = next.openai.apiKey;
  fillSelect($("openai-model"), currentOptions(next.openai.model), next.openai.model);
  $("gemini-base").value = next.gemini.baseUrl;
  $("gemini-key").value = next.gemini.apiKey;
  fillSelect($("gemini-chat"), currentOptions(next.gemini.chatModel), next.gemini.chatModel);
  fillSelect($("gemini-live"), currentOptions(next.gemini.liveModel), next.gemini.liveModel);
  $("gemini-live-enabled").checked = next.gemini.liveEnabled;
  const routeInput = document.querySelector(`input[name="routing-mode"][value="${next.routing.mode}"]`);
  if (routeInput) routeInput.checked = true;
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
  $("pair-details").open = !(next.plugin.url && next.plugin.token);
  renderMcp(next.mcpServers);
  applyProvider();
  setDirty(false);
}

function splitList(value) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function serverCountLabel(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} сервер`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} сервера`;
  return `${count} серверов`;
}

function modelCountLabel(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} модель`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} модели`;
  return `${count} моделей`;
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
      mode: routingMode(),
      sessionTimeoutSeconds: Number($("session-timeout").value) || 120,
      llmTriggers: splitList($("llm-triggers").value),
      intentAllowlist: splitList($("intent-allowlist").value),
    },
    piper: { url: $("piper-url").value.trim(), voice: $("piper-voice").value.trim() },
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
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Сохранение…";
  try {
    const saved = await api("api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectConfig()),
    });
    state.config = saved;
    // The API returns masks. Keep the inputs masked after a successful save.
    $("openai-key").value = saved.openai.apiKey;
    $("gemini-key").value = saved.gemini.apiKey;
    $("plugin-token").value = saved.plugin.token;
    $("socks5").value = saved.proxy.socks5;
    renderMcp(saved.mcpServers);
    $("mcp-error").textContent = "";
    setDirty(false);
    markSaved();
    updateOverview();
    return saved;
  } catch (error) {
    if (!silent) showToast(error.message, "error");
    throw error;
  } finally {
    button.disabled = !state.dirty;
    button.textContent = label;
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
        openai: { baseUrl: $("openai-base").value.trim(), apiKey: $("openai-key").value },
        gemini: { baseUrl: $("gemini-base").value.trim(), apiKey: $("gemini-key").value },
      }),
    });
    const chatModels = Array.isArray(data.chat) ? data.chat : [];
    const liveModels = Array.isArray(data.live) ? data.live : [];
    fillSelect(chatSelect, chatModels, previous);
    const liveSelect = isGemini ? $("gemini-live") : null;
    const previousLive = liveSelect?.value;
    if (liveSelect) fillSelect(liveSelect, liveModels, previousLive);
    const count = isGemini ? `${chatModels.length} chat · ${liveModels.length} live` : modelCountLabel(chatModels.length);
    countNode.textContent = count;
    if (chatSelect.value !== previous || (liveSelect && liveSelect.value !== previousLive)) setDirty(true);
    updateOverview();
  } catch (error) {
    errorNode.textContent = error.message;
    countNode.textContent = "Не удалось загрузить модели.";
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
  if (provider === "openai" && !$("openai-key").value && $("openai-base").value.includes("api.openai.com")) return;
  state.autoLoaded[provider] = true;
  refreshModels(provider, { quiet: true });
}

function renderMcp(servers) {
  const list = $("mcp-list");
  list.replaceChildren();
  for (const server of Array.isArray(servers) ? servers : []) addMcpCard(server);
  updateMcpState();
}

function addMcpCard(server = {}) {
  const template = $("mcp-template");
  const card = template.content.firstElementChild.cloneNode(true);
  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  field("enabled").checked = server.enabled !== false;
  field("name").value = server.name || `server-${$$(".mcp-entry").length + 1}`;
  field("transport").value = server.transport || "http";
  field("url").value = server.url || "";
  field("command").value = server.command || "";
  field("args").value = Array.isArray(server.args) ? server.args.join(", ") : "";
  field("headers").value = Object.entries(server.headers || {}).map(([key, value]) => `${key}: ${value}`).join("\n");

  const sync = () => {
    const stdio = field("transport").value === "stdio";
    for (const row of card.querySelectorAll('[data-row="url"], [data-row="headers"]')) row.classList.toggle("hidden", stdio);
    for (const row of card.querySelectorAll('[data-row="command"], [data-row="args"]')) row.classList.toggle("hidden", !stdio);
  };
  field("transport").addEventListener("change", () => { sync(); setDirty(true); });
  card.querySelector("[data-remove]").addEventListener("click", () => {
    card.remove();
    updateMcpState();
    setDirty(true);
  });
  sync();
  $("mcp-list").appendChild(card);
}

function updateMcpState() {
  const count = $$(".mcp-entry").length;
  $("mcp-empty").classList.toggle("hidden", count > 0);
  $("mcp-count").textContent = serverCountLabel(count);
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
  return $$(".mcp-entry").map((card) => {
    const field = (name) => card.querySelector(`[data-field="${name}"]`);
    const name = field("name").value.trim();
    const transport = field("transport").value;
    const enabled = field("enabled").checked;
    if (!name) throw new Error("У каждого MCP-сервера должно быть имя.");
    const url = field("url").value.trim();
    const command = field("command").value.trim();
    if (enabled && transport !== "stdio" && !url) throw new Error(`MCP «${name}»: укажите URL.`);
    if (enabled && transport === "stdio" && !command) throw new Error(`MCP «${name}»: укажите команду.`);
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
  node.replaceChildren();
  const meta = document.createElement("div");
  meta.className = "result-meta";
  const audioLabels = { played: "Аудио отправлено", skipped: "Без озвучки", failed: "Ошибка аудио" };
  const addMeta = (text, className = "") => {
    const item = document.createElement("span");
    item.textContent = text;
    if (className) item.className = className;
    meta.appendChild(item);
  };
  addMeta(`Маршрут: ${ROUTE_LABELS[result.route] || result.route || "—"}`);
  if (result.intent) addMeta(`Intent: ${result.intent}`);
  if (result.audio) addMeta(audioLabels[result.audio] || `Аудио: ${result.audio}`, result.audio === "failed" ? "result-meta-error" : "");
  const text = document.createElement("p");
  text.className = "result-text";
  text.textContent = result.text || "(пустой ответ)";
  node.append(meta, text);
}

function renderError(node, message) {
  node.replaceChildren();
  const text = document.createElement("p");
  text.className = "result-text result-error";
  text.textContent = message;
  node.appendChild(text);
}

function showPage(name, updateHash = true) {
  const page = name === "voice" ? "station" : PAGES[name] ? name : "overview";
  for (const panel of $$("[data-page-panel]")) panel.classList.toggle("active", panel.dataset.pagePanel === page);
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
  if (page === "models") setTimeout(maybeAutoLoadModels, 180);
  if (page === "debug") {
    loadPluginStatus();
    loadDebugLog();
  }
}

function closeSidebar({ focusMenu = false } = {}) {
  document.body.classList.remove("sidebar-open");
  $("menu").setAttribute("aria-expanded", "false");
  $("menu").setAttribute("aria-label", "Открыть меню");
  if (focusMenu) $("menu").focus();
}

async function loadHealth() {
  try {
    state.health = await api("health");
    $("conn-dot").className = "dot ok";
    $("conn-text").textContent = `Add-on ${state.health.version || "на связи"}`;
  } catch {
    state.health = null;
    $("conn-dot").className = "dot error";
    $("conn-text").textContent = "Нет связи";
  }
  updateOverview();
}

async function loadConfig() {
  try {
    renderConfig(await api("api/config"));
  } catch (error) {
    $("save-state").textContent = "Ошибка загрузки";
    $("save-state").className = "save-state error";
    showToast(error.message, "error");
  }
}

function textValue(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (Array.isArray(value)) return value.map((item) => textValue(item, "")).filter(Boolean).join(", ") || fallback;
  if (typeof value === "object") return "Данные доступны";
  return String(value);
}

function renderPluginStatus(data) {
  const info = data?.info && typeof data.info === "object" ? data.info : {};
  const pluginState = data?.state && typeof data.state === "object" ? data.state : {};
  const model = info.model ?? info.modelName ?? pluginState.model ?? pluginState.modelName;
  const features = info.features ?? pluginState.features;
  const count = Number(data?.ledCount ?? info.ledCount ?? state.ledCount);
  state.ledCount = Number.isFinite(count) ? Math.max(1, Math.min(24, Math.floor(count))) : 6;
  const pairingOpen = pluginState.pairing_open ?? info.pairing_open;
  const playback = pluginState.playback;
  const playing = playback && typeof playback === "object" ? playback.playing : undefined;
  const entries = [
    ["Модель", textValue(model)],
    ["Features", Array.isArray(features)
      ? textValue(features)
      : features && typeof features === "object"
        ? Object.entries(features).map(([name, enabled]) => `${name}: ${textValue(enabled)}`).join(", ") || "—"
        : textValue(features)],
    ["LED", String(state.ledCount)],
    ["Код pairing", pairingOpen === true ? "Открыт" : pairingOpen === false ? "Закрыт" : "—"],
    ["Воспроизведение", playing === true ? "Играет" : playing === false ? "Остановлено" : "—"],
  ];
  const list = $("debug-plugin-status");
  list.replaceChildren();
  for (const [label, value] of entries) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    list.appendChild(row);
  }
  renderLedColors(state.ledCount);
}

async function loadPluginStatus() {
  const errorNode = $("debug-plugin-error");
  errorNode.textContent = "";
  try {
    renderPluginStatus(await api("api/debug/plugin"));
  } catch (error) {
    errorNode.textContent = error.message;
    const list = $("debug-plugin-status");
    list.replaceChildren();
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = "Состояние";
    description.textContent = "Не удалось получить данные";
    row.append(term, description);
    list.appendChild(row);
  }
}

function renderLedColors(count) {
  const host = $("led-colors");
  const previous = $$("input[type='color']", host).map((input) => input.value);
  host.replaceChildren();
  host.className = "full color-list";
  for (let index = 0; index < count; index += 1) {
    const label = document.createElement("label");
    label.className = "color-field";
    label.textContent = `LED ${index + 1}`;
    const input = document.createElement("input");
    input.type = "color";
    input.value = previous[index] || "#087bb8";
    input.setAttribute("aria-label", `Цвет LED ${index + 1}`);
    label.appendChild(input);
    host.appendChild(label);
  }
  syncLedPreset();
}

function syncLedPreset() {
  const off = $("led-preset").value === "off";
  $("led-colors").classList.toggle("hidden", off);
}

function setInlineStatus(id, message, kind = "") {
  const node = $(id);
  node.textContent = message;
  node.className = `inline-status${kind ? ` ${kind}-text` : ""}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scaleColor(hex, factor) {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((index) => {
    const channel = Number.parseInt(value.slice(index, index + 2), 16);
    return Math.max(0, Math.min(255, Math.round(channel * factor)));
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

async function postLed(colors) {
  await api("api/debug/led", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ colors }),
  });
}

async function sendLed() {
  const button = $("led-send");
  const preset = $("led-preset").value;
  button.disabled = true;
  setInlineStatus("led-result", "Отправка…");
  try {
    if (preset === "off") {
      await api("api/debug/led/off", { method: "POST" });
    } else {
      const colors = $$("input[type='color']", $("led-colors")).map((input) => input.value.toUpperCase());
      if (preset === "pulse") {
        const base = colors[0] || "#087BB8";
        for (const factor of [1, 0.55, 0.2, 0.55, 1]) {
          await postLed(Array(state.ledCount).fill(scaleColor(base, factor)));
          await sleep(140);
        }
      } else if (preset === "rainbow") {
        const palette = ["#FF0000", "#FF7F00", "#FFFF00", "#00C853", "#00B0FF", "#651FFF", "#D500F9"];
        for (let step = 0; step < 7; step += 1) {
          await postLed(Array.from({ length: state.ledCount }, (_, index) => palette[(index + step) % palette.length]));
          await sleep(140);
        }
      } else {
        await postLed(colors);
      }
    }
    setInlineStatus("led-result", "Отправлено", "ok");
  } catch (error) {
    setInlineStatus("led-result", error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function sendClock(off = false) {
  const button = off ? $("clock-off") : $("clock-send");
  button.disabled = true;
  setInlineStatus("clock-result", "Отправка…");
  try {
    const body = off
      ? { off: true }
      : { time: $("clock-time").value, brightness: Number($("clock-brightness").value) };
    if (!off && !/^\d{2}:\d{2}$/.test(body.time)) throw new Error("Укажите время.");
    await api("api/debug/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setInlineStatus("clock-result", off ? "Часы выключены" : "Отправлено", "ok");
  } catch (error) {
    setInlineStatus("clock-result", error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function eventTime(event) {
  const value = event.time ?? event.timestamp ?? event.createdAt ?? event.at;
  if (typeof value === "number") return new Date(value).toLocaleString("ru-RU");
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString("ru-RU");
  }
  return "Время неизвестно";
}

function renderDebugLog(events) {
  const host = $("log-list");
  host.replaceChildren();
  const rows = Array.isArray(events) ? events : [];
  $("log-empty").classList.toggle("hidden", rows.length > 0);
  for (const event of rows) {
    const article = document.createElement("article");
    article.className = "log-event";
    const head = document.createElement("div");
    head.className = "log-event-head";
    const time = document.createElement("span");
    time.textContent = eventTime(event || {});
    const source = document.createElement("strong");
    source.textContent = SOURCE_LABELS[event?.source] || textValue(event?.source, "Источник неизвестен");
    head.append(time, source);
    article.appendChild(head);

    const textValueNode = document.createElement("p");
    textValueNode.className = "log-event-text";
    textValueNode.textContent = textValue(event?.text, "(без текста)");
    article.appendChild(textValueNode);

    const metadata = document.createElement("div");
    metadata.className = "log-event-meta";
    const fields = [
      ["Маршрут", event?.route ? ROUTE_LABELS[event.route] || event.route : null],
      ["Модель", event?.model],
      ["Время ответа", event?.durationMs === null || event?.durationMs === undefined ? null : `${event.durationMs} мс`],
    ];
    for (const [label, value] of fields) {
      if (value === null || value === undefined || value === "") continue;
      const item = document.createElement("span");
      item.textContent = `${label}: ${textValue(value)}`;
      metadata.appendChild(item);
    }
    if (metadata.childNodes.length) article.appendChild(metadata);
    if (event?.error) {
      const error = document.createElement("div");
      error.className = "log-event-error";
      error.textContent = `Ошибка: ${textValue(event.error)}`;
      article.appendChild(error);
    }
    host.appendChild(article);
  }
}

async function loadDebugLog() {
  const errorNode = $("debug-log-error");
  errorNode.textContent = "";
  try {
    const data = await api("api/debug/log");
    renderDebugLog(data?.events);
  } catch (error) {
    errorNode.textContent = error.message;
    renderDebugLog([]);
    $("log-empty").classList.add("hidden");
  }
}

for (const button of $$(".nav-item")) button.addEventListener("click", () => showPage(button.dataset.page));
for (const button of $$('[data-goto]')) {
  button.addEventListener("click", () => {
    showPage(button.dataset.goto);
    if (button.dataset.focus) setTimeout(() => $(button.dataset.focus).focus(), 80);
  });
}

$("menu").addEventListener("click", () => {
  document.body.classList.add("sidebar-open");
  $("menu").setAttribute("aria-expanded", "true");
  $("menu").setAttribute("aria-label", "Закрыть меню");
});
$("scrim").addEventListener("click", () => closeSidebar({ focusMenu: true }));
window.addEventListener("hashchange", () => showPage(location.hash.slice(1) || "overview", false));

for (const button of $$("[data-provider-choice]")) {
  button.addEventListener("click", () => {
    if (button.dataset.providerChoice === checkedProvider()) return;
    for (const choice of $$("[data-provider-choice]")) choice.setAttribute("aria-pressed", String(choice === button));
    applyProvider();
    setDirty(true);
    maybeAutoLoadModels();
  });
}

for (const button of $$('[data-reveal]')) {
  button.addEventListener("click", () => {
    const input = $(button.dataset.reveal);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-label", show ? "Скрыть" : "Показать");
  });
}

$("save-top").addEventListener("click", () => save().catch(() => undefined));
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
  renderError($("ask-result"), "Выполняю запрос…");
  try {
    if (state.dirty) await save({ silent: true });
    const result = await api("api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, speak: $("ask-speak").checked, source: "debug" }),
    });
    renderAskResult(result);
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
  renderError($("pair-result"), "Выполняется привязка…");
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
    $("pair-details").open = false;
    $("pair-result").replaceChildren();
    const message = document.createElement("p");
    message.className = "result-text";
    message.textContent = `Готово. Device ID: ${textValue(result.device_id, "—")}`;
    $("pair-result").appendChild(message);
    updateOverview();
  } catch (error) {
    renderError($("pair-result"), error.message);
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

for (const input of [$("pair-url"), $("pair-code")]) {
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $("pair").click();
  });
}

$("plugin-refresh").addEventListener("click", loadPluginStatus);
$("log-refresh").addEventListener("click", loadDebugLog);
$("led-preset").addEventListener("change", syncLedPreset);
$("led-send").addEventListener("click", sendLed);
$("clock-send").addEventListener("click", () => sendClock(false));
$("clock-off").addEventListener("click", () => sendClock(true));
$("clock-brightness").addEventListener("input", () => { $("clock-brightness-value").textContent = $("clock-brightness").value; });
$("cancel-playback").addEventListener("click", async () => {
  const button = $("cancel-playback");
  button.disabled = true;
  setInlineStatus("cancel-result", "Отправка…");
  try {
    await api("api/debug/cancel", { method: "POST" });
    setInlineStatus("cancel-result", "Отправлено", "ok");
  } catch (error) {
    setInlineStatus("cancel-result", error.message, "error");
  } finally {
    button.disabled = false;
  }
});

function trackConfigChange(event) {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest(".quick-ask") || event.target.closest("#pair-details")) return;
  setDirty(true);
  updateOverview();
}

$("form").addEventListener("input", trackConfigChange);
$("form").addEventListener("change", trackConfigChange);
$("form").addEventListener("submit", (event) => { event.preventDefault(); save().catch(() => undefined); });

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSidebar({ focusMenu: true });
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (state.dirty) save().catch(() => undefined);
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

const initialPage = location.hash.slice(1) === "voice" ? "station" : location.hash.slice(1);
renderLedColors(state.ledCount);
showPage(PAGES[initialPage] ? initialPage : "overview", false);
loadConfig().then(() => {
  if (PAGES[initialPage] && initialPage !== "overview") setTimeout(() => showPage(initialPage, false), 0);
  if (initialPage === "models") setTimeout(maybeAutoLoadModels, 250);
});
loadHealth();
setInterval(loadHealth, 30_000);
