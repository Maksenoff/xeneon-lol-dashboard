// LoL Session v2 — widget iCUE (Xeneon Edge).
// Affichage uniquement : toutes les valeurs (V/D, LP, séries, rangs, winrates, repères…) viennent
// du backend local. Le widget ne fait que de la mise en forme (dates, durées, signes) et le tactile.

var DEFAULT_API = 'http://localhost:3417'; // « localhost » : seul hôte autorisé par iCUE
var MODES = ['rsolo', 'flex', 'normal', 'aram', 'all'];
var PERIODS = ['session', 'jour', 'semaine'];
var MAX_MATCH_ROWS = 8; // le CSS coupe proprement s'il y a moins de place
var MAX_PILLS = 24;
var LIVE_POLL_ACTIVE_MS = 5000; // vue « partie en cours » affichée
var LIVE_POLL_IDLE_MS = 20000; // détection d'une partie depuis la vue session

var state = {
  view: 'session',
  mode: 'rsolo',
  period: 'session',
  data: null,
  live: null,
  liveFetchedAt: 0,
  autoSwitchedGameId: null,
  lastOkAt: null,
  online: null,
  inflight: null,
  busy: false,
  confirmTimer: null,
  refreshTimer: null,
  liveTimer: null,
  refreshMs: 30000
};

// ---------------------------------------------------------------------------
// Propriétés iCUE et préférences locales
// ---------------------------------------------------------------------------

// Lecture sûre d'une propriété iCUE (globale ou variable du contexte sandbox), cf. doc Corsair.
function getIcueProperty(name) {
  if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, name)) {
    var v = window[name];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  try {
    var value = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
    if (value !== undefined && value !== null && value !== '') return value;
  } catch (e) {}
  return undefined;
}

function prop(name, fallback) {
  var v = getIcueProperty(name);
  return v === undefined ? fallback : v;
}

function boolProp(name, fallback) {
  var v = getIcueProperty(name);
  if (v === undefined) return fallback;
  return v === true || v === 'true' || v === 1;
}

function apiBase() {
  return String(prop('apiBaseUrl', DEFAULT_API)).replace(/\/+$/, '');
}

function prefsKey() {
  return 'lolsession:' + prop('uniqueId', 'default');
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(prefsKey()) || '{}') || {};
  } catch (e) {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(prefsKey(), JSON.stringify(prefs));
  } catch (e) {}
}

/**
 * Le mode/la période choisis au toucher sont mémorisés ; si l'utilisateur change la valeur
 * par défaut dans les réglages iCUE, cette nouvelle valeur reprend la main.
 */
function syncSelectionWithSettings() {
  var prefs = loadPrefs();
  var defMode = MODES.indexOf(prop('defaultMode')) >= 0 ? prop('defaultMode') : 'rsolo';
  var defPeriod = PERIODS.indexOf(prop('defaultPeriod')) >= 0 ? prop('defaultPeriod') : 'session';

  state.mode = prefs.seenDefaultMode === defMode && MODES.indexOf(prefs.mode) >= 0 ? prefs.mode : defMode;
  state.period = prefs.seenDefaultPeriod === defPeriod && PERIODS.indexOf(prefs.period) >= 0 ? prefs.period : defPeriod;
  savePrefs({ mode: state.mode, period: state.period, seenDefaultMode: defMode, seenDefaultPeriod: defPeriod });

  // Aperçu dans un navigateur : index.html?mode=all&period=semaine&view=live (iCUE ne passe jamais de paramètres).
  var query = new URLSearchParams(location.search);
  if (MODES.indexOf(query.get('mode')) >= 0) state.mode = query.get('mode');
  if (PERIODS.indexOf(query.get('period')) >= 0) state.period = query.get('period');
}

function rememberSelection() {
  var prefs = loadPrefs();
  prefs.mode = state.mode;
  prefs.period = state.period;
  savePrefs(prefs);
}

function applyPersonalization() {
  var root = document.documentElement.style;
  var transparency = Number(prop('transparency', 100));
  if (!isFinite(transparency)) transparency = 100;
  root.setProperty('--text', prop('textColor', '#ffffff'));
  root.setProperty('--accent', prop('accentColor', '#d4b06a'));
  root.setProperty('--bg', hexToRgba(prop('backgroundColor', '#070b14'), clamp(transparency, 0, 100) / 100));
  root.setProperty('--splash-opacity', String(clamp(Number(prop('splashOpacity', 75)), 10, 100) / 100));
  root.setProperty('--splash-focus', clamp(Number(prop('splashFocus', 66)), 0, 100) + '%');
  root.setProperty('--splash-fy', String(clamp(Number(prop('splashFocusY', 15)), 0, 100) / 100));
  root.setProperty('--splash-zoom', String(clamp(Number(prop('splashZoom', 130)), 100, 250) / 100));

  var secs = Number(prop('refreshSeconds', 30));
  state.refreshMs = (isFinite(secs) && secs >= 15 ? secs : 30) * 1000;
  applySplash();
}

function applySplash() {
  var img = $('splash');
  if (!boolProp('showSplash', true)) {
    img.classList.remove('ready');
    img.removeAttribute('src');
    return;
  }
  var champion = String(prop('splashChampion', 'Vayne')).trim() || 'Vayne';
  var skin = parseInt(prop('splashSkin', '25'), 10);
  if (!isFinite(skin) || skin < 0) skin = 0;
  var src = apiBase() + '/api/assets/splash/' + encodeURIComponent(champion) + '/' + skin + '.jpg';
  if (img.getAttribute('src') === src) return;
  img.classList.remove('ready');
  img.onload = function () { img.classList.add('ready'); };
  img.onerror = function () { img.classList.remove('ready'); };
  img.src = src;
}

function clamp(v, min, max) {
  return isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
}

function hexToRgba(hex, alpha) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  var n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}

// ---------------------------------------------------------------------------
// Accès au backend
// ---------------------------------------------------------------------------

function api(path, method) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 12000);
  return fetch(apiBase() + path, { method: method || 'GET', signal: controller.signal })
    .then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error((body && body.error) || 'HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return body;
      });
    })
    .finally(function () { clearTimeout(timer); });
}

/**
 * Applique le compte Riot choisi dans les réglages iCUE (vide = compte du .env).
 * Résout true si le compte suivi vient de changer.
 */
