import {
  COLLECTION_THRESHOLD_METERS,
  distanceMeters,
} from "/app/geo.js";
import { ForegroundLocationTracker, toApiLocation } from "/app/location.js";
import { adminCapabilities as getAdminCapabilities } from "/app/admin-access.js";
import { activityTimeToIso } from "/app/time.js";
import { waitForAuthHandoff } from "/app/auth-handoff.js";

const state = {
  role: "",
  loginRole: "player",
  player: null,
  games: [],
  game: null,
  progress: null,
  leaderboard: [],
  treasures: [],
  adminGames: [],
  adminGame: null,
  adminTreasures: [],
  adminProfile: null,
  adminAccess: null,
  pendingProgressResetRestoreId: null,
  map: null,
  playerMap: null,
  adminMap: null,
  mapPromise: null,
  playerMarkers: [],
  adminMarkers: [],
  importMarkers: [],
  latestPosition: null,
  locationTracker: null,
  heartbeatTimer: null,
  heartbeatInFlight: false,
  handlingHeartbeatExpiry: false,
  importData: null,
  importPreview: [],
  editingTreasureId: null,
};

let playerVerificationRefresh;
const playerAuthChannel = "BroadcastChannel" in window
  ? new BroadcastChannel("lbs-player-auth")
  : null;
let adminVerificationRefresh;
const adminAuthChannel = "BroadcastChannel" in window
  ? new BroadcastChannel("lbs-admin-auth")
  : null;

async function refreshPlayerAfterEmailVerification() {
  if (playerVerificationRefresh) return playerVerificationRefresh;
  playerVerificationRefresh = (async () => {
    try {
      await loadPlayerHome();
      announce("Email 已確認，已返回原本的尋寶頁面。");
    } catch {
      // 另一個分頁可能在登入 Cookie 寫入前先送出通知。
    }
  })().finally(() => {
    playerVerificationRefresh = null;
  });
  return playerVerificationRefresh;
}

playerAuthChannel?.addEventListener("message", (event) => {
  if (event.data?.type === "player-authenticated") {
    void refreshPlayerAfterEmailVerification();
  }
});
async function refreshAdminAfterEmailVerification() {
  if (adminVerificationRefresh) return adminVerificationRefresh;
  adminVerificationRefresh = (async () => {
    try {
      await loadAdminWorkspace();
      announce("Email 已確認，已返回管理工作區。");
    } catch {
      // 不同瀏覽器設定檔不共用登入 Cookie；確認頁會在自己的頁面開啟工作區。
    }
  })().finally(() => {
    adminVerificationRefresh = null;
  });
  return adminVerificationRefresh;
}

adminAuthChannel?.addEventListener("message", (event) => {
  if (event.data?.type === "admin-authenticated") {
    void refreshAdminAfterEmailVerification();
  }
});
window.addEventListener("storage", (event) => {
  if (event.key === "lbs-player-authenticated") {
    void refreshPlayerAfterEmailVerification();
  }
  if (event.key === "lbs-admin-authenticated") {
    void refreshAdminAfterEmailVerification();
  }
});

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const page = {
  auth: $("#auth-view"),
  player: $("#player-view"),
  hunt: $("#hunt-view"),
  admin: $("#admin-view"),
};

function showPage(name) {
  for (const [key, element] of Object.entries(page)) element.hidden = key !== name;
  $("#account-bar").hidden = name === "auth";
}

function announce(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(announce.timer);
  announce.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

async function api(path, options = {}) {
  const { headers: requestHeaders, ...requestOptions } = options;
  const response = await fetch(path, {
    ...requestOptions,
    credentials: "same-origin",
    headers: {
      ...(requestOptions.body ? { "content-type": "application/json" } : {}),
      ...requestHeaders,
    },
  });
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const message = await response.text();
    throw new Error(message || "伺服器回傳無法辨識的回應。");
  }
  const body = await response.json();
  const requestToken = response.headers.get("X-Auth-Request-Token");
  if (requestToken) body.requestToken = requestToken;
  if (!response.ok) {
    const error = new Error(body.message || body.error || "服務暫時無法完成要求。");
    error.status = response.status;
    error.code = body.code || body.error;
    error.details = body;
    throw error;
  }
  return body;
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function setText(selector, value) {
  $(selector).textContent = value ?? "";
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function dateLabel(value, timezone) {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone || undefined,
  }).format(new Date(value));
}

function gameStatusLabel(status) {
  return ({
    active: "進行中",
    published: "已發布",
    scheduled: "即將開始",
    paused: "暫停中",
    ended: "已結束",
    archived: "封存中",
    draft: "草稿",
  })[status] || status;
}

function playerGameIsAvailable(game) {
  return game.status === "active";
}

function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = label;
    return;
  }
  button.disabled = false;
  button.textContent = button.dataset.originalLabel || button.textContent;
  delete button.dataset.originalLabel;
}

function showLoginError(message = "") {
  setText("#auth-error", message);
}

