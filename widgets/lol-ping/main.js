// Widget de diagnostic : vérifie qu'un widget iCUE peut appeler le backend local.
// Chaque étape s'affiche à l'écran (HTML → CSS → JS → iCUE → API) pour localiser un blocage.
// Aucune logique métier : on affiche seulement ce que le backend renvoie.

// « localhost » et non 127.0.0.1 : c'est le seul hôte que la permission du manifest autorise.
var DEFAULT_API = 'http://localhost:3417';
var REFRESH_MS = 15000;

function showError(msg) {
  var el = document.getElementById('errors');
  if (el) el.textContent = String(msg).slice(0, 300);
}

window.addEventListener('error', function (e) {
  showError('Erreur JS : ' + (e.message || e.type));
});
window.addEventListener('unhandledrejection', function (e) {
  showError('Promesse rejetée : ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
});

function markStep(id) {
  var el = document.getElementById(id);
  if (el) el.className = 'step done';
}

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

function apiBase() {
  return String(getIcueProperty('apiBaseUrl') || DEFAULT_API).replace(/\/+$/, '');
}

function apiGet(path) {
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 8000);
  return fetch(apiBase() + path + (path.indexOf('?') < 0 ? '?' : '&') + 'from=widget', { signal: controller.signal })
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
        return body;
      });
    })
    .finally(function () { clearTimeout(timeout); });
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setStatus(state, text) {
  var el = document.getElementById('status');
  el.setAttribute('data-state', state);
  el.textContent = text;
}

function refresh() {
  setText('origin', String(location.href).slice(0, 120));
  setText('size', window.innerWidth + '×' + window.innerHeight);
  apiGet('/api/health')
    .then(function (health) {
      markStep('step-api');
      setText('backend', 'OK : ' + health.riotId + ' · ' + health.platform);
      return apiGet('/api/debug/account').then(
        function (acc) {
          setText('riot', acc.gameName + '#' + acc.tagLine + ' · ' + acc.puuid.slice(0, 12) + '…');
          setStatus('ok', 'OK');
        },
        function (err) {
          setText('riot', 'Erreur : ' + err.message);
          setStatus('error', 'RIOT');
        }
      );
    })
    .catch(function (err) {
      // TypeError "Failed to fetch" = backend arrêté, ou requête bloquée (CORS / réseau privé / contenu mixte).
      setText('backend', 'Injoignable : ' + err.name + ' : ' + err.message);
      setStatus('error', 'HORS LIGNE');
    });
}

function onIcueInitialized() {
  markStep('step-icue');
  refresh();
}
function onIcueDataUpdated() {
  markStep('step-icue');
  refresh();
}

// Affectation nue volontaire (pas de var/let) : requise par le pont iCUE.
icueEvents = {
  onDataUpdated: onIcueDataUpdated,
  onICUEInitialized: onIcueInitialized
};

markStep('step-js');
try {
  refresh();
} catch (e) {
  showError('refresh() : ' + e.message);
}
setInterval(refresh, REFRESH_MS);