function syncAccount() {
  var wanted = String(prop('riotAccount', '')).trim();
  if (wanted === state.appliedAccount) return Promise.resolve(false);
  return api('/api/account?riotId=' + encodeURIComponent(wanted), 'POST')
    .then(function () {
      var changed = state.appliedAccount !== undefined;
      state.appliedAccount = wanted;
      state.accountError = null;
      return changed;
    })
    .catch(function (err) {
      // 400/404 : saisie invalide ou compte inexistant → on n'insiste pas jusqu'à la prochaine modification.
      // Backend injoignable : on réessaiera au prochain rafraîchissement.
      if (err.status === 400 || err.status === 404) {
        state.appliedAccount = wanted;
        state.accountError = err.message;
      }
      return false;
    });
}

function refresh() {
  return syncAccount().then(function (changed) {
    if (changed) {
      state.live = null;
      refreshLive();
    }
    return refreshSession();
  });
}

function refreshSession() {
  var request = api('/api/session?mode=' + state.mode + '&period=' + state.period);
  state.inflight = request;
  return request
    .then(function (data) {
      if (state.inflight !== request) return; // une sélection plus récente a pris le relais
      state.data = data;
      state.lastOkAt = new Date();
      state.online = true;
      render();
    })
    .catch(function (err) {
      if (state.inflight !== request) return;
      state.online = false;
      state.lastError = err && err.message ? err.message : String(err);
      render();
    });
}

function refreshLive() {
  return api('/api/live')
    .then(function (body) {
      var game = body.game || null;
      var previous = state.live;
      state.live = game;
      state.liveFetchedAt = Date.now();

      if (game && boolProp('autoLiveView', true) && state.autoSwitchedGameId !== game.gameId) {
        state.autoSwitchedGameId = game.gameId;
        state.view = 'live';
      }
      if (!game && previous && state.view === 'live') {
        state.view = 'session'; // partie terminée : retour au bilan, qui se met à jour
        refresh();
      }
      renderLiveButton();
      if (state.view === 'live') renderLive();
      applyView();
    })
    .catch(function () {
      /* le statut « hors ligne » est géré par refresh() */
    })
    .finally(scheduleLivePoll);
}

function scheduleRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(refresh, state.refreshMs);
}

function scheduleLivePoll() {
  if (state.liveTimer) clearTimeout(state.liveTimer);
  state.liveTimer = setTimeout(refreshLive, state.view === 'live' ? LIVE_POLL_ACTIVE_MS : LIVE_POLL_IDLE_MS);
}

// ---------------------------------------------------------------------------
// Mise en forme
// ---------------------------------------------------------------------------

function $(id) { return document.getElementById(id); }