function setLoginRole(role) {
  state.loginRole = role;
  for (const [button, active] of [
    [$("#player-login-tab"), role === "player"],
    [$("#admin-login-tab"), role === "admin"],
  ]) {
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  $("#magic-link-submit").textContent = role === "admin" ? "管理員登入" : "登入";
  $("#magic-link-submit").dataset.originalLabel = $("#magic-link-submit").textContent;
  $("#trusted-device-login").textContent = role === "admin"
    ? "以信任的管理員裝置登入"
    : "使用已信任裝置登入";
  $("#trusted-device-login").hidden = role !== "admin";
  $("#auth-message").textContent = "";
  showLoginError();
}

async function continueWithTrustedDevice() {
  const button = $("#trusted-device-login");
  setBusy(button, true, "正在登入…");
  try {
    if (state.loginRole === "admin") {
      await api("/admin/auth/device-login", { method: "POST" });
      await loadAdminWorkspace();
    } else {
      await api("/auth/device-login", { method: "POST" });
      await loadPlayerHome();
    }
  } catch (error) {
    showLoginError(error.message);
  } finally {
    setBusy(button, false);
  }
}

async function submitMagicLink(event) {
  event.preventDefault();
  showLoginError();
  $("#auth-message").textContent = "";
  const button = $("#magic-link-submit");
  setBusy(button, true, "寄送中…");
  try {
    const email = $("#login-email").value.trim();
    const endpoint = state.loginRole === "admin"
      ? "/admin/auth/magic-links"
      : "/auth/magic-links";
    const result = await api(endpoint, {
      method: "POST",
      body: jsonBody({
        email,
        trustDevice: $("#trust-device-after-login").checked,
      }),
    });
    if (result.trustedDevice) {
      if (state.loginRole === "admin") {
        await api("/admin/auth/device-login", { method: "POST" });
        await loadAdminWorkspace();
      } else {
        await api("/auth/device-login", { method: "POST" });
        await loadPlayerHome();
      }
      return;
    }
    if (result.requestToken) {
      const expiresAt = Date.now() + 3 * 60 * 1000;
      $("#auth-message").textContent = "請在 3 分鐘內確認 Email 中的登入連結；確認後本頁會自動登入。";
      await waitForAuthHandoff({
        api,
        requestToken: result.requestToken,
        expiresAt,
        enterMode: async (role) => {
          if (role === "admin") await loadAdminWorkspace();
          else await loadPlayerHome();
        },
        onRetry: () => {
          $("#auth-message").textContent = "登入頁正在重新連線，請保持此頁開啟；核准後會自動進入遊戲。";
        },
      });
      return;
    }
    $("#auth-message").textContent = state.loginRole === "admin"
      ? result.message
      : `${result.message} 首次使用或更換裝置時才需要確認；請在此瀏覽器開啟信中的連結，原頁會自動繼續。`;
  } catch (error) {
    if (error.code === "AUTH_HANDOFF_EXPIRED") {
      showLoginError();
      $("#auth-message").textContent = "已逾時，請確認 Email 地址是否正確。";
    } else if (error.code === "PLAYER_SESSION_ACTIVE") {
      showLoginError(error.message);
    } else {
      showLoginError(error.message);
    }
  } finally {
    setBusy(button, false);
  }
}

async function loadPlayerHome() {
  const { player } = await api("/auth/me");
  const [{ games }, { leaderboard }] = await Promise.all([
    api("/games"),
    api("/leaderboard"),
  ]);
  state.role = "player";
  state.player = player;
  state.games = games;
  state.leaderboard = leaderboard;
  $("#account-label").textContent = player.nickname || player.anonymousCode;
  setText("#history-total", player.totalCollectedSoFar);
  $("#nickname").value = player.nickname || "";
  $("#leaderboard-visible").checked = player.leaderboardVisible;
  setText("#available-games", games.filter(playerGameIsAvailable).length);
  renderGameCards();
  renderLeaderboard();
  const currentGame = games.find(
    (game) => game.id === player.currentGameId && game.status === "active",
  );
  if (currentGame) {
    await api(`/games/${encodeURIComponent(currentGame.id)}/join`, {
      method: "POST",
    });
    state.game = currentGame;
    state.latestPosition = null;
    localStorage.setItem("lbs_current_game", currentGame.id);
    localStorage.setItem("lbs_current_game_status", "playing");
    await loadGameProgress();
    showPage("hunt");
    startPlayerGameHeartbeat();
    startLocationTracking();
    await ensurePlayerMap();
    return;
  }
  showPage("player");
}

function renderGameCards() {
  const list = $("#player-games");
  list.replaceChildren();
  $("#player-empty").hidden = state.games.length > 0;
  for (const game of state.games) {
    const card = makeElement("article", "game-card");
    const top = makeElement("div", "game-card-top");
    const status = makeElement("span", `status-pill status-${game.status}`, gameStatusLabel(game.status));
    top.append(makeElement("span", "game-symbol", "✦"), status);
    card.append(top);
    card.append(makeElement("h3", "", game.name));
    card.append(makeElement("p", "game-description", game.description || "跟著地圖探索，尋找藏在附近的驚喜。"));
    const date = makeElement("p", "game-date", `${dateLabel(game.startsAt, game.timezone)} – ${dateLabel(game.endsAt, game.timezone)}`);
    card.append(date);
    const foot = makeElement("div", "game-card-foot");
    foot.append(makeElement("span", "muted", `${game.totalTreasuresCount} 個目標`));
    const join = makeElement("button", "button button-primary", game.status === "active" ? "開始探索" : "尚未開放");
    join.type = "button";
    join.disabled = !playerGameIsAvailable(game);
    join.addEventListener("click", () => joinGame(game, join));
    foot.append(join);
    card.append(foot);
    list.append(card);
  }
}

function renderLeaderboard() {
  const list = $("#leaderboard");
  list.replaceChildren();
  $("#leaderboard-empty").hidden = state.leaderboard.length > 0;
  for (const entry of state.leaderboard.slice(0, 3)) {
    const row = makeElement("article", "leaderboard-row");
    const medal = makeElement("span", `rank rank-${entry.rank}`, String(entry.rank).padStart(2, "0"));
    const identity = makeElement("div", "leaderboard-identity");
    identity.append(
      makeElement("strong", "", entry.displayName),
      makeElement("span", "muted", `完成 ${entry.completedGames} 場遊戲`),
    );
    row.append(medal, identity, makeElement("strong", "leaderboard-score", `${entry.totalCollected} 個`));
    list.append(row);
  }
}

async function loadProfileAndGames() {
  $("#player-error").textContent = "";
  try {
    const [{ player }, { games }, { leaderboard }] = await Promise.all([
      api("/auth/me"),
      api("/games"),
      api("/leaderboard"),
    ]);
    state.player = player;
    state.games = games;
    state.leaderboard = leaderboard;
    $("#account-label").textContent = player.nickname || player.anonymousCode;
    setText("#history-total", player.totalCollectedSoFar);
    $("#nickname").value = player.nickname || "";
    $("#leaderboard-visible").checked = player.leaderboardVisible;
    setText("#available-games", games.filter(playerGameIsAvailable).length);
    renderGameCards();
    renderLeaderboard();
  } catch (error) {
    $("#player-error").textContent = error.message;
  }
}

async function joinGame(game, button) {
  $("#player-error").textContent = "";
  const currentGameId = localStorage.getItem("lbs_current_game");
  const currentGameStatus = localStorage.getItem("lbs_current_game_status");
  if (currentGameId && currentGameId !== game.id && currentGameStatus === "playing") {
    try {
      await api(`/games/${encodeURIComponent(currentGameId)}/pause`, { method: "POST" });
      localStorage.setItem("lbs_current_game_status", "paused");
    } catch (error) {
      $("#player-error").textContent = `切換遊戲前無法暫停目前場次：${error.message}`;
      return;
    }
  }
  setBusy(button, true, "正在進入…");
  try {
    await api(`/games/${encodeURIComponent(game.id)}/join`, { method: "POST" });
    state.game = game;
    localStorage.setItem("lbs_current_game", game.id);
    localStorage.setItem("lbs_current_game_status", "playing");
    await loadGameProgress();
    startPlayerGameHeartbeat();
    await startLocationTracking();
    showPage("hunt");
    await ensurePlayerMap();
    announce(`已進入「${game.name}」，祝你探索愉快！`);
  } catch (error) {
    $("#player-error").textContent = error.message;
    setBusy(button, false);
  }
}

async function loadGameProgress() {
  const progress = await api(`/games/${encodeURIComponent(state.game.id)}/progress`);
  state.progress = progress;
  setText("#collected-count", progress.collectedCount);
  setText("#target-count", progress.targetTreasureCount);
  setText("#hunt-total", progress.totalCollectedSoFar);
  setText("#active-game-name", state.game.name);
  setText("#history-total", progress.totalCollectedSoFar);
}

async function ensureMapsLoaded() {
  if (state.mapPromise) return state.mapPromise;
  const key = window.LBS_CONFIG?.googleMapsApiKey;
  if (!key) throw new Error("尚未設定 Google Maps API 金鑰。請在 .env 設定 GOOGLE_MAPS_API_KEY，並限制金鑰的網站 referrer。");
  state.mapPromise = new Promise((resolve, reject) => {
    const callbackName = "__lbsMapsLoaded";
    window[callbackName] = () => {
      delete window[callbackName];
      resolve(window.google.maps);
    };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=${callbackName}&loading=async`;
    script.async = true;
    script.onerror = () => reject(new Error("Google 地圖載入失敗，請檢查 API 金鑰、referrer 限制與網路連線。"));
    document.head.append(script);
  });
  return state.mapPromise;
}

async function ensurePlayerMap() {
  $("#player-map-message").textContent = "";
  try {
    await ensureMapsLoaded();
    if (state.playerMap) {
      state.playerMap.setCenter({
        lat: state.game.mapCenter.latitude,
        lng: state.game.mapCenter.longitude,
      });
      return;
    }
    state.playerMap = new google.maps.Map($("#player-map"), {
      center: { lat: state.game.mapCenter.latitude, lng: state.game.mapCenter.longitude },
      zoom: 16,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      clickableIcons: false,
    });
  } catch (error) {
    $("#player-map-message").textContent = error.message;
  }
}

function stopLocationTracking() {
  state.locationTracker?.stop();
  state.locationTracker = null;
}

function stopPlayerGameHeartbeat() {
  if (state.heartbeatTimer !== null) window.clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

async function sendPlayerGameHeartbeat() {
  if (
    state.heartbeatInFlight ||
    state.role !== "player" ||
    !state.game
  ) {
    return;
  }
  state.heartbeatInFlight = true;
  const gameId = state.game.id;
  try {
    await api(`/games/${encodeURIComponent(gameId)}/heartbeat`, { method: "POST" });
  } catch (error) {
    if (error.status === 409 && state.game?.id === gameId && !state.handlingHeartbeatExpiry) {
      state.handlingHeartbeatExpiry = true;
      stopPlayerGameHeartbeat();
      stopLocationTracking();
      if (state.userMarker) state.userMarker.setMap(null);
      state.userMarker = null;
      state.latestPosition = null;
      state.game = null;
      state.treasures = [];
      localStorage.setItem("lbs_current_game_status", "paused");
      await loadProfileAndGames();
      showPage("player");
      announce("遊戲回合已暫停，請重新選擇遊戲以開始新回合。");
      state.handlingHeartbeatExpiry = false;
    } else if (error.status === 401) {
      stopPlayerGameHeartbeat();
      stopLocationTracking();
      showPage("auth");
      showLoginError("登入已失效，請重新登入後繼續。");
    }
  } finally {
    state.heartbeatInFlight = false;
  }
}

function startPlayerGameHeartbeat() {
  stopPlayerGameHeartbeat();
  if (state.role !== "player" || !state.game) return;
  void sendPlayerGameHeartbeat();
  state.heartbeatTimer = window.setInterval(() => {
    void sendPlayerGameHeartbeat();
  }, 30 * 1000);
}

function startLocationTracking() {
  stopLocationTracking();
  if (!navigator.geolocation) {
    setText("#location-status", "此裝置不支援定位");
    return;
  }
  setText("#location-status", document.hidden ? "背景中，定位已暫停" : "正在取得前景定位…");
  state.locationTracker = new ForegroundLocationTracker({
    geolocation: navigator.geolocation,
    visibility: document,
    onLocation: onPosition,
    onLocationReport: reportPlayerLocation,
    onPaused: () => {
      if (state.userMarker) state.userMarker.setMap(null);
      state.userMarker = null;
      setText("#location-status", "背景中，定位已暫停");
    },
    onError: (error) => {
      setText("#location-status", error.code === error.PERMISSION_DENIED ? "定位權限遭拒" : "暫時無法取得定位");
      $("#hunt-error").textContent = error.code === error.PERMISSION_DENIED
        ? "請在瀏覽器設定允許此網站使用定位，再重新進入遊戲。"
        : error.message;
    },
  });
  state.locationTracker.start();
}

function onPosition(location) {
  if (document.hidden || state.role !== "player" || !state.game) return;
  state.latestPosition = toApiLocation(location);
  const accuracy = Math.round(location.accuracy);
  setText("#location-status", `定位精度約 ${accuracy} 公尺`);
  $("#accuracy-warning").hidden = location.accuracy <= 50;
  if (state.playerMap) {
    if (!state.userMarker) {
      state.userMarker = new google.maps.Marker({
        map: state.playerMap,
        position: { lat: location.latitude, lng: location.longitude },
        title: "你的位置",
        zIndex: 1000,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: "#477a53",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 3,
        },
      });
    } else {
      state.userMarker.setPosition({ lat: location.latitude, lng: location.longitude });
    }
  }
}

async function reportPlayerLocation(location) {
  if (document.hidden || state.role !== "player" || !state.game) return;
  try {
    const { treasures } = await api(`/games/${encodeURIComponent(state.game.id)}/location`, {
      method: "POST",
      body: jsonBody(toApiLocation(location)),
    });
    state.treasures = treasures;
    renderPlayerTreasures();
  } catch (error) {
    if (error.status === 401) {
      stopLocationTracking();
      showPage("auth");
      showLoginError("登入工作階段已失效，請重新登入。");
    } else {
      $("#hunt-error").textContent = error.message;
    }
  }
}

function clearMarkers(markers) {
  markers.forEach((marker) => marker.setMap(null));
  markers.length = 0;
}

function renderPlayerTreasures() {
  const list = $("#nearby-treasures");
  list.replaceChildren();
  clearMarkers(state.playerMarkers);
  const collected = new Set(state.progress?.collectedTreasureIds || []);
  for (const treasure of state.treasures) {
    const center = treasure.fuzzyCenter;
    if (state.playerMap && center) {
      state.playerMarkers.push(new google.maps.Circle({
        map: state.playerMap,
        center: { lat: center.latitude, lng: center.longitude },
        radius: treasure.fuzzyRadiusMeters,
        fillColor: treasure.inFuzzyZone ? "#477a53" : "#87a68a",
        fillOpacity: 0.12,
        strokeColor: treasure.inFuzzyZone ? "#477a53" : "#87a68a",
        strokeOpacity: 0.5,
        strokeWeight: 1,
      }));
    }
    const precise = treasure.preciseLocation;
    if (state.playerMap && precise) {
      const marker = new google.maps.Marker({
        map: state.playerMap,
        position: { lat: precise.latitude, lng: precise.longitude },
        title: treasure.title,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 9,
          fillColor: "#477a53",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });
      state.playerMarkers.push(marker);
    }
    const row = makeElement("article", "treasure-row");
    const details = makeElement("div", "treasure-copy");
    details.append(
      makeElement("strong", "", treasure.title),
      makeElement("span", "muted", collected.has(treasure.id)
        ? "已搜集"
        : treasure.inFuzzyZone
          ? treasure.description || "已進入探索熱區，繼續尋找寶藏標記。"
          : "尚未進入探索熱區"),
    );
    row.append(details);
    if (collected.has(treasure.id)) {
      row.append(makeElement("span", "collected-badge", "✓ 已搜集"));
    } else if (precise && state.latestPosition) {
      const distance = distanceMeters(state.latestPosition, precise);
      const accuracyAccepted = state.latestPosition.accuracy <= 50;
      const withinThreshold = distance <= COLLECTION_THRESHOLD_METERS;
      const button = makeElement("button", "button button-primary", accuracyAccepted && withinThreshold
        ? "搜集寶藏"
        : accuracyAccepted
          ? `再靠近 ${Math.ceil(Math.max(0, distance - COLLECTION_THRESHOLD_METERS))} 公尺`
          : "改善定位精度");
      button.type = "button";
      button.disabled = !accuracyAccepted || !withinThreshold;
      button.addEventListener("click", () => collectTreasure(treasure, button));
      row.append(button);
    }
    list.append(row);
  }
  setText("#nearby-count", `${state.treasures.length} 個探索目標`);
}

async function collectTreasure(treasure, button) {
  if (!state.latestPosition || document.hidden) return;
  $("#hunt-error").textContent = "";
  setBusy(button, true, "確認中…");
  try {
    const result = await api(
      `/games/${encodeURIComponent(state.game.id)}/treasures/${encodeURIComponent(treasure.id)}/collect`,
      { method: "POST", body: jsonBody(state.latestPosition) },
    );
    await loadGameProgress();
    renderPlayerTreasures();
    announce(result.alreadyCollected ? "這個寶藏已計入你的進度。" : "搜集成功！進度已儲存。");
  } catch (error) {
    $("#hunt-error").textContent = error.message;
    if (error.code === "GPS_ACCURACY_TOO_LOW") $("#accuracy-warning").hidden = false;
    setBusy(button, false);
  }
}

async function pauseGame() {
  if (!state.game) return;
  stopPlayerGameHeartbeat();
  stopLocationTracking();
  try {
    await api(`/games/${encodeURIComponent(state.game.id)}/pause`, { method: "POST" });
    localStorage.setItem("lbs_current_game_status", "paused");
    state.latestPosition = null;
    if (state.userMarker) state.userMarker.setMap(null);
    state.userMarker = null;
    state.treasures = [];
    state.game = null;
    await loadProfileAndGames();
    showPage("player");
  } catch (error) {
    $("#hunt-error").textContent = error.message;
    startPlayerGameHeartbeat();
    startLocationTracking();
  }
}

async function saveProfile(event) {
  event.preventDefault();
  $("#profile-message").textContent = "";
  try {
    const { player } = await api("/auth/me", {
      method: "PATCH",
      body: jsonBody({
        nickname: $("#nickname").value,
        leaderboardVisible: $("#leaderboard-visible").checked,
      }),
    });
    state.player = player;
    $("#account-label").textContent = player.nickname || player.anonymousCode;
    $("#profile-message").textContent = "設定已儲存。";
    await loadProfileAndGames();
  } catch (error) {
    $("#profile-message").textContent = error.message;
  }
}

function updateAdminGameList() {
  const list = $("#admin-games");
  list.replaceChildren();
  for (const game of state.adminGames) {
    const button = makeElement("button", "admin-game-item", "");
    button.type = "button";
    button.classList.toggle("is-selected", game.id === state.adminGame?.id);
    button.append(
      makeElement("strong", "", game.name),
      makeElement("span", `status-pill status-${game.status}`, gameStatusLabel(game.status)),
    );
    button.addEventListener("click", () => selectAdminGame(game.id));
    list.append(button);
  }
}

function updateAdminSectionNavigation() {
  const access = state.adminAccess;
  $("#admin-nav-games").hidden = !access?.canManageGames;
  $("#admin-nav-operations").hidden = !access?.canManageGames;
  $("#admin-nav-accounts").hidden = !access?.canManageAdministrators;
  $("#admin-nav-audit").hidden = !access?.canReadAuditLogs;
  $("#admin-nav-anomalies").hidden = !access?.canReadAnomalies;
  $("#admin-nav-progress-resets").hidden = !access?.canManageProgressResets;
}

async function showAdminSection(name) {
  const access = state.adminAccess;
  const allowed = {
    games: access?.canManageGames,
    operations: access?.canManageGames,
    accounts: access?.canManageAdministrators,
    audit: access?.canReadAuditLogs,
    anomalies: access?.canReadAnomalies,
    "progress-resets": access?.canManageProgressResets,
  };
  if (!allowed[name]) return;

  $("#admin-layout").hidden = name !== "games";
  $("#admin-operations-section").hidden = name !== "operations";
  $("#admin-accounts-section").hidden = name !== "accounts";
  $("#admin-audit-section").hidden = name !== "audit";
  $("#admin-anomalies-section").hidden = name !== "anomalies";
  $("#admin-progress-resets-section").hidden = name !== "progress-resets";
  $("#admin-error").textContent = "";
  for (const button of $$("[data-admin-section]")) {
    const active = button.dataset.adminSection === name;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  if (name === "accounts") await loadAdminAccounts();
  if (name === "operations") await loadAdminOperations();
  if (name === "audit") await loadAdminAuditLogs();
  if (name === "anomalies") await loadAdminAnomalies();
  if (name === "progress-resets") {
    populateProgressResetGames();
    await loadAdminProgressResets();
  }
}

async function loadAdminOperations() {
  const gamesList = $("#admin-operations-games");
  const leaderboardList = $("#admin-operations-leaderboard");
  const message = $("#admin-operations-message");
  const gameSelect = $("#admin-operations-game");
  gamesList.replaceChildren();
  leaderboardList.replaceChildren();
  message.textContent = "";
  try {
    const { games, leaderboard } = await api("/admin/games/operations");
    const previousGameId = gameSelect.value;
    gameSelect.replaceChildren();
    for (const game of games) {
      const row = makeElement("article", "admin-audit-row");
      row.append(
        makeElement("strong", "", game.gameName),
        makeElement("p", "muted", `${gameStatusLabel(game.status)} · 參與 ${game.participantCount} 人 · 有效搜集 ${game.validCollectionCount} 次 · 完成率 ${game.completionRate}%`),
      );
      gamesList.append(row);
      const option = document.createElement("option");
      option.value = game.gameId;
      option.textContent = game.gameName;
      gameSelect.append(option);
    }
    if (games.some((game) => game.gameId === previousGameId)) gameSelect.value = previousGameId;
    if (games.length === 0) message.textContent = "目前沒有可供統計的已發布遊戲。";
    for (const player of leaderboard) {
      const row = makeElement("article", "admin-audit-row");
      row.append(makeElement("strong", "", `${player.rank}. ${player.displayName}`));
      row.append(makeElement("p", "muted", `有效搜集 ${player.totalCollected} 次 · 完成 ${player.completedGames} 場`));
      leaderboardList.append(row);
    }
    if (leaderboard.length === 0) leaderboardList.append(makeElement("p", "muted", "目前沒有公開排行榜資料。"));
  } catch (error) {
    message.textContent = error.message;
  }
}

async function searchAdminOperationsPlayers(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const list = $("#admin-operations-player-results");
  const message = $("#admin-operations-player-message");
  list.replaceChildren();
  message.textContent = "";
  const gameId = form.elements.gameId.value;
  const anonymousCode = form.elements.anonymousCode.value.trim();
  if (!gameId || anonymousCode.length < 3) {
    message.textContent = "請選擇遊戲並輸入至少 3 個字元的匿名代碼。";
    return;
  }
  try {
    const query = new URLSearchParams({ gameId, anonymousCode });
    const { players } = await api("/admin/games/players?" + query.toString());
    for (const player of players) {
      const row = makeElement("article", "admin-audit-row");
      row.append(
        makeElement("strong", "", `${player.anonymousCode} · ${player.gameName}`),
        makeElement("p", "muted", `進度 ${player.collectedCount} / ${player.targetTreasureCount}${player.completed ? " · 已完成" : ""}`),
      );
      const events = makeElement("ul", "admin-record-list");
      for (const collection of player.collections || []) {
        const collectedAt = new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(collection.collectedAt));
        events.append(makeElement("li", "", `${collectedAt} · ${collection.treasureTitle} · ${collection.distanceMeters} 公尺`));
      }
      if (player.hasMoreCollections) events.append(makeElement("li", "muted", "僅顯示最近 100 筆搜集事件。"));
      if (!player.collections?.length) events.append(makeElement("li", "muted", "目前沒有保留中的搜集事件。"));
      row.append(events);
      list.append(row);
    }
    if (!players.length) message.textContent = "找不到符合條件的玩家。";
  } catch (error) {
    message.textContent = error.message;
  }
}

async function loadAdminWorkspace(selectedId) {
  $("#admin-error").textContent = "";
  try {
    const { admin } = await api("/admin/auth/me");
    state.role = "admin";
    state.adminProfile = admin;
    state.adminAccess = getAdminCapabilities(admin.role);
    $("#account-label").textContent = "管理員";
    showPage("admin");
    updateAdminSectionNavigation();

    if (!state.adminAccess.canManageGames) {
      state.adminGames = [];
      state.adminGame = null;
      updateAdminGameList();
      await showAdminSection("audit");
      return;
    }

    const { games } = await api("/admin/games");
    state.adminGames = games;
    updateAdminGameList();
    await showAdminSection("games");
    const game = games.find((item) => item.id === (selectedId || state.adminGame?.id));
    if (game) await selectAdminGame(game.id);
    else {
      state.adminGame = null;
      $("#admin-game-panel").hidden = true;
      $("#admin-empty-state").hidden = false;
    }
  } catch (error) {
    showPage("auth");
    if (error.status !== 401 && error.status !== 403) showLoginError(error.message);
  }
}

function adminRoleOptions(selectedRole) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", "管理員角色");
  for (const option of $("#new-admin-role").options) {
    select.append(option.cloneNode(true));
  }
  select.value = selectedRole;
  return select;
}

async function loadAdminAccounts() {
  const list = $("#admin-accounts-list");
  const message = $("#admin-accounts-message");
  list.replaceChildren();
  message.textContent = "";
  try {
    const { administrators } = await api("/admin/administrators");
    for (const admin of administrators) {
      const row = makeElement("form", "admin-account-row");
      const identity = makeElement("div", "admin-account-identity");
      identity.append(
        makeElement("strong", "", admin.email),
        makeElement("span", "muted", admin.active ? "啟用中" : "已停用"),
      );
      const role = adminRoleOptions(admin.role);
      role.name = "role";
      const activeLabel = makeElement("label", "admin-active-toggle");
      const active = document.createElement("input");
      active.type = "checkbox";
      active.name = "active";
      active.checked = admin.active;
      activeLabel.append(active, document.createTextNode("啟用"));
      const save = makeElement("button", "button button-subtle", "儲存");
      save.type = "submit";
      row.append(identity, role, activeLabel, save);
      row.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        try {
          await api(`/admin/administrators/${encodeURIComponent(admin.id)}`, {
            method: "PATCH",
            body: jsonBody({ role: role.value, active: active.checked }),
          });
          await loadAdminAccounts();
          message.textContent = "管理員資料已更新。";
        } catch (error) {
          message.textContent = error.message;
          save.disabled = false;
        }
      });
      list.append(row);
    }
    if (administrators.length === 0) message.textContent = "目前沒有管理員帳號。";
  } catch (error) {
    message.textContent = error.message;
  }
}

async function createAdministrator(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type=submit]", form);
  const message = $("#admin-accounts-message");
  message.textContent = "";
  setBusy(button, true, "建立中…");
  try {
    await api("/admin/administrators", {
      method: "POST",
      body: jsonBody({
        email: form.elements.email.value,
        role: form.elements.role.value,
      }),
    });
    form.reset();
    await loadAdminAccounts();
    message.textContent = "已新增管理員。";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    setBusy(button, false);
  }
}

async function loadAdminAuditLogs() {
  const list = $("#admin-audit-list");
  const message = $("#admin-audit-message");
  list.replaceChildren();
  message.textContent = "";
  try {
    const { auditLogs } = await api("/admin/audit-logs");
    if (auditLogs.length === 0) {
      message.textContent = "目前沒有稽核紀錄。";
      return;
    }
    for (const entry of auditLogs) {
      const row = makeElement("article", "admin-audit-row");
      const heading = makeElement("div", "admin-audit-heading");
      heading.append(
        makeElement("strong", "", entry.action),
        makeElement("span", `status-pill status-${entry.result}`, entry.result === "success" ? "成功" : "失敗"),
      );
      const details = makeElement("p", "muted", `${entry.targetType}${entry.targetId ? ` · ${entry.targetId}` : ""} · ${new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt))}`);
      const summary = makeElement("pre", "admin-audit-summary", JSON.stringify(entry.summary, null, 2));
      row.append(heading, details, summary);
      list.append(row);
    }
  } catch (error) {
    message.textContent = error.message;
  }
}

const anomalyStatusLabels = {
  pending: "待覆核",
  awaiting_second_review: "等待第二位管理員",
  reviewed: "已完成覆核",
};
const anomalySignalLabels = {
  location_jump: "短時間位置跳躍",
  speed: "移動速度異常",
  repeated_collection_attempts: "短時間重複搜集",
};
const anomalyDecisionLabels = {
  confirmed: "確認異常",
  dismissed: "排除異常",
};

function anomalyDateLabel(timestamp) {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Taipei",
  }).format(new Date(timestamp));
}

function renderAnomalyEvidence(anomaly) {
  const evidence = makeElement("dl", "admin-anomaly-evidence");
  const block = makeElement("div", "admin-anomaly-evidence-detail", "");
  const details = anomaly.details || {};
  const values = [
    ["遊戲", anomaly.gameName],
    ["玩家代碼", anomaly.anonymousCode],
    ["偵測時間", anomalyDateLabel(anomaly.detectedAt)],
  ];
  if (typeof details.rawDistanceMeters === "number") {
    values.push(["位置移動距離", `${Math.round(details.rawDistanceMeters)} 公尺`]);
  }
  if (typeof details.speedKilometersPerHour === "number") {
    values.push(["推算速度", `${details.speedKilometersPerHour.toFixed(1)} 公里／小時`]);
  }
  if (typeof details.attemptCount === "number") {
    values.push(["五分鐘內搜集嘗試", `${details.attemptCount} 次`]);
  }
  values.push(["位置樣本", `${anomaly.evidence?.locationSamples?.length || 0} 筆`]);
  values.push(["相關搜集紀錄", `${anomaly.evidence?.collectionEvents?.length || 0} 筆`]);
  for (const [label, value] of values) {
    evidence.append(makeElement("dt", "", label), makeElement("dd", "", value || "—"));
  }
  const samples = anomaly.evidence?.locationSamples || [];
  const collections = anomaly.evidence?.collectionEvents || [];
  if (samples.length) {
    block.append(makeElement("strong", "", "位置樣本明細"));
    const sampleList = makeElement("ul", "admin-anomaly-evidence-list", "");
    for (const sample of samples) {
      sampleList.append(makeElement(
        "li",
        "",
        `${anomalyDateLabel(sample.measured_at)} · 定位精度 ${sample.accuracy} 公尺`,
      ));
    }
    block.append(sampleList);
  }
  if (collections.length) {
    block.append(makeElement("strong", "", "相關搜集明細"));
    const collectionList = makeElement("ul", "admin-anomaly-evidence-list", "");
    for (const collection of collections) {
      collectionList.append(makeElement(
        "li",
        "",
        `${anomalyDateLabel(collection.collected_at)} · ${collection.treasure_title} · 距離 ${collection.distance_meters} 公尺 · 精度 ${collection.accuracy} 公尺`,
      ));
    }
    block.append(collectionList);
  }
  const wrapper = makeElement("div", "", "");
  wrapper.append(evidence, block);
  return wrapper;
}

function renderAnomalyReviews(anomaly) {
  const reviews = makeElement("ol", "admin-anomaly-reviews");
  for (const [index, review] of (anomaly.reviews || []).entries()) {
    const item = makeElement("li", "", "");
    const reviewer = index === 0 ? "第一位管理員" : "第二位管理員";
    item.append(
      makeElement("strong", "", `${reviewer}：${anomalyDecisionLabels[review.decision] || review.decision}`),
      makeElement("span", "muted", `${review.actorId} · ${anomalyDateLabel(review.createdAt)}`),
    );
    if (review.notes) item.append(makeElement("p", "", review.notes));
    reviews.append(item);
  }
  return reviews;
}

function renderAnomalyReviewForm(anomaly) {
  if (!state.adminAccess?.canReviewAnomalies || anomaly.status === "reviewed") return null;
  const form = makeElement("form", "admin-anomaly-review-form", "");
  const decisionLabel = makeElement("label", "", anomaly.status === "pending" ? "覆核決定" : "請第二位管理員確認相同決定");
  const decision = document.createElement("select");
  decision.setAttribute("aria-label", "覆核決定");
  for (const value of ["confirmed", "dismissed"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = anomalyDecisionLabels[value];
    decision.append(option);
  }
  if (anomaly.status === "awaiting_second_review" && anomaly.reviews?.[0]) {
    decision.value = anomaly.reviews[0].decision;
    decision.disabled = true;
  }
  decisionLabel.append(decision);
  const notesLabel = makeElement("label", "", "覆核備註（選填）");
  const notes = document.createElement("textarea");
  notes.maxLength = 500;
  notes.rows = 2;
  notesLabel.append(notes);
  const submit = makeElement("button", "button button-primary", anomaly.status === "pending" ? "送出第一階段覆核" : "完成第二階段覆核");
  submit.type = "submit";
  const result = makeElement("p", "form-error", "");
  result.setAttribute("role", "alert");
  form.append(decisionLabel, notesLabel, submit, result);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    result.textContent = "";
    try {
      await api(`/admin/games/anomalies/${encodeURIComponent(anomaly.id)}/reviews`, {
        method: "POST",
        body: jsonBody({ decision: decision.value, notes: notes.value }),
      });
      await loadAdminAnomalies();
    } catch (error) {
      result.textContent = error.message;
      submit.disabled = false;
    }
  });
  return form;
}

async function loadAdminAnomalies() {
  const list = $("#admin-anomalies-list");
  const message = $("#admin-anomalies-message");
  list.replaceChildren();
  message.textContent = "";
  try {
    const { anomalies } = await api("/admin/games/anomalies");
    for (const anomaly of anomalies) {
      const row = makeElement("article", "admin-anomaly-row", "");
      const heading = makeElement("div", "admin-anomaly-heading", "");
      heading.append(
        makeElement("strong", "", anomalySignalLabels[anomaly.signalType] || anomaly.signalType),
        makeElement("span", `status-pill status-${anomaly.status}`, anomalyStatusLabels[anomaly.status] || anomaly.status),
      );
      row.append(heading, renderAnomalyEvidence(anomaly));
      if (anomaly.reviews?.length) {
        row.append(makeElement("h3", "admin-anomaly-subheading", "覆核歷程"), renderAnomalyReviews(anomaly));
      }
      const reviewForm = renderAnomalyReviewForm(anomaly);
      if (reviewForm) row.append(reviewForm);
      list.append(row);
    }
    if (anomalies.length === 0) message.textContent = "目前沒有異常訊號。";
  } catch (error) {
    message.textContent = error.message;
  }
}

const progressResetStatusLabels = {
  awaiting_confirmation: "待第二位管理員確認",
  completed: "已完成",
  restored: "已還原",
};

function populateProgressResetGames() {
  const select = $("#admin-reset-game");
  const previousValue = select.value;
  select.replaceChildren();
  for (const game of state.adminGames) {
    const option = document.createElement("option");
    option.value = game.id;
    option.textContent = game.name;
    select.append(option);
  }
  if (state.adminGames.some((game) => game.id === previousValue)) {
    select.value = previousValue;
  }
}

async function loadProgressResetPlayerResults() {
  const form = $("#admin-reset-player-search-form");
  const list = $("#admin-reset-player-results");
  const message = $("#admin-reset-search-message");
  const gameId = form.elements.gameId.value;
  const anonymousCode = form.elements.anonymousCode.value.trim();
  list.replaceChildren();
  message.textContent = "";
  if (!gameId || anonymousCode.length < 3) {
    message.textContent = "請選擇遊戲並輸入至少 3 個字元的匿名代碼。";
    return;
  }
  try {
    const query = new URLSearchParams({ gameId, anonymousCode });
    const { players } = await api("/admin/games/players?" + query.toString());
    for (const player of players) {
      const row = makeElement("article", "admin-reset-player-row", "");
      const heading = makeElement("div", "admin-anomaly-heading", "");
      heading.append(
        makeElement("strong", "", player.anonymousCode),
        makeElement("span", "muted", player.gameName),
      );
      const progress = makeElement(
        "p",
        "muted",
        "已搜集 " + player.collectedCount + " / " + player.targetTreasureCount +
          (player.completed ? " · 已完成" : ""),
      );
      const requestForm = makeElement("form", "admin-reset-request-form", "");
      const reasonLabel = makeElement("label", "", "重置原因（必填）");
      const reason = document.createElement("textarea");
      reason.name = "reason";
      reason.rows = 2;
      reason.maxLength = 500;
      reason.required = true;
      reasonLabel.append(reason);
      const submit = makeElement("button", "button button-subtle", "提出重置申請");
      submit.type = "submit";
      const result = makeElement("p", "form-error", "");
      result.setAttribute("role", "alert");
      requestForm.append(reasonLabel, submit, result);
      requestForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!reason.value.trim()) {
          result.textContent = "請填寫重置原因。";
          return;
        }
        submit.disabled = true;
        result.textContent = "";
        try {
          await api(
            "/admin/games/" + encodeURIComponent(player.gameId) +
              "/players/" + encodeURIComponent(player.playerId) +
              "/progress-reset",
            { method: "POST", body: jsonBody({ reason: reason.value }) },
          );
          result.textContent = "已提出申請，須由另一位管理員確認後才會重置。";
          await loadAdminProgressResets();
        } catch (error) {
          result.textContent = error.message;
          submit.disabled = false;
        }
      });
      row.append(heading, progress, requestForm);
      list.append(row);
    }
    if (players.length === 0) {
      message.textContent = "這場遊戲找不到符合的參與玩家。";
    }
  } catch (error) {
    message.textContent = error.message;
  }
}

async function searchProgressResetPlayers(event) {
  event?.preventDefault();
  await loadProgressResetPlayerResults();
}

function renderProgressResetRequest(request) {
  const row = makeElement("article", "admin-reset-history-row", "");
  const heading = makeElement("div", "admin-anomaly-heading", "");
  heading.append(
    makeElement("strong", "", request.anonymousCode + " · " + request.gameName),
    makeElement(
      "span",
      "status-pill status-" + request.status,
      request.status === "completed" && request.canRestore
        ? "已完成，可還原"
        : request.restoreBlockedByNewCollections
          ? "已有新搜集，不可還原"
          : progressResetStatusLabels[request.status] || request.status,
    ),
  );
  const details = makeElement("dl", "admin-reset-history-details");
  const fields = [
    ["申請原因", request.reason],
    ["提出管理員", request.requestedBy],
    ["提出時間", anomalyDateLabel(request.createdAt)],
  ];
  if (request.confirmedBy) {
    fields.push(["確認管理員", request.confirmedBy]);
    fields.push(["完成時間", anomalyDateLabel(request.completedAt)]);
  }
  if (request.restoredBy) {
    fields.push(["還原管理員", request.restoredBy]);
    fields.push(["還原時間", anomalyDateLabel(request.restoredAt)]);
  }
  for (const [label, value] of fields) {
    details.append(makeElement("dt", "", label), makeElement("dd", "", value || "—"));
  }
  row.append(heading, details);
  const message = makeElement("p", "form-error", "");
  message.setAttribute("role", "alert");
  if (request.canConfirm) {
    const confirmButton = makeElement("button", "button button-primary", "由我確認並執行重置");
    confirmButton.type = "button";
    confirmButton.addEventListener("click", async () => {
      confirmButton.disabled = true;
      message.textContent = "";
      try {
        await api(
          "/admin/games/progress-resets/" + encodeURIComponent(request.resetId) + "/confirm",
          { method: "POST", body: jsonBody({}) },
        );
        announce("已完成玩家進度重置。");
        await loadAdminProgressResets();
        await loadProgressResetPlayerResults();
      } catch (error) {
        message.textContent = error.message;
        confirmButton.disabled = false;
      }
    });
    row.append(confirmButton);
  } else if (request.status === "awaiting_confirmation") {
    row.append(makeElement("p", "muted", "須由不同於提出申請人的管理員確認。"));
  } else if (request.restoreBlockedByNewCollections) {
    row.append(makeElement("p", "muted", "玩家重置後已有新搜集，伺服器不允許還原。"));
  }
  if (request.canRestore) {
    const restoreButton = makeElement("button", "button button-subtle", "還原重置前進度");
    restoreButton.type = "button";
    restoreButton.addEventListener("click", () => {
      state.pendingProgressResetRestoreId = request.resetId;
      $("#progress-reset-restore-summary").textContent =
        "玩家：" + request.anonymousCode +
        "\n遊戲：" + request.gameName +
        "\n申請原因：" + request.reason;
      $("#progress-reset-restore-error").textContent = "";
      $("#progress-reset-restore-dialog").showModal();
    });
    row.append(restoreButton);
  }
  if (message.textContent) row.append(message);
  if (request.canConfirm || request.canRestore) {
    const actionArea = makeElement("div", "admin-reset-action-feedback", "");
    actionArea.append(message);
    row.append(actionArea);
  }
  return row;
}

async function loadAdminProgressResets() {
  const list = $("#admin-progress-resets-list");
  const message = $("#admin-progress-resets-message");
  const status = $("#admin-progress-reset-filter").value || "all";
  list.replaceChildren();
  message.textContent = "";
  try {
    const { requests } = await api(
      "/admin/games/progress-resets?status=" + encodeURIComponent(status),
    );
    const priority = (request) => {
      if (request.status === "awaiting_confirmation") return 0;
      if (request.status === "completed" && request.canRestore) return 1;
      if (request.status === "completed") return 2;
      return 3;
    };
    requests.sort((left, right) =>
      priority(left) - priority(right) ||
      right.createdAt - left.createdAt,
    );
    for (const request of requests) list.append(renderProgressResetRequest(request));
    if (requests.length === 0) message.textContent = "目前沒有符合篩選條件的進度重置申請。";
  } catch (error) {
    message.textContent = error.message;
  }
}

async function confirmProgressResetRestore() {
  const button = $("#confirm-progress-reset-restore");
  const errorMessage = $("#progress-reset-restore-error");
  const resetId = state.pendingProgressResetRestoreId;
  if (!resetId) return;
  button.disabled = true;
  errorMessage.textContent = "";
  try {
    await api(
      "/admin/games/progress-resets/" + encodeURIComponent(resetId) + "/restore",
      { method: "POST", body: jsonBody({}) },
    );
    $("#progress-reset-restore-dialog").close();
    state.pendingProgressResetRestoreId = null;
    announce("已還原玩家進度。");
    await loadAdminProgressResets();
    await loadProgressResetPlayerResults();
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function selectAdminGame(gameId) {
  const game = state.adminGames.find((item) => item.id === gameId);
  if (!game) return;
  clearImportPreviewMarkers();
  state.importData = null;
  state.importPreview = [];
  $("#import-map-preview").hidden = true;
  state.adminGame = game;
  $("#admin-game-panel").hidden = false;
  $("#admin-empty-state").hidden = true;
  if (game.status !== "draft") setAdminTab("map");
  setText("#admin-active-game-name", game.name);
  setText("#admin-game-status", gameStatusLabel(game.status));
  setText("#admin-game-meta", `${dateLabel(game.startsAt, game.timezone)} – ${dateLabel(game.endsAt, game.timezone)} ・ ${game.timezone}`);
  for (const tab of $$(".admin-tab")) {
    tab.disabled = game.status !== "draft" && tab.dataset.adminTab !== "map";
  }
  $("#admin-map-hint").textContent = game.status === "draft"
    ? "點擊地圖可新增寶藏；選取標記可編輯草稿內容。"
    : "已發布內容已鎖定；可停用寶藏或管理遊戲狀態。";
  const { treasures } = await api(`/admin/games/${encodeURIComponent(game.id)}/treasures`);
  state.adminTreasures = treasures;
  setText(
    "#admin-game-meta",
    `${dateLabel(game.startsAt, game.timezone)} – ${dateLabel(game.endsAt, game.timezone)} ・ ${game.timezone} ・ ${state.adminTreasures.filter((item) => item.enabled).length} 個啟用目標`,
  );
  if (game.archiveExpiresAt) {
    $("#admin-game-meta").textContent += ` · 封存期限至 ${dateLabel(game.archiveExpiresAt, game.timezone)}`;
  }
  if (game.archiveRestoredAt) $("#admin-game-meta").textContent += " · 封存資料已還原";
  updateAdminGameList();
  renderAdminActions();
  renderGameRetentionActions();
  renderAdminTreasureList();
  renderMockTreasureOptions();
  await ensureAdminMap();
}

function renderAdminActions() {
  const actions = $("#game-actions");
  actions.replaceChildren();
  const game = state.adminGame;
  if (game.status === "draft") {
    actions.append(actionButton("發布遊戲", "button button-primary", () => gameAction("publish")));
  } else if (["active", "published"].includes(game.status)) {
    actions.append(actionButton("暫停遊戲", "button button-subtle", () => gameAction("pause")));
    actions.append(actionButton("提前結束", "button button-danger", () => gameAction("end")));
  } else if (game.status === "paused") {
    actions.append(actionButton("恢復遊戲", "button button-primary", () => gameAction("resume")));
    actions.append(actionButton("提前結束", "button button-danger", () => gameAction("end")));
  }
}

function renderGameRetentionActions() {
  const actions = $("#game-actions");
  const game = state.adminGame;
  if (!game) return;
  if (game.canRestore) {
    actions.append(actionButton("還原封存資料", "button button-primary", () => restoreArchivedGame()));
  }
  if (game.canPermanentlyDelete) {
    actions.append(actionButton(game.status === "draft" ? "永久刪除草稿" : "永久刪除遊戲", "button button-danger", () => permanentlyDeleteGame()));
  } else if (game.archiveRestoredAt) {
    actions.append(makeElement("p", "muted", "封存資料已還原；封存期限屆滿後才能永久刪除。"));
  }
}

async function restoreArchivedGame() {
  const game = state.adminGame;
  if (!game?.canRestore) return;
  if (!window.confirm(`確定還原「${game.name}」的封存資料？資料還原後不會恢復遊玩。`)) return;
  try {
    await api(`/admin/games/${encodeURIComponent(game.id)}/restore`, { method: "POST" });
    announce("已還原遊戲資料；遊戲不會恢復遊玩。");
    await loadAdminWorkspace(game.id);
  } catch (error) {
    $("#admin-error").textContent = error.message;
  }
}

async function permanentlyDeleteGame() {
  const game = state.adminGame;
  if (!game?.canPermanentlyDelete) return;
  const impact = game.status === "draft"
    ? "草稿及其寶藏將永久刪除。"
    : "遊戲資料及排行榜中的該場貢獻將永久刪除；仍在保留期限內的事件會去識別化保存。";
  if (!window.confirm(`確定永久刪除「${game.name}」？${impact}此操作無法復原。`)) return;
  try {
    await api(`/admin/games/${encodeURIComponent(game.id)}`, {
      method: "DELETE",
      body: jsonBody({ confirmPermanentDeletion: true }),
    });
    announce("遊戲已永久刪除。");
    state.adminGame = null;
    await loadAdminWorkspace();
  } catch (error) {
    $("#admin-error").textContent = error.message;
  }
}

function actionButton(text, className, handler) {
  const button = makeElement("button", className, text);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

async function gameAction(action) {
  if (!state.adminGame) return;
  if (action === "publish" && !window.confirm(`確定發布「${state.adminGame.name}」？發布後寶藏內容將鎖定。`)) return;
  if (action === "end" && !window.confirm(`確定提前結束「${state.adminGame.name}」？結束後無法恢復遊玩。`)) return;
  try {
    await api(`/admin/games/${encodeURIComponent(state.adminGame.id)}/${action}`, { method: "POST" });
    announce(action === "publish" ? "遊戲已發布。" : "遊戲狀態已更新。");
    await loadAdminWorkspace(state.adminGame.id);
  } catch (error) {
    $("#admin-error").textContent = error.message;
  }
}

async function createGame(event) {
  event.preventDefault();
  $("#admin-form-error").textContent = "";
  const form = event.currentTarget;
  try {
    const timezone = $("#new-game-timezone").value.trim();
    const { game } = await api("/admin/games", {
      method: "POST",
      body: jsonBody({
        name: $("#new-game-name").value.trim(),
        description: $("#new-game-description").value.trim(),
        startsAt: activityTimeToIso($("#new-game-start").value, timezone),
        endsAt: activityTimeToIso($("#new-game-end").value, timezone),
        timezone,
        mapCenter: {
          latitude: Number($("#center-latitude").value),
          longitude: Number($("#center-longitude").value),
        },
      }),
    });
    form.reset();
    setDefaultGameDates();
    $("#new-game-timezone").value = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei";
    $("#center-latitude").value = "25.033";
    $("#center-longitude").value = "121.565";
    await loadAdminWorkspace(game.id);
    announce("已建立遊戲草稿。");
  } catch (error) {
    $("#admin-form-error").textContent = error.message;
  }
}

async function ensureAdminMap() {
  $("#admin-map-message").textContent = "";
  try {
    await ensureMapsLoaded();
    const center = state.adminGame.mapCenter;
    if (!state.adminMap) {
      state.adminMap = new google.maps.Map($("#admin-map"), {
        center: { lat: center.latitude, lng: center.longitude },
        zoom: 16,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        clickableIcons: false,
      });
      state.adminMap.addListener("click", (event) => {
        if (state.adminGame?.status !== "draft" || !event.latLng) return;
        openTreasureDialog({
          latitude: event.latLng.lat(),
          longitude: event.latLng.lng(),
        });
      });
    } else {
      state.adminMap.setCenter({ lat: center.latitude, lng: center.longitude });
    }
    renderAdminMarkers();
  } catch (error) {
    $("#admin-map-message").textContent = error.message;
  }
}

function renderAdminMarkers() {
  clearMarkers(state.adminMarkers);
  if (!state.adminMap) return;
  for (const treasure of state.adminTreasures) {
    const marker = new google.maps.Marker({
      map: state.adminMap,
      position: { lat: treasure.latitude, lng: treasure.longitude },
      title: treasure.title,
      opacity: treasure.enabled ? 1 : 0.55,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: treasure.enabled ? "#477a53" : "#89948c",
        fillOpacity: 1,
        strokeColor: "#fff",
        strokeWeight: 2,
      },
    });
    marker.addListener("click", () => openTreasureDialog(treasure));
    state.adminMarkers.push(marker);
    state.adminMarkers.push(new google.maps.Circle({
      map: state.adminMap,
      center: { lat: treasure.fuzzyLatitude, lng: treasure.fuzzyLongitude },
      radius: treasure.fuzzyRadiusMeters,
      fillColor: "#477a53",
      fillOpacity: 0.08,
      strokeColor: "#477a53",
      strokeOpacity: 0.35,
      strokeWeight: 1,
    }));
  }
}

function clearImportPreviewMarkers() {
  clearMarkers(state.importMarkers);
}

function renderImportPreviewMarkers(treasures) {
  clearImportPreviewMarkers();
  state.importPreview = treasures;
  if (!state.adminMap) return;
  for (const treasure of treasures) {
    const marker = new google.maps.Marker({
      map: state.adminMap,
      position: { lat: treasure.latitude, lng: treasure.longitude },
      title: `匯入預覽：${treasure.title}`,
      zIndex: 1000,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 9,
        fillColor: "#d97706",
        fillOpacity: 1,
        strokeColor: "#fff",
        strokeWeight: 2,
      },
    });
    state.importMarkers.push(marker);
    state.importMarkers.push(new google.maps.Circle({
      map: state.adminMap,
      center: { lat: treasure.fuzzyLatitude, lng: treasure.fuzzyLongitude },
      radius: treasure.fuzzyRadiusMeters,
      fillColor: "#d97706",
      fillOpacity: 0.12,
      strokeColor: "#d97706",
      strokeOpacity: 0.65,
      strokeWeight: 1,
    }));
  }
}

function showImportMapPreview() {
  if (!state.adminMap || state.importPreview.length === 0) return;
  setAdminTab("map");
  $("#admin-map-message").textContent = "橘色標記與範圍為本次 JSON 匯入預覽，尚未寫入資料。";
  window.requestAnimationFrame(() => {
    const bounds = new google.maps.LatLngBounds();
    for (const treasure of state.importPreview) {
      bounds.extend({ lat: treasure.latitude, lng: treasure.longitude });
      bounds.extend({ lat: treasure.fuzzyLatitude, lng: treasure.fuzzyLongitude });
    }
    if (state.importPreview.length === 1) {
      const treasure = state.importPreview[0];
      state.adminMap.setCenter({ lat: treasure.latitude, lng: treasure.longitude });
      state.adminMap.setZoom(16);
    } else {
      state.adminMap.fitBounds(bounds);
    }
  });
}

function renderAdminTreasureList() {
  const list = $("#admin-treasures");
  list.replaceChildren();
  list.append(makeElement("h3", "list-heading", `寶藏清單 · ${state.adminTreasures.length} / 500`));
  for (const treasure of state.adminTreasures) {
    const row = makeElement("button", "admin-treasure-row", "");
    row.type = "button";
    row.append(
      makeElement("span", treasure.enabled ? "treasure-dot" : "treasure-dot is-disabled", "✦"),
      makeElement("strong", "", treasure.title),
      makeElement("span", "muted", treasure.enabled ? "啟用中" : "已停用"),
    );
    row.addEventListener("click", () => {
      if (state.adminGame.status === "draft") openTreasureDialog(treasure);
      else if (["active", "published", "paused"].includes(state.adminGame.status) && treasure.enabled) toggleTreasure(treasure);
    });
    list.append(row);
  }
}

function renderMockTreasureOptions() {
  const select = $("#mock-treasure");
  select.replaceChildren();
  for (const treasure of state.adminTreasures.filter((item) => item.enabled)) {
    const option = document.createElement("option");
    option.value = treasure.id;
    option.textContent = treasure.title;
    select.append(option);
  }
}

function openTreasureDialog(treasure) {
  state.editingTreasureId = treasure.id || null;
  $("#treasure-dialog-title").textContent = state.editingTreasureId ? "編輯寶藏" : "新增寶藏";
  $("#treasure-title").value = treasure.title || "";
  $("#treasure-description").value = treasure.description || "";
  $("#treasure-latitude").value = treasure.latitude;
  $("#treasure-longitude").value = treasure.longitude;
  $("#treasure-fuzzy-latitude").value = treasure.fuzzyLatitude ?? treasure.latitude;
  $("#treasure-fuzzy-longitude").value = treasure.fuzzyLongitude ?? treasure.longitude;
  $("#treasure-radius").value = treasure.fuzzyRadiusMeters ?? 100;
  $("#treasure-enabled").checked = treasure.enabled !== false;
  $("#delete-treasure").hidden = !state.editingTreasureId;
  $("#treasure-form-error").textContent = "";
  for (const input of $$("input, textarea", $("#treasure-form"))) input.disabled = state.adminGame.status !== "draft";
  $("#save-treasure").hidden = state.adminGame.status !== "draft";
  $("#delete-treasure").hidden = !state.editingTreasureId || state.adminGame.status !== "draft";
  $("#treasure-dialog").showModal();
}

async function saveTreasure(event) {
  event.preventDefault();
  if (!state.adminGame || state.adminGame.status !== "draft") return;
  const body = {
    title: $("#treasure-title").value.trim(),
    description: $("#treasure-description").value.trim(),
    latitude: Number($("#treasure-latitude").value),
    longitude: Number($("#treasure-longitude").value),
    fuzzyLatitude: Number($("#treasure-fuzzy-latitude").value),
    fuzzyLongitude: Number($("#treasure-fuzzy-longitude").value),
    fuzzyRadiusMeters: Number($("#treasure-radius").value),
    enabled: $("#treasure-enabled").checked,
    sortOrder: state.editingTreasureId
      ? state.adminTreasures.find((item) => item.id === state.editingTreasureId)?.sortOrder ?? state.adminTreasures.length
      : state.adminTreasures.length,
  };
  try {
    const path = `/admin/games/${encodeURIComponent(state.adminGame.id)}/treasures`;
    if (state.editingTreasureId) {
      await api(`${path}/${encodeURIComponent(state.editingTreasureId)}`, {
          method: "PATCH",
          body: jsonBody(body),
        });
    } else {
      await api(path, { method: "POST", body: jsonBody(body) });
    }
    $("#treasure-dialog").close();
    await selectAdminGame(state.adminGame.id);
    announce(state.editingTreasureId ? "寶藏已更新。" : "已新增寶藏。");
  } catch (error) {
    $("#treasure-form-error").textContent = error.message;
  }
}

async function deleteTreasure() {
  if (!state.editingTreasureId || !state.adminGame) return;
  if (!window.confirm("確定永久刪除這個草稿寶藏？")) return;
  try {
    await api(
      `/admin/games/${encodeURIComponent(state.adminGame.id)}/treasures/${encodeURIComponent(state.editingTreasureId)}`,
      { method: "DELETE", body: jsonBody({ confirmPermanentDeletion: true }) },
    );
    $("#treasure-dialog").close();
    await selectAdminGame(state.adminGame.id);
    announce("草稿寶藏已刪除。");
  } catch (error) {
    $("#treasure-form-error").textContent = error.message;
  }
}

async function toggleTreasure(treasure) {
  if (!treasure.enabled) return;
  if (!window.confirm(`${treasure.enabled ? "停用" : "重新啟用"}「${treasure.title}」？`)) return;
  try {
    await api(
      `/admin/games/${encodeURIComponent(state.adminGame.id)}/treasures/${encodeURIComponent(treasure.id)}`,
      { method: "PATCH", body: jsonBody({ enabled: !treasure.enabled }) },
    );
    await selectAdminGame(state.adminGame.id);
    announce(treasure.enabled ? "寶藏已停用。" : "寶藏已啟用。");
  } catch (error) {
    $("#admin-error").textContent = error.message;
  }
}

async function previewTreasureImport(file) {
  $("#import-result").replaceChildren();
  $("#import-actions").hidden = true;
  $("#import-map-preview").hidden = true;
  state.importData = null;
  clearImportPreviewMarkers();
  state.importPreview = [];
  if (!file || !state.adminGame) return;
  try {
    state.importData = JSON.parse(await file.text());
    const result = await api(
      `/admin/games/${encodeURIComponent(state.adminGame.id)}/treasures/import/preview`,
      { method: "POST", body: jsonBody(state.importData) },
    );
    showImportResult(result);
  } catch (error) {
    if (error.details?.errors) {
      showImportResult({
        validCount: error.details.validCount || 0,
        errorCount: error.details.errorCount || error.details.errors.length,
        errors: error.details.errors,
      });
    } else {
      $("#import-result").append(makeElement("p", "form-error", error.message));
    }
  }
}

function showImportResult(result) {
  const target = $("#import-result");
  target.replaceChildren();
  target.append(makeElement("p", "notice", `可匯入 ${result.validCount} 筆，發現 ${result.errorCount} 個問題。`));
  for (const item of result.errors || []) {
    target.append(makeElement("p", "import-error", `第 ${item.row} 列 · ${item.field} · ${item.reason}`));
  }
  renderImportPreviewMarkers(result.preview || []);
  $("#import-map-preview").hidden = state.importPreview.length === 0;
  if (result.validCount > 0) {
    const actions = $("#import-actions");
    actions.replaceChildren();
    actions.hidden = false;
    actions.append(
      actionButton("全部有效才匯入", "button button-primary", () => commitImport("all_or_nothing")),
      actionButton("跳過錯誤列匯入", "button button-subtle", () => commitImport("skip_invalid")),
    );
  }
}

async function commitImport(mode) {
  if (!state.importData || !state.adminGame) return;
  try {
    const result = await api(
      `/admin/games/${encodeURIComponent(state.adminGame.id)}/treasures/import/commit`,
      { method: "POST", body: jsonBody({ ...state.importData, mode }) },
    );
    showImportResult({
      validCount: result.importedCount,
      errorCount: result.errors?.length || 0,
      errors: result.errors || [],
    });
    if (result.importedCount > 0) {
      state.importData = null;
      state.importPreview = [];
      clearImportPreviewMarkers();
      $("#import-map-preview").hidden = true;
      await selectAdminGame(state.adminGame.id);
      announce(`已匯入 ${result.importedCount} 個寶藏。`);
    }
  } catch (error) {
    if (error.details?.errors) {
      showImportResult({
        validCount: error.details.validCount || 0,
        errorCount: error.details.errorCount || error.details.errors.length,
        errors: error.details.errors,
      });
    } else {
      $("#import-result").append(makeElement("p", "form-error", error.message));
    }
  }
}

async function runMockTest(event) {
  event.preventDefault();
  const resultText = $("#mock-test-result");
  resultText.textContent = "";
  try {
    const result = await api(
      `/admin/games/${encodeURIComponent(state.adminGame.id)}/mock-gps/test`,
      {
        method: "POST",
        body: jsonBody({
          treasureId: $("#mock-treasure").value,
          latitude: Number($("#mock-latitude").value),
          longitude: Number($("#mock-longitude").value),
          accuracy: Number($("#mock-accuracy").value),
        }),
      },
    );
    resultText.textContent = result.collectible
      ? `測試通過・距離 ${result.distanceMeters.toFixed(2)} 公尺，可搜集；沒有建立正式紀錄。`
      : `測試未通過・距離 ${result.distanceMeters.toFixed(2)} 公尺，門檻 ${result.thresholdMeters} 公尺，定位精度${result.accuracyAccepted ? "合格" : "不足"}。`;
  } catch (error) {
    resultText.textContent = error.message;
  }
}

function setAdminTab(name) {
  for (const tab of $$(".admin-tab")) {
    const active = tab.dataset.adminTab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const [key, panel] of [
    ["map", $("#admin-map-panel")],
    ["import", $("#admin-import-panel")],
    ["test", $("#admin-test-panel")],
  ]) panel.hidden = key !== name;
}

function setDefaultGameDates() {
  const pad = (number) => String(number).padStart(2, "0");
  const localInputValue = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const start = new Date(Date.now() + 60 * 60 * 1000);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  $("#new-game-start").value = localInputValue(start);
  $("#new-game-end").value = localInputValue(end);
}

async function deletePlayerAccount() {
  const message = $("#account-deletion-message");
  message.textContent = "";
  if (!state.player || state.role !== "player") return;
  const confirmed = window.confirm(
    "確定永久刪除玩家帳號？系統會移除 Email、登入憑證與排行榜貢獻；仍在保留期限內的事件會去識別化保存。此操作無法復原。",
  );
  if (!confirmed) return;
  const button = $("#delete-player-account");
  button.disabled = true;
  try {
    await api("/auth/me", {
      method: "DELETE",
      body: jsonBody({ confirmPermanentDeletion: true }),
    });
    localStorage.removeItem("lbs_current_game");
    localStorage.removeItem("lbs_current_game_status");
    window.location.reload();
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
}

async function logout() {
  const wasPlayer = state.role === "player";
  if (state.role === "player") {
    const activeGameId = state.game?.id
      || (localStorage.getItem("lbs_current_game_status") === "playing"
        ? localStorage.getItem("lbs_current_game")
        : null);
    if (activeGameId) {
      stopPlayerGameHeartbeat();
      try {
        await api(`/games/${encodeURIComponent(activeGameId)}/pause`, { method: "POST" });
        localStorage.setItem("lbs_current_game_status", "paused");
        stopPlayerGameHeartbeat();
      } catch (error) {
        if (error.status !== 409) {
          startPlayerGameHeartbeat();
          announce(`暫停目前遊戲失敗，尚未登出：${error.message}`);
          return;
        }
      }
    }
  }
  stopPlayerGameHeartbeat();
  stopLocationTracking();
  if (state.userMarker) state.userMarker.setMap(null);
  state.userMarker = null;
  try {
    await api(state.role === "admin" ? "/admin/auth/logout" : "/auth/logout", { method: "POST" });
  } catch (error) {
    if (error.status !== 401) {
      if (wasPlayer) {
        try {
          await loadPlayerHome();
        } catch {
          // 登出失敗時保留目前登入狀態，避免誤導玩家以為登入鎖已解除。
        }
      }
      announce(`登出失敗，仍保持登入：${error.message}`);
      return;
    }
  }
  state.role = "";
  state.game = null;
  state.player = null;
  state.adminGame = null;
  state.adminProfile = null;
  state.adminAccess = null;
  showPage("auth");
  setLoginRole("player");
  $("#trusted-device-login").hidden = !wasPlayer;
  $("#auth-message").textContent = "已登出；此裝置仍受信任。選擇身分後可直接繼續登入。";
}

async function forgetTrustedDevice() {
  if (!window.confirm("忘記此裝置後，下次使用時需要重新確認 Email。要繼續嗎？")) {
    return;
  }
  const button = $("#forget-trusted-device");
  setBusy(button, true, "正在移除…");
  try {
    if (state.game) {
      stopPlayerGameHeartbeat();
      try {
        await api(`/games/${encodeURIComponent(state.game.id)}/pause`, { method: "POST" });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
      localStorage.setItem("lbs_current_game_status", "paused");
    }
    await api("/auth/device/forget", { method: "POST" });
    stopLocationTracking();
    if (state.userMarker) state.userMarker.setMap(null);
    state.userMarker = null;
    state.role = "";
    state.game = null;
    state.player = null;
    $("#trusted-device-login").hidden = true;
    localStorage.removeItem("lbs_current_game");
    localStorage.removeItem("lbs_current_game_status");
    showPage("auth");
    setLoginRole("player");
  } catch (error) {
    if (state.game) startPlayerGameHeartbeat();
    announce(error.message);
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  $("#player-login-tab").addEventListener("click", () => setLoginRole("player"));
  $("#admin-login-tab").addEventListener("click", () => setLoginRole("admin"));
  $("#magic-link-form").addEventListener("submit", submitMagicLink);
  $("#trusted-device-login").addEventListener("click", continueWithTrustedDevice);
  $("#logout-button").addEventListener("click", logout);
  $("#profile-toggle").addEventListener("click", () => {
    $("#profile-panel").hidden = !$("#profile-panel").hidden;
  });
  $("#profile-form").addEventListener("submit", saveProfile);
  $("#delete-player-account").addEventListener("click", deletePlayerAccount);
  $("#forget-trusted-device").addEventListener("click", forgetTrustedDevice);
  $("#refresh-player").addEventListener("click", loadProfileAndGames);
  $("#pause-game").addEventListener("click", pauseGame);
  $("#back-to-games").addEventListener("click", pauseGame);
  $("#center-map").addEventListener("click", () => {
    if (state.latestPosition && state.playerMap) {
      state.playerMap.panTo({
        lat: state.latestPosition.latitude,
        lng: state.latestPosition.longitude,
      });
      state.playerMap.setZoom(18);
    }
  });
  $("#create-game-form").addEventListener("submit", createGame);
  $("#refresh-admin").addEventListener("click", () => loadAdminWorkspace(state.adminGame?.id));
  $("#refresh-admin-operations").addEventListener("click", loadAdminOperations);
  $("#admin-operations-player-form").addEventListener("submit", searchAdminOperationsPlayers);
  $("#admin-create-account-form").addEventListener("submit", createAdministrator);
  $("#refresh-admin-audit").addEventListener("click", loadAdminAuditLogs);
  $("#refresh-admin-anomalies").addEventListener("click", loadAdminAnomalies);
  $("#admin-reset-player-search-form").addEventListener("submit", searchProgressResetPlayers);
  $("#admin-progress-reset-filter").addEventListener("change", loadAdminProgressResets);
  $("#refresh-admin-progress-resets").addEventListener("click", loadAdminProgressResets);
  $("#confirm-progress-reset-restore").addEventListener("click", confirmProgressResetRestore);
  $("#cancel-progress-reset-restore").addEventListener("click", () => {
    $("#progress-reset-restore-dialog").close();
    state.pendingProgressResetRestoreId = null;
  });
  for (const button of $$("[data-admin-section]")) {
    button.addEventListener("click", () => showAdminSection(button.dataset.adminSection));
  }
  $("#treasure-form").addEventListener("submit", saveTreasure);
  $("#cancel-treasure").addEventListener("click", () => $("#treasure-dialog").close());
  $("#delete-treasure").addEventListener("click", deleteTreasure);
  $("#treasure-file").addEventListener("change", (event) => {
    const [file] = event.currentTarget.files;
    event.currentTarget.value = "";
    previewTreasureImport(file);
  });
  $("#import-map-preview").addEventListener("click", showImportMapPreview);
  $("#mock-test-form").addEventListener("submit", runMockTest);
  for (const tab of $$(".admin-tab")) tab.addEventListener("click", () => setAdminTab(tab.dataset.adminTab));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.role === "player" && state.game) {
        state.latestPosition = null;
        setText("#location-status", "背景中，定位已暫停");
      }
    } else if (state.role === "player" && state.game) {
      void sendPlayerGameHeartbeat();
    }
  });
}

async function initialize() {
  bindEvents();
  setDefaultGameDates();
  $("#new-game-timezone").value = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei";
  if (new URLSearchParams(location.search).get("login") === "success") {
    window.history.replaceState({}, "", "/app");
    announce("登入成功，歡迎回來！");
  }
  if (new URLSearchParams(location.search).get("adminLogin") === "success") {
    window.history.replaceState({}, "", "/app");
    await loadAdminWorkspace();
    if (state.role === "admin") announce("管理員驗證成功。");
    return;
  }
  try {
    await loadPlayerHome();
    return;
  } catch (error) {
    if (error.status !== 401) {
      showPage("auth");
      showLoginError(error.message);
      return;
    }
  }
  try {
    await api("/auth/device-login", { method: "POST" });
    await loadPlayerHome();
    return;
  } catch (error) {
    if (error.status !== 401) {
      showPage("auth");
      showLoginError(error.message);
      return;
    }
  }
  try {
    await loadAdminWorkspace();
  } catch (error) {
    showPage("auth");
    showLoginError(error.message);
  }
}

initialize();
