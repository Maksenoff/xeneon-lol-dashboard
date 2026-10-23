// Rendu des repères de partie (« OTP », « 4 V d'affilée »…) : pastille + icône + couleur par ton.
// Le choix des repères est fait par le backend (domain/tags.ts) ; ici, uniquement l'affichage.

var TAG_ICONS = {
  // couronne
  otp: 'M3 18h18M5 16 3.5 7.5l5 3.5L12 5l3.5 6 5-3.5L19 16z',
  // pousse
  first_time: 'M12 21v-8m0 0c0-3.5-2.5-6-7-6 0 3.5 2.5 6 7 6zm0 0c0-3.5 2.5-6 7-6 0 3.5-2.5 6-7 6',
  new_champ: 'M12 21v-8m0 0c0-3.5-2.5-6-7-6 0 3.5 2.5 6 7 6zm0 0c0-3.5 2.5-6 7-6 0 3.5-2.5 6-7 6',
  // flamme
  win_streak: 'M12 3c1.5 4 6 5.5 6 11a6 6 0 0 1-12 0c0-3.5 2-5 2.5-7.5C10 8 11 10 11 10s2.5-3 1-7z',
  hot_streak: 'M12 3c1.5 4 6 5.5 6 11a6 6 0 0 1-12 0c0-3.5 2-5 2.5-7.5C10 8 11 10 11 10s2.5-3 1-7z',
  // courbe descendante
  loss_streak: 'M3 7l6 6 4-4 8 8m0-6v6h-6',
  struggling: 'M3 7l6 6 4-4 8 8m0-6v6h-6',
  champ_wr_low: 'M3 7l6 6 4-4 8 8m0-6v6h-6',
  // courbe montante
  in_form: 'M3 17l6-6 4 4 8-8m0 6V7h-6',
  champ_wr_high: 'M3 17l6-6 4 4 8-8m0 6V7h-6',
  // cible
  main: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 3.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  // épée
  champ_kda: 'M14.5 3.5H20.5V9.5L9 21l-3-3 11.5-11.5M5 15l4 4M3 21l2-2',
  // flèches d'échange
  off_role: 'M4 8h14l-3.5-3.5M20 16H6l3.5 3.5',
  // étincelle
  fresh_blood: 'M12 3l2.2 6.3L20.5 12l-6.3 2.2L12 20.5l-2.2-6.3L3.5 12l6.3-2.7z',
  // horloge
  low_games: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4.5V12l3.5 2',
  // bouclier
  veteran: 'M12 3l8 3v6c0 4.8-3.4 8-8 9-4.6-1-8-4.2-8-9V6z',
  // éclair (smite)
  good_smite: 'M13 2 4.5 13.5H11L10 22l8.5-11.5H12z',
  bad_smite: 'M13 2 4.5 13.5H11L10 22l8.5-11.5H12z',
  // épées croisées (duels)
  duelist: 'M5 4l9.5 9.5M19 4l-9.5 9.5M14 16l2-2 4 4-2 2zM10 16l-2-2-4 4 2 2z',
  // groupe (teamfight)
  teamfighter: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 5.2a3 3 0 0 1 0 5.6M17.5 14.7c2.1.6 3.5 2.6 3.5 5.3',
  // crâne (morts)
  death_prone: 'M12 3a8 8 0 0 0-5 14.2V21h10v-3.8A8 8 0 0 0 12 3zM9 11.5h.01M15 11.5h.01M10.5 21v-2.5M13.5 21v-2.5'
};

/** Pastille d'un repère : { id, label, tone, category, hint } → élément DOM. */
function tagChip(t) {
  var chip = document.createElement('span');
  chip.className = 'tag tone-' + (t.tone || 'info') + ' cat-' + (t.category || 'profile');
  chip._tag = t; // données pour la bulle d'explication
  var path = TAG_ICONS[t.id];
  if (path) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'tag-icon');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    svg.appendChild(p);
    chip.appendChild(svg);
  }
  var text = document.createElement('span');
  text.className = 'tag-text';
  text.textContent = t.label;
  chip.appendChild(text);
  return chip;
}

// ---------------------------------------------------------------------------
// Bulle d'explication : un appui sur un repère l'ouvre, un appui ailleurs la ferme.
// ---------------------------------------------------------------------------

var tagPopover = null;

function hideTagInfo() {
  if (tagPopover) {
    tagPopover.remove();
    tagPopover = null;
  }
}

/** Ouvre la bulle de `chip` à l'intérieur de `container` (positionné en relative/absolute). */
function showTagInfo(chip, container) {
  var t = chip._tag;
  if (!t) return;
  var wasSame = tagPopover && tagPopover._chip === chip;
  hideTagInfo();
  if (wasSame) return; // 2e appui sur le même repère : on referme

  var pop = document.createElement('div');
  pop.className = 'tag-pop tone-' + (t.tone || 'info');
  pop._chip = chip;

  var head = document.createElement('div');
  head.className = 'tag-pop-head';
  var icon = chip.querySelector('.tag-icon');
  if (icon) head.appendChild(icon.cloneNode(true));
  var title = document.createElement('span');
  title.textContent = t.title || t.label;
  head.appendChild(title);
  pop.appendChild(head);

  if (t.hint) {
    var hint = document.createElement('div');
    hint.className = 'tag-pop-hint';
    hint.textContent = t.hint;
    pop.appendChild(hint);
  }
  if (t.explain) {
    var explain = document.createElement('div');
    explain.className = 'tag-pop-explain';
    explain.textContent = t.explain;
    pop.appendChild(explain);
  }

  container.appendChild(pop);
  tagPopover = pop;

  // Placement : sous le repère, ou au-dessus s'il n'y a pas la place ; jamais hors du widget.
  var c = container.getBoundingClientRect();
  var r = chip.getBoundingClientRect();
  var p = pop.getBoundingClientRect();
  var margin = 8;
  var left = Math.min(Math.max(r.left - c.left, margin), c.width - p.width - margin);
  var top = r.bottom - c.top + 6;
  if (top + p.height > c.height - margin) top = r.top - c.top - p.height - 6;
  pop.style.left = Math.max(margin, left) + 'px';
  pop.style.top = Math.max(margin, top) + 'px';
}

/** Branche les bulles sur un conteneur de repères (délégation d'événements). */
function enableTagInfo(scope, container) {
  scope.addEventListener('click', function (e) {
    var chip = e.target.closest ? e.target.closest('.tag') : null;
    if (chip) {
      e.stopPropagation();
      showTagInfo(chip, container);
    }
  });
  document.addEventListener('click', function (e) {
    if (tagPopover && !(e.target.closest && e.target.closest('.tag-pop'))) hideTagInfo();
  });
}