function setText(id, text) {
  var node = $(id);
  if (node) node.textContent = text;
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function img(className, src) {
  var node = el('img', className);
  node.alt = '';
  node.onerror = function () { node.style.visibility = 'hidden'; };
  node.src = src;
  return node;
}

function signed(n) {
  return (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n);
}

function pct(v) {
  return v === null || v === undefined ? '—' : Math.round(v * 100) + ' %';
}

function num(v, digits) {
  return v === null || v === undefined ? '—' : Number(v).toFixed(digits).replace('.', ',');
}

/** 1 919 463 → « 1,9 M » ; 54 900 → « 54,9 k » ; 850 → « 850 ». */
function kilo(v) {
  if (v >= 1000000) return String(Math.round(v / 100000) / 10).replace('.', ',') + ' M';
  if (v >= 1000) return String(Math.round(v / 100) / 10).replace('.', ',') + ' k';
  return String(v);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function hhmm(date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

function clock(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  return pad2(Math.floor(seconds / 60)) + ':' + pad2(seconds % 60);
}

function duration(seconds) {
  return Math.floor(seconds / 60) + ':' + pad2(seconds % 60);
}

function playTime(seconds) {
  var h = Math.floor(seconds / 3600);
  var m = Math.round((seconds % 3600) / 60);
  return h ? h + ' h ' + pad2(m) : m + ' min';
}

function timeAgo(iso) {
  var date = new Date(iso);
  var diffMin = Math.round((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return 'il y a ' + diffMin + ' min';
  if (diffMin < 6 * 60) return 'il y a ' + Math.floor(diffMin / 60) + ' h';
  var today = new Date();
  var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "aujourd'hui " + hhmm(date);
  if (date.toDateString() === yesterday.toDateString()) return 'hier ' + hhmm(date);
  return pad2(date.getDate()) + '/' + pad2(date.getMonth() + 1) + ' ' + hhmm(date);
}

var POSITIONS = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };
var MODE_LABELS = { rsolo: 'Solo/Duo', flex: 'Flex', normal: 'Normales', aram: 'ARAM', all: 'Toutes les files' };

// ---------------------------------------------------------------------------
// Rendu — vue session
// ---------------------------------------------------------------------------

function applyView() {
  $('widget').setAttribute('data-view', state.view === 'live' && state.live ? 'live' : 'session');
}

function render() {
  var widget = $('widget');
  widget.setAttribute('data-online', state.online === null ? '' : String(state.online));
  renderTabs();
  renderStatus();
  renderLiveButton();
  applyView();

  var d = state.data;
  if (!d) {
    widget.setAttribute('data-state', state.online === false ? 'error' : 'loading');
    showPlaceholder(
      state.online === false
        ? 'Backend injoignable (' + apiBase() + '). Lance « npm run dev » dans le dossier backend.'
        : 'Connexion au backend…'
    );
    return;
  }
  widget.setAttribute('data-state', 'content');
  renderRank(d);
  renderSummary(d);
  renderLp(d);
  renderStreak(d);
  renderStats(d);
  renderChampions(d);
  renderSequence(d);
  renderMatches(d);
  renderSessionButton(d);

  // Aperçu dans un navigateur : index.html?champ=0 ouvre la fiche du 1er champion (jamais en iCUE).
  var previewChamp = new URLSearchParams(location.search).get('champ');
  if (previewChamp !== null && !state.previewSheetShown && d.topChampions && d.topChampions[previewChamp]) {
    state.previewSheetShown = true;
    openChampionSheet(d.topChampions[previewChamp]);
  }
  // Idem : index.html?match=0 ouvre la fiche de la 1re partie de l'historique.
  var previewMatch = new URLSearchParams(location.search).get('match');
  if (previewMatch !== null && !state.previewMatchShown && d.matches[previewMatch]) {
    state.previewMatchShown = true;
    openMatchSheet(d.matches[previewMatch].matchId);
  }
}

function renderTabs() {
  var tabs = document.querySelectorAll('[data-mode]');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mode') === state.mode);
  tabs = document.querySelectorAll('[data-period]');
  for (i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-period') === state.period);
}

function renderStatus() {
  if (state.accountError) {
    setText('status-text', state.accountError);
    $('status').classList.add('error');
    return;
  }
  $('status').classList.remove('error');
  if (state.online === false) {
    setText('status-text', 'hors ligne' + (state.lastOkAt ? ' · données de ' + hhmm(state.lastOkAt) : ''));
  } else if (state.lastOkAt) {
    setText('status-text', 'à jour · ' + hhmm(state.lastOkAt));
  } else {
    setText('status-text', '…');
  }
}

function renderRank(d) {
  setText('account-name', d.account ? d.account.gameName + '#' + d.account.tagLine : '');
  var emblem = $('emblem');
  if (d.rank) {
    var r = d.rank;
    setText('rank-tier', r.label);
    // Hors Solo/Flex, le backend renvoie le rang Solo/Duo à titre de référence.
    var queueName = r.queueType === 'RANKED_FLEX_SR' ? 'Flex' : 'Solo/Duo';
    setText('rank-lp', r.lp + ' LP' + (d.mode === 'rsolo' || d.mode === 'flex' ? '' : ' · ' + queueName));
    // Barre : position dans la division (0-100 LP) ; pleine au-delà pour Master+.
    $('lp-fill').style.width = Math.max(2, Math.min(100, r.lp)) + '%';
    var season = r.wins + ' V · ' + r.losses + ' D · ' + pct(r.winrate);
    if (r.atPeriodStart && (r.atPeriodStart.label !== r.label || r.atPeriodStart.lp !== r.lp)) {
      season += ' · départ ' + r.atPeriodStart.label + ' ' + r.atPeriodStart.lp + ' LP';
    }
    setText('rank-season', season);
    emblem.parentNode.style.display = '';
    var src = apiBase() + r.emblem;
    if (emblem.getAttribute('src') !== src) {
      emblem.classList.remove('ready');
      emblem.onload = function () { emblem.classList.add('ready'); };
      emblem.src = src;
    }
  } else {
    emblem.classList.remove('ready');
    emblem.removeAttribute('src');
    $('emblem').parentNode.style.display = 'none';
    setText('rank-tier', MODE_LABELS[d.mode] || d.mode);
    setText('rank-lp', d.mode === 'rsolo' || d.mode === 'flex' ? 'Non classé' : 'Pas de rang dans ce mode');
    $('lp-fill').style.width = '0';
    setText('rank-season', '');
  }
}

function renderSummary(d) {
  var s = d.summary;
  setText('wins', s.wins);
  setText('losses', s.losses);
  var sub;
  if (d.period === 'session' && !d.session) {
    sub = 'Aucune session en cours';
  } else if (s.games === 0) {
    sub = d.period === 'session'
      ? 'Session démarrée à ' + hhmm(new Date(d.session.startedAt)) + ' · en attente d’une partie'
      : 'Aucune partie sur la période';
  } else {
    sub = pct(s.winrate) + ' de victoires · ' + s.games + ' partie' + (s.games > 1 ? 's' : '');
    if (s.remakes) sub += ' · ' + s.remakes + ' remake' + (s.remakes > 1 ? 's' : '');
  }
  setText('hero-sub', sub);
}

function renderLp(d) {
  var card = $('kpi-lp');
  if (!d.lp) {
    card.setAttribute('data-tone', '');
    setText('lp-net', '—');
    setText('lp-foot', 'pas de LP dans ce mode');
    return;
  }
  if (d.summary.games === 0 && d.summary.remakes === 0 && !d.lp.adjustments) {
    card.setAttribute('data-tone', '');
    setText('lp-net', '—');
    setText('lp-foot', 'aucune partie');
    return;
  }
  var approx = d.lp.source === 'estimated';
  card.setAttribute('data-tone', d.lp.net > 0 ? 'win' : d.lp.net < 0 ? 'loss' : '');
  setText('lp-net', (approx ? '≈ ' : '') + signed(d.lp.net));
  var foot = approx ? 'estimé' : 'exact';
  if (d.lp.adjustments) foot += ' · dont ' + signed(d.lp.adjustments) + ' hors partie';
  setText('lp-foot', foot);
}

function renderStreak(d) {
  var card = $('kpi-streak');
  var cur = d.streak.current;
  if (!cur) {
    card.setAttribute('data-tone', '');
    setText('streak-value', '—');
    setText('streak-foot', 'aucune partie');
    return;
  }
  var win = cur.result === 'W';
  card.setAttribute('data-tone', win ? 'win' : 'loss');
  setText('streak-value', cur.count + (win ? ' V' : ' D'));
  var foot = (win ? 'victoire' : 'défaite') + (cur.count > 1 ? 's' : '') + ' d’affilée';
  if (d.summary.games) foot += ' · max ' + d.streak.longestWinInPeriod + 'V/' + d.streak.longestLossInPeriod + 'D';
  setText('streak-foot', foot);
}

function renderStats(d) {
  var s = d.summary;
  setText('st-kda', num(s.kda, 2));
  setText('st-k', num(s.avgKills, 1));
  setText('st-d', num(s.avgDeaths, 1));
  setText('st-a', num(s.avgAssists, 1));
  setText('st-cs', num(s.csPerMin, 1));
  setText('st-cs-sub', s.avgCs !== null && s.avgCs !== undefined ? s.avgCs + ' CS / partie' : '');
  setText('st-vision', num(s.avgVision, 0));
  setText('st-kp', pct(s.avgKillParticipation));
  setText('st-time', s.timePlayedS ? playTime(s.timePlayedS) : '—');
}

// ---------------------------------------------------------------------------
// Top champions + fiche détaillée
// ---------------------------------------------------------------------------

function renderChampions(d) {
  var list = $('champ-list');
  list.textContent = '';
  var champs = d.topChampions || [];
  if (!champs.length) {
    list.appendChild(el('span', 'champ-empty', 'Aucune partie sur la période'));
    return;
  }
  champs.forEach(function (c, i) {
    var card = el('button', 'champ-card');
    card.setAttribute('data-index', i);
    card.appendChild(img('', apiBase() + c.champion.icon));
    card.appendChild(cell('', c.champion.displayName, c.games + ' p · ' + pct(c.winrate)));
    list.appendChild(card);
  });
}

function onChampionClick(e) {
  var card = e.target.closest('.champ-card');
  if (!card || !state.data) return;
  var c = state.data.topChampions[Number(card.getAttribute('data-index'))];
  if (c) openChampionSheet(c);
}

function tile(value, label, sub, valueClass) {
  var t = el('div', 'tile');
  t.appendChild(el('span', 'big' + (valueClass ? ' ' + valueClass : ''), value));
  t.appendChild(el('span', 'tile-label', label));
  if (sub) t.appendChild(el('span', 'tile-sub', sub));
  return t;
}

function openChampionSheet(c) {
  var splash = $('sheet-splash');
  splash.classList.remove('ready');
  splash.onload = function () { splash.classList.add('ready'); };
  splash.src = apiBase() + '/api/assets/splash/' + encodeURIComponent(c.champion.name) + '/0.jpg';
  $('sheet-icon').src = apiBase() + c.champion.icon;
  setText('sheet-name', c.champion.displayName);
  setText('sheet-mastery', c.mastery
    ? 'Maîtrise niveau ' + c.mastery.level + ' · ' + c.mastery.points.toLocaleString('fr-FR') + ' points'
    : 'Maîtrise indisponible');

  var grid = $('sheet-grid');
  grid.textContent = '';
  grid.appendChild(tile(c.wins + ' V · ' + c.losses + ' D', 'Parties', c.games + ' sur la période'));
  grid.appendChild(tile(pct(c.winrate), 'Winrate', null, c.winrate >= 0.5 ? 'pos' : 'neg'));
  grid.appendChild(tile(num(c.kda, 2), 'KDA', num(c.avgKills, 1) + ' / ' + num(c.avgDeaths, 1) + ' / ' + num(c.avgAssists, 1)));
  grid.appendChild(tile(num(c.csPerMin, 1), 'CS / min', c.avgCs + ' CS / partie'));
  grid.appendChild(tile(kilo(c.avgDamage), 'Dégâts / partie'));
  grid.appendChild(tile(pct(c.avgKillParticipation), 'Participation'));
  grid.appendChild(c.lpNet === null || c.lpNet === undefined
    ? tile('—', 'LP', 'pas de partie classée')
    : tile((c.lpSource === 'estimated' ? '≈ ' : '') + signed(c.lpNet), 'LP', c.lpSource === 'estimated' ? 'estimé' : 'exact', c.lpNet >= 0 ? 'pos' : 'neg'));
  grid.appendChild(tile(timeAgo(c.lastPlayedAt), 'Dernière partie'));

  $('champ-overlay').classList.add('open');
}

/** Ferme une fiche (champion ou partie) sur le bouton ✕ ou en touchant le fond, pas l'intérieur. */
function closeOverlay(e) {
  // Uniquement un appui sur le fond lui-même ou sur ✕. On ne teste PAS « en dehors de la fiche » :
  // un appui sur une lane reconstruit la fiche, l'élément touché est alors détaché du DOM et
  // closest('.sheet') renverrait null — ce qui fermait la fiche à tort.
  if (e.target !== e.currentTarget && !e.target.closest('.close-btn')) return;
  e.currentTarget.classList.remove('open');
}

// ---------------------------------------------------------------------------
// Fiche partie : onglet « Tableau » (10 joueurs, ★, rangs) et onglet « Duels » (5 lanes)
// ---------------------------------------------------------------------------

function onMatchClick(e) {
  var row = e.target.closest('.match');
  if (row && row.getAttribute('data-match-id')) openMatchSheet(row.getAttribute('data-match-id'));
}

function openMatchSheet(matchId) {
  state.openMatchId = matchId;
  state.openMatch = null;
  state.matchTab = 'table';
  state.duelLane = null;
  setText('m-result', '—');
  $('m-result').className = 'result-badge';
  setText('m-title', 'Chargement…');
  setText('m-sub', '');
  $('m-chips').textContent = '';
  $('m-duel').textContent = '';
  $('m-tabs').style.display = 'none';
  var body = $('m-body');
  body.textContent = '';
  body.appendChild(el('div', 'mloading', 'Chargement de la partie…'));
  $('match-overlay').classList.add('open');

  api('/api/match/' + encodeURIComponent(matchId))
    .then(function (m) {
      if (state.openMatchId !== matchId) return;
      state.openMatch = m;
      var mine = m.duels.filter(function (d) { return d.isMine; })[0];
      state.duelLane = mine ? mine.position : (m.duels[0] ? m.duels[0].position : null);
      // Aperçu navigateur : &tab=duels ouvre directement l'onglet Duels (jamais en iCUE).
      if (new URLSearchParams(location.search).get('tab') === 'duels') state.matchTab = 'duels';
      renderMatchSheet();
    })
    .catch(function (err) {
      body.textContent = '';
      body.appendChild(el('div', 'mloading', 'Partie indisponible : ' + err.message));
    });
}

var RESULT_LABELS = { W: 'Victoire', L: 'Défaite', REMAKE: 'Remake' };

function playerIndex(m) {
  var map = {};
  m.teams.forEach(function (t) { t.players.forEach(function (p) { map[p.puuid] = p; }); });
  return map;
}

function renderMatchSheet() {
  var m = state.openMatch;
  if (!m) return;
  $('m-result').className = 'result-badge ' + (m.result || '');
  setText('m-result', m.result ? RESULT_LABELS[m.result].toUpperCase() : '—');
  setText('m-title', m.queue);
  setText('m-sub', duration(m.durationS) + ' · ' + timeAgo(m.endedAt));

  // LP de la partie + rang juste après
  var chips = $('m-chips');
  chips.textContent = '';
  if (m.lp && m.lp.delta !== null && m.lp.delta !== undefined) {
    var approx = m.lp.source === 'estimated' && m.result !== 'REMAKE';
    var lpChip = el('div', 'mchip ' + (m.lp.delta > 0 ? 'pos' : m.lp.delta < 0 ? 'neg' : ''));
    lpChip.appendChild(el('span', 'v', (approx ? '≈ ' : '') + signed(m.lp.delta) + ' LP'));
    lpChip.appendChild(el('span', 'l', approx ? 'estimé' : 'exact'));
    chips.appendChild(lpChip);
  }
  if (m.rankAfter) {
    var rankChip = el('div', 'mchip rank');
    rankChip.appendChild(img('', apiBase() + m.rankAfter.emblem));
    var txt = el('div');
    txt.appendChild(el('span', 'v', m.rankAfter.label + ' · ' + m.rankAfter.lp + ' LP'));
    txt.appendChild(el('span', 'l', 'après la partie'));
    rankChip.appendChild(txt);
    chips.appendChild(rankChip);
  }

  // Résumé du duel de ma lane (appui → onglet Duels)
  var duel = $('m-duel');
  duel.textContent = '';
  var mine = m.duels.filter(function (d) { return d.isMine; })[0];
  if (mine) {
    var opp = playerIndex(m)[mine.enemy];
    duel.appendChild(el('span', 'duel-label', 'Duel ' + (POSITIONS[mine.position] || '') + ' vs'));
    if (opp) duel.appendChild(img('', apiBase() + opp.champion.icon));
    ['damage', 'cs', 'gold'].forEach(function (id) {
      var s = mine.stats.filter(function (x) { return x.id === id; })[0];
      if (!s) return;
      var diff = s.ally - s.enemy;
      var box = el('div', 'duel-stat');
      var text = s.format === 'k' ? (diff > 0 ? '+' : diff < 0 ? '−' : '±') + kilo(Math.abs(diff)) : signed(Math.round(diff));
      box.appendChild(el('span', 'v ' + (diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''), text));
      box.appendChild(el('span', 'l', s.label));
      duel.appendChild(box);
    });
    duel.appendChild(el('span', 'duel-more', 'Détails ›'));
  }

  var tabs = $('m-tabs');
  tabs.style.display = m.duels.length ? '' : 'none';
  renderMatchTabs();
  renderMatchBody();
}

function renderMatchTabs() {
  var buttons = $('m-tabs').querySelectorAll('[data-tab]');
  for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle('active', buttons[i].getAttribute('data-tab') === state.matchTab);
}

function setMatchTab(tab, lane) {
  if (!state.openMatch) return;
  state.matchTab = tab;
  if (lane) state.duelLane = lane;
  renderMatchTabs();
  renderMatchBody();
}

function renderMatchBody() {
  var m = state.openMatch;
  var body = $('m-body');
  body.textContent = '';
  body.className = 'mbody ' + state.matchTab;
  if (state.matchTab === 'duels' && m.duels.length) {
    body.appendChild(duelsView(m));
  } else {
    m.teams.forEach(function (t) { body.appendChild(matchTeam(t, m.badgeLabels)); });
  }
}

// ----- Onglet Tableau -----

function matchTeam(t, badgeLabels) {
  var box = el('div', 'mteam ' + t.side);
  var head = el('div', 'mteam-head');
  head.appendChild(el('span', 'team-result ' + (t.win ? 'W' : 'L'), (t.isMine ? 'Ton équipe · ' : 'Adversaires · ') + (t.win ? 'Victoire' : 'Défaite')));
  head.appendChild(el('span', 'muted', t.kills + ' / ' + t.deaths + ' / ' + t.assists + ' · ' + kilo(t.gold) + ' or'));
  box.appendChild(head);

  var labels = el('div', 'mrow labels');
  ['', 'Joueur', 'Rang', 'K / D / A', 'CS', 'Dégâts', 'Or', 'KP'].forEach(function (l, i) {
    labels.appendChild(el('span', i === 2 ? 'c-rank' : i === 6 ? 'c-gold' : i === 7 ? 'c-kp' : '', l));
  });
  box.appendChild(labels);

  t.players.forEach(function (p) { box.appendChild(matchPlayerRow(p, badgeLabels)); });
  return box;
}

/** Cellule dont la valeur passe en doré avec une ★ si le joueur est le meilleur de la partie. */
function starCell(className, main, sub, starred, title) {
  var c = cell(className, main, sub);
  if (starred) {
    c.firstChild.classList.add('starred');
    var star = el('span', 'star', '★');
    star.title = title || '';
    c.firstChild.appendChild(star);
  }
  return c;
}

function rankCell(rank, className) {
  var c = el('div', 'rank-mini ' + (className || ''));
  if (rank) {
    c.appendChild(img('', apiBase() + rank.emblem));
    c.appendChild(cell('', rank.label, rank.lp + ' LP'));
  } else {
    c.appendChild(cell('', 'Non classé', ''));
  }
  return c;
}

function matchPlayerRow(p, badgeLabels) {
  var has = function (id) { return p.badges.indexOf(id) >= 0; };
  var row = el('div', 'mrow player-line' + (p.isMe ? ' me' : ''));

  var wrap = el('div', 'icon-wrap');
  wrap.appendChild(img('icon', apiBase() + p.champion.icon));
  if (p.level) wrap.appendChild(el('span', 'lvl', p.level));
  row.appendChild(wrap);

  row.appendChild(cell('', p.champion.displayName, (p.position && POSITIONS[p.position] ? POSITIONS[p.position] + ' · ' : '') + p.riotId.split('#')[0]));
  row.appendChild(rankCell(p.rank, 'c-rank'));
  row.appendChild(starCell('', p.kills + ' / ' + p.deaths + ' / ' + p.assists, 'KDA ' + num(p.kda, 2), has('kda') || has('kills'), has('kills') ? badgeLabels.kills : badgeLabels.kda));
  row.appendChild(starCell('', String(p.cs), num(p.csPerMin, 1) + ' / min', has('cs'), badgeLabels.cs));

  var dmg = starCell('', kilo(p.damage), pct(p.damageShare) + ' équipe', has('damage'), badgeLabels.damage);
  var bar = el('div', 'dmg-bar');
  var fill = el('div');
  fill.style.width = Math.round(p.damageShare * 100) + '%';
  bar.appendChild(fill);
  dmg.appendChild(bar);
  row.appendChild(dmg);

  row.appendChild(starCell('c-gold', kilo(p.gold), '', has('gold'), badgeLabels.gold));
  row.appendChild(starCell('c-kp', pct(p.killParticipation), '', has('kp'), badgeLabels.kp));
  return row;
}

// ----- Onglet Duels -----

function formatStat(v, format) {
  if (format === 'k') return kilo(v);
  if (format === 'pct') return pct(v);
  if (format === 'dec1') return num(v, 1);
  if (format === 'dec2') return num(v, 2);
  return String(Math.round(v));
}

function duelsView(m) {
  var players = playerIndex(m);
  var view = el('div', 'duels');

  // Sélecteur de lane : aperçu de l'écart d'or de chaque lane
  var lanes = el('div', 'lane-chips');
  m.duels.forEach(function (d) {
    var ally = players[d.ally];
    var enemy = players[d.enemy];
    var chip = el('button', 'lane-chip' + (d.position === state.duelLane ? ' active' : '') + (d.isMine ? ' mine' : ''));
    chip.setAttribute('data-lane', d.position);
    chip.appendChild(el('span', 'lane-name', POSITIONS[d.position] || d.position));
    if (ally) chip.appendChild(img('', apiBase() + ally.champion.icon));
    chip.appendChild(el('span', 'vs', 'vs'));
    if (enemy) chip.appendChild(img('', apiBase() + enemy.champion.icon));
    chip.appendChild(el('span', 'gold ' + (d.goldDiff > 0 ? 'pos' : d.goldDiff < 0 ? 'neg' : ''),
      (d.goldDiff > 0 ? '+' : d.goldDiff < 0 ? '−' : '±') + kilo(Math.abs(d.goldDiff)) + ' or'));
    lanes.appendChild(chip);
  });
  view.appendChild(lanes);

  var duel = m.duels.filter(function (d) { return d.position === state.duelLane; })[0] || m.duels[0];
  var ally = players[duel.ally];
  var enemy = players[duel.enemy];

  var faceoff = el('div', 'faceoff');
  faceoff.appendChild(duelPlayer(ally, 'ally'));
  var score = el('div', 'faceoff-score');
  var allyWins = duel.stats.filter(function (s) { return s.winner === 'ally'; }).length;
  var enemyWins = duel.stats.filter(function (s) { return s.winner === 'enemy'; }).length;
  score.appendChild(el('span', 'n ally', String(allyWins)));
  score.appendChild(el('span', 'sep', 'sur ' + duel.stats.length));
  score.appendChild(el('span', 'n enemy', String(enemyWins)));
  faceoff.appendChild(score);
  faceoff.appendChild(duelPlayer(enemy, 'enemy'));
  view.appendChild(faceoff);

  // 3 blocs (Combat / Farm & or / Carte), une ligne par stat :
  //   valeur alliée · libellé + écart · valeur ennemie, puis une barre qui part du centre
  //   vers le côté qui a l'avantage (longueur = ampleur de l'avantage).
  var groups = el('div', 'dgroups');
  Object.keys(m.duelGroupLabels).forEach(function (g) {
    var stats = duel.stats.filter(function (s) { return s.group === g; });
    if (!stats.length) return;
    var box = el('div', 'dgroup');
    box.appendChild(el('div', 'dgroup-title', m.duelGroupLabels[g]));
    stats.forEach(function (s) { box.appendChild(duelStatRow(s, ally, enemy)); });
    groups.appendChild(box);
  });
  view.appendChild(groups);
  return view;
}

function duelValue(s, p, side) {
  // KDA : on montre K/D/A (plus parlant) avec le ratio en petit.
  var box = el('div', 'dval ' + side + (s.winner === side ? ' win' : s.winner ? ' lose' : ''));
  if (s.id === 'kda' && p) {
    box.appendChild(el('span', 'big', p.kills + '/' + p.deaths + '/' + p.assists));
    box.appendChild(el('span', 'small', num(s[side], 2) + ' KDA'));
  } else {
    box.appendChild(el('span', 'big', formatStat(s[side], s.format)));
  }
  return box;
}

function duelStatRow(s, ally, enemy) {
  var row = el('div', 'drow');
  var top = el('div', 'drow-top');
  top.appendChild(duelValue(s, ally, 'ally'));

  var mid = el('div', 'dcenter');
  mid.appendChild(el('span', 'dlabel', s.label));
  var diffText = s.winner === null ? 'égalité'
    : (s.format === 'k' ? (s.diff > 0 ? '+' : '−') + kilo(Math.abs(s.diff))
      : s.format === 'pct' ? (s.diff > 0 ? '+' : '−') + Math.round(Math.abs(s.diff) * 100) + ' pts'
      : (s.diff > 0 ? '+' : '−') + formatStat(Math.abs(s.diff), s.format));
  mid.appendChild(el('span', 'ddiff ' + (s.winner || 'even'), diffText));
  top.appendChild(mid);

  top.appendChild(duelValue(s, enemy, 'enemy'));
  row.appendChild(top);

  var bar = el('div', 'dbar2');
  var left = el('div', 'half left');
  var right = el('div', 'half right');
  var fill = el('div', 'fill');
  fill.style.width = Math.max(4, Math.round(s.advantage * 100)) + '%';
  if (s.winner === 'ally') left.appendChild(fill);
  else if (s.winner === 'enemy') right.appendChild(fill);
  bar.appendChild(left);
  bar.appendChild(right);
  row.appendChild(bar);
  return row;
}

function duelPlayer(p, side) {
  var box = el('div', 'duel-player ' + side + (p && p.isMe ? ' me' : ''));
  if (!p) return box;
  box.appendChild(img('icon', apiBase() + p.champion.icon));
  var id = el('div', 'duel-id');
  id.appendChild(el('span', 'name', p.champion.displayName));
  id.appendChild(el('span', 'sub', p.riotId.split('#')[0] + ' · ' + p.kills + '/' + p.deaths + '/' + p.assists));
  box.appendChild(id);
  box.appendChild(rankCell(p.rank));
  return box;
}

function onMatchSheetClick(e) {
  var tab = e.target.closest('[data-tab]');
  if (tab) return setMatchTab(tab.getAttribute('data-tab'));
  var lane = e.target.closest('[data-lane]');
  if (lane) return setMatchTab('duels', lane.getAttribute('data-lane'));
  if (e.target.closest('#m-duel')) return setMatchTab('duels', state.duelLane);
}

function renderSequence(d) {
  var box = $('sequence');
  box.textContent = '';
  var seq = d.streak.sequence.slice(-MAX_PILLS).split('');
  for (var i = 0; i < seq.length; i++) {
    if (seq[i]) box.appendChild(el('span', 'pill ' + seq[i], seq[i] === 'W' ? 'V' : 'D'));
  }
}

function renderMatches(d) {
  var list = $('matches');
  list.textContent = '';
  if (!d.matches.length) {
    showPlaceholder(
      d.period === 'session' && !d.session
        ? 'Appuie sur « Démarrer » au début de ta session de jeu.'
        : 'Aucune partie ' + (d.period === 'session' ? 'depuis le début de la session' : 'sur la période') + '.'
    );
    return;
  }
  $('widget').setAttribute('data-list', 'matches');
  var rows = d.matches.slice(0, MAX_MATCH_ROWS);
  for (var i = 0; i < rows.length; i++) list.appendChild(matchRow(rows[i]));
}

function cell(className, main, sub, mainClass) {
  var c = el('div', 'cell ' + className);
  c.appendChild(el('span', 'main' + (mainClass ? ' ' + mainClass : ''), main));
  if (sub !== undefined) c.appendChild(el('span', 'sub', sub));
  return c;
}

function matchRow(m) {
  var row = el('div', 'match ' + m.result);
  row.setAttribute('data-match-id', m.matchId); // appui → fiche de la partie

  var wrap = el('div', 'icon-wrap');
  wrap.appendChild(img('icon', apiBase() + m.champion.icon));
  wrap.appendChild(el('span', 'badge', m.result === 'W' ? 'V' : m.result === 'L' ? 'D' : 'R'));
  row.appendChild(wrap);

  row.appendChild(cell('champ', m.champion.displayName, m.queue + (m.position && POSITIONS[m.position] ? ' · ' + POSITIONS[m.position] : '')));
  row.appendChild(cell('kda', m.kills + ' / ' + m.deaths + ' / ' + m.assists, 'KDA ' + num(m.kda, 2)));
  row.appendChild(cell('cs', num(m.csPerMin, 1) + ' cs/min', m.cs + ' CS'));
  row.appendChild(cell('kp', pct(m.killParticipation), 'particip.'));
  row.appendChild(cell('extra', kilo(m.damage), 'dégâts'));
  row.appendChild(cell('extra', kilo(m.gold), 'or'));

  if (m.lpDelta === null || m.lpDelta === undefined) {
    row.appendChild(cell('lp end', '—', m.result === 'REMAKE' ? 'remake' : 'sans LP'));
  } else {
    var approx = m.lpSource === 'estimated' && m.result !== 'REMAKE';
    row.appendChild(cell('lp end', (approx ? '≈ ' : '') + signed(m.lpDelta) + ' LP', approx ? 'estimé' : 'exact',
      m.lpDelta > 0 ? 'pos' : m.lpDelta < 0 ? 'neg' : ''));
  }
  row.appendChild(cell('time end', timeAgo(m.endedAt), duration(m.durationS)));
  return row;
}

function showPlaceholder(text) {
  $('widget').setAttribute('data-list', 'placeholder');
  setText('placeholder', text);
}

function renderSessionButton(d) {
  var btn = $('session-btn');
  if (state.confirmTimer) return; // en attente de confirmation, ne pas écraser
  btn.disabled = state.busy;
  if (d.session) {
    btn.setAttribute('data-variant', 'stop');
    btn.textContent = 'Terminer';
  } else {
    btn.setAttribute('data-variant', 'start');
    btn.textContent = 'Démarrer';
  }
}

// ---------------------------------------------------------------------------
// Rendu — partie en cours
// ---------------------------------------------------------------------------

function renderLiveButton() {
  var btn = $('live-btn');
  btn.disabled = !state.live;
  setText('live-btn-text', state.live ? 'En jeu · ' + clock(liveSeconds()) : 'Pas en partie');
}

/** Temps de jeu affiché : Live Client si dispo, sinon Spectator ; extrapolé entre deux requêtes. */
function liveSeconds() {
  var g = state.live;
  if (!g) return 0;
  var base = g.gameTimeS !== null && g.gameTimeS !== undefined ? g.gameTimeS : g.elapsedS;
  return base + (Date.now() - state.liveFetchedAt) / 1000;
}

function renderLive() {
  var g = state.live;
  if (!g) return;
  setText('live-queue', g.queue);
  setText('live-timer', clock(liveSeconds()));

  var progress = $('live-progress');
  var ratio = g.progress.total ? g.progress.done / g.progress.total : 1;
  progress.classList.toggle('done', g.status === 'complete');
  $('live-fill').style.width = Math.round(ratio * 100) + '%';
  setText('live-progress-text', 'Analyse des joueurs · ' + Math.round(ratio * 100) + ' %');

  var bans = $('bans');
  bans.textContent = '';
  var myTeamId = g.teams[0] ? g.teams[0].teamId : 100;
  var mine = g.bans.filter(function (b) { return b.teamId === myTeamId; });
  var theirs = g.bans.filter(function (b) { return b.teamId !== myTeamId; });
  if (g.bans.length) bans.appendChild(el('span', 'section-label', 'Bans'));
  mine.forEach(function (b) { bans.appendChild(img('', apiBase() + b.icon)); });
  if (mine.length && theirs.length) bans.appendChild(el('span', 'sep'));
  theirs.forEach(function (b) { bans.appendChild(img('', apiBase() + b.icon)); });

  var teams = $('teams');
  teams.textContent = '';
  g.teams.forEach(function (t) { teams.appendChild(teamColumn(t)); });
}

function teamColumn(t) {
  var col = el('div', 'team ' + t.side + (t.isMine ? ' mine' : ''));
  var head = el('div', 'team-head');
  head.appendChild(el('span', 'team-name', t.isMine ? 'Ton équipe' : 'Adversaires'));
  if (t.avgRank) {
    head.appendChild(img('emblem-sm', apiBase() + t.avgRank.emblem));
    head.appendChild(el('span', '', t.avgRank.label + ' moy.'));
  }
  if (t.avgRecentWinrate !== null && t.avgRecentWinrate !== undefined) {
    head.appendChild(el('span', 'muted', '· ' + pct(t.avgRecentWinrate) + ' récent'));
  }
  col.appendChild(head);

  var players = el('div', 'players');
  t.players.forEach(function (p) { players.appendChild(playerRow(p)); });
  col.appendChild(players);
  return col;
}

function skeleton() {
  var c = el('div', 'cell');
  c.appendChild(el('span', 'skel'));
  return c;
}

function playerRow(p) {
  var row = el('div', 'player' + (p.isMe ? ' me' : ''));

  // Champion (+ niveau en direct si le Live Client répond)
  var wrap = el('div', 'icon-wrap');
  wrap.appendChild(img('icon', apiBase() + p.champion.icon));
  if (p.live) wrap.appendChild(el('span', 'lvl', p.live.level));
  row.appendChild(wrap);

  // Identité : pseudo, champion · rôle principal, et score en direct
  // Rôle (déduit par le backend : lignes alignées Top/Top, Jungle/Jungle…), puis champion ou score en direct
  var role = p.position && POSITIONS[p.position] ? POSITIONS[p.position] : null;
  var sub = p.live
    ? p.live.kills + '/' + p.live.deaths + '/' + p.live.assists + ' · ' + p.live.cs + ' CS'
    : p.champion.name;
  var id = cell('name', p.gameName, sub);
  if (role) id.insertBefore(el('span', 'role-tag', role), id.firstChild);
  row.appendChild(id);

  // Rang
  if (!p.loaded.rank && p.puuid) {
    row.appendChild(skeleton());
  } else if (p.rank) {
    var rc = el('div', 'rank-cell');
    rc.appendChild(img('', apiBase() + p.rank.emblem));
    rc.appendChild(cell('', p.rank.label, p.rank.lp + ' LP · ' + pct(p.rank.winrate) + ' (' + (p.rank.wins + p.rank.losses) + ')'));
    row.appendChild(rc);
  } else {
    row.appendChild(cell('', p.puuid ? 'Non classé' : '—', p.bot ? 'bot' : p.puuid ? 'cette saison' : 'masqué'));
  }

  // Forme récente : winrate des N dernières + 5 derniers résultats
  if (p.recent && p.recent.games) {
    var rec = cell('', pct(p.recent.winrate) + ' récent', p.recent.games + ' parties' + (p.loaded.recent ? '' : '…'),
      p.recent.winrate >= 0.55 ? 'pos' : p.recent.winrate <= 0.45 ? 'neg' : '');
    var dots = el('div', 'dots');
    p.recent.last5.forEach(function (r) { dots.appendChild(el('span', 'dot ' + r)); });
    rec.appendChild(dots);
    row.appendChild(rec);
  } else if (p.puuid && !p.loaded.recent) {
    row.appendChild(skeleton());
  } else {
    row.appendChild(cell('', '—', 'pas d’historique'));
  }

  // Maîtrise du champion joué
  if (!p.loaded.mastery && p.puuid) {
    var sk = skeleton();
    sk.classList.add('mastery-cell');
    row.appendChild(sk);
  } else {
    var mc = p.mastery
      ? cell('mastery-cell', 'Niv. ' + p.mastery.level, kilo(p.mastery.points) + ' pts')
      : cell('mastery-cell', p.puuid ? 'Jamais joué' : '—', 'maîtrise');
    row.appendChild(mc);
  }

  // Repères (série, OTP, découverte du champion…)
  var tags = el('div', 'tags');
  p.tags.forEach(function (t) { tags.appendChild(el('span', 'tag ' + t.tone, t.label)); });
  row.appendChild(tags);
  return row;
}

// ---------------------------------------------------------------------------
// Tactile
// ---------------------------------------------------------------------------

function onTabClick(e) {
  var target = e.target.closest('button');
  if (!target) return;
  var mode = target.getAttribute('data-mode');
  var period = target.getAttribute('data-period');
  if (mode && mode !== state.mode) state.mode = mode;
  else if (period && period !== state.period) state.period = period;
  else return;
  rememberSelection();
  renderTabs();
  $('widget').setAttribute('data-state', 'loading');
  refresh();
}

function onSessionClick() {
  var btn = $('session-btn');
  var active = state.data && state.data.session;
  if (state.busy) return;

  // Terminer demande une confirmation (2e appui dans les 3 s) pour éviter un appui accidentel.
  if (active && !state.confirmTimer) {
    btn.setAttribute('data-variant', 'confirm');
    btn.textContent = 'Confirmer ?';
    state.confirmTimer = setTimeout(function () {
      state.confirmTimer = null;
      render();
    }, 3000);
    return;
  }
  if (state.confirmTimer) {
    clearTimeout(state.confirmTimer);
    state.confirmTimer = null;
  }

  state.busy = true;
  btn.disabled = true;
  api(active ? '/api/session/stop' : '/api/session/start', 'POST')
    .then(function () {
      if (!active) {
        state.period = 'session';
        rememberSelection();
      }
    })
    .catch(function (err) {
      state.online = false;
      state.lastError = err.message;
    })
    .finally(function () {
      state.busy = false;
      refresh();
    });
}

function showLiveView() {
  if (!state.live) return;
  state.view = 'live';
  renderLive();
  applyView();
  scheduleLivePoll();
}

function showSessionView() {
  state.view = 'session';
  applyView();
  scheduleLivePoll();
}

// ---------------------------------------------------------------------------
// Cycle de vie iCUE
// ---------------------------------------------------------------------------

var initialized = false;
function onIcueInitialized() {
  // Peut être appelé par l'événement iCUE ET par bootCheck() : une seule initialisation.
  booted = true;
  if (initialized) return onIcueDataUpdated();
  initialized = true;
  applyPersonalization();
  syncSelectionWithSettings();
  if (new URLSearchParams(location.search).get('view') === 'live') state.view = 'live';
  scheduleRefresh();
  refresh();
  refreshLive();
  // Horloge de partie et « il y a x min » : rafraîchissement visuel chaque seconde, sans requête.
  setInterval(function () {
    if (!state.live) return;
    setText('live-timer', clock(liveSeconds()));
    setText('live-btn-text', 'En jeu · ' + clock(liveSeconds()));
  }, 1000);
}

function onIcueDataUpdated() {
  var previousRefresh = state.refreshMs;
  applyPersonalization();
  var before = state.mode + '|' + state.period;
  syncSelectionWithSettings();
  if (state.refreshMs !== previousRefresh) scheduleRefresh();
  var accountChanged = String(prop('riotAccount', '')).trim() !== state.appliedAccount;
  if (accountChanged || state.mode + '|' + state.period !== before) refresh();
  else render();
}

// Affectation nue volontaire (pas de var/let) : requise par le pont iCUE.
icueEvents = {
  onDataUpdated: onIcueDataUpdated,
  onICUEInitialized: onIcueInitialized
};

$('mode-tabs').addEventListener('click', onTabClick);
$('period-tabs').addEventListener('click', onTabClick);
$('session-btn').addEventListener('click', onSessionClick);
$('live-btn').addEventListener('click', showLiveView);
$('back-btn').addEventListener('click', showSessionView);
$('champ-list').addEventListener('click', onChampionClick);
$('champ-overlay').addEventListener('click', closeOverlay);
$('match-overlay').addEventListener('click', closeOverlay);
$('match-sheet').addEventListener('click', onMatchSheetClick);
$('matches').addEventListener('click', onMatchClick);

// Démarrage : iCUE peut injecter ses globales après ce script → on retente brièvement
// avant de conclure qu'on est dans un navigateur classique (aperçu de développement).
var bootAttempts = 0;
var booted = false;
function bootCheck() {
  if (booted) return;
  if (typeof iCUE_initialized !== 'undefined' && iCUE_initialized) {
    onIcueInitialized();
    return;
  }
  if (bootAttempts++ < 15) {
    setTimeout(bootCheck, 100);
    return;
  }
  onIcueInitialized(); // hors iCUE : valeurs par défaut
}
bootCheck();
