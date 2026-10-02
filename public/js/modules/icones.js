// ══════════════════════════════════════════════
// public/js/modules/icones.js — pictogrammes et écussons
// ══════════════════════════════════════════════
//
// Les emojis rendaient l'app identique à mille autres générées à la chaîne,
// et changeaient d'allure d'un téléphone à l'autre. Ici : un seul jeu de
// pictogrammes au trait, dessinés pour l'app, qui prennent la couleur du texte.
//
// Les écussons d'équipe sont des pastilles aux initiales, dans une couleur
// tirée du nom : la même équipe garde toujours la même couleur.

const TRACES = {
  accueil:   '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
  cible:     '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  hausse:    '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  direct:    '<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>',
  menu:      '<path d="M4 7h16M4 12h16M4 17h10"/>',
  calendrier:'<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  stats:     '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  portefeuille:'<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18v4"/><rect x="3" y="7.5" width="18" height="12" rx="2.5"/><circle cx="16.5" cy="13.5" r="1.3" fill="currentColor"/>',
  historique:'<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7.5V12l3 2"/>',
  cloche:    '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  eclair:    '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  couches:   '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  calcul:    '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7h7M8.5 12h1M12 12h1M15.5 12h0M8.5 16h1M12 16h1M15.5 16h0"/>',
  loupe:     '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  rafraichir:'<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 21v-5h-5"/>',
  ballon:    '<circle cx="12" cy="12" r="9"/><path d="m12 7.5 4 2.9-1.5 4.6h-5L8 10.4z"/><path d="M12 3v4.5M21 10.5l-5 0M3 10.5h5M16.5 19.5 14.5 15M7.5 19.5 9.5 15"/>',
  basket:    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8"/>',
  raquette:  '<ellipse cx="14.5" cy="9.5" rx="6" ry="6.5" transform="rotate(45 14.5 9.5)"/><path d="m10 14-6.5 6.5"/>',
  gant:      '<path d="M7 11V7a3 3 0 0 1 3-3h4a4 4 0 0 1 4 4v5a6 6 0 0 1-6 6h-2a3 3 0 0 1-3-3z"/><path d="M7 11h6"/>',
  drapeau:   '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  micro:     '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  coche:     '<path d="m5 12.5 4.5 4.5L19 7"/>',
  croix:     '<path d="M6 6l12 12M18 6 6 18"/>',
  fleche:    '<path d="M5 12h14M13 6l6 6-6 6"/>',
  flamme:    '<path d="M12 21c4 0 7-2.7 7-6.6 0-3.5-2.4-5.4-3.7-8.4-.6 2-1.6 3-3 3.6C12.6 6.7 11 4.4 8.6 3c.4 3.6-3.6 6.2-3.6 11.4C5 18.3 8 21 12 21z"/>',
  bouclier:  '<path d="M12 3 4.5 6v5.5c0 4.7 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.8 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  lune:      '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  soleil:    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
};

/** Pictogramme SVG au trait, de la couleur du texte. */
export function icone(nom, { taille = 20, epaisseur = 1.9, classe = '' } = {}) {
  const t = TRACES[nom];
  if (!t) return '';
  return `<svg class="ico ${classe}" width="${taille}" height="${taille}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${epaisseur}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${t}</svg>`;
}

/** Pictogramme d'un sport, d'après le libellé libre stocké en base. */
export function iconeSport(sport = '') {
  const s = String(sport).toLowerCase();
  if (s.includes('basket') || s === 'nba') return icone('basket');
  if (s.includes('tennis')) return icone('raquette');
  if (s.includes('mma') || s.includes('box') || s.includes('ufc')) return icone('gant');
  if (s.includes('f1') || s.includes('formule') || s.includes('moto')) return icone('drapeau');
  return icone('ballon');
}

// Couleurs de maillot : saturées, lisibles en blanc, jamais deux fois la même
// teinte pour deux noms voisins.
const MAILLOTS = ['#d7263d', '#1b6fd8', '#0f9d58', '#f28c28', '#7b3fe4', '#0aa5a5',
                  '#c2185b', '#2e7d32', '#ef6c00', '#3949ab', '#00838f', '#ad1457',
                  '#6d4c41', '#1565c0', '#b8860b', '#455a64'];

function hacher(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Initiales d'une équipe : « Paris Saint-Germain » → PS, « Lens » → LE. */
export function initiales(nom = '') {
  const mots = String(nom).replace(/&[a-z#0-9]+;/gi, ' ')
    .split(/[\s\-.']+/).filter(m => m && !/^(fc|cf|ac|as|sc|afc|cd|ud|sv|club|de|la|le|the|real)$/i.test(m));
  if (mots.length === 0) return '?';
  if (mots.length === 1) return mots[0].slice(0, 2).toUpperCase();
  return (mots[0][0] + mots[1][0]).toUpperCase();
}

/** Écusson d'équipe : pastille colorée aux initiales. `nom` doit être déjà échappé. */
export function ecusson(nom = '', { taille = 34 } = {}) {
  const couleur = MAILLOTS[hacher(String(nom).toLowerCase()) % MAILLOTS.length];
  return `<span class="ecusson" style="--maillot:${couleur};width:${taille}px;height:${taille}px;font-size:${Math.round(taille * 0.36)}px">${initiales(nom)}</span>`;
}

export default { icone, iconeSport, initiales, ecusson };
