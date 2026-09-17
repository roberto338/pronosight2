// ══════════════════════════════════════════════
// prono/engine/markets.js — les marchés dérivés de la matrice
// ══════════════════════════════════════════════
//
// 1X2, Over/Under et BTTS ne sont pas trois modèles : ce sont trois lectures
// de la MÊME matrice de scores. Trois sommes de cases.
//
// Conséquence directe, et c'est une garantie de cohérence que peu d'outils
// offrent : il est impossible que le modèle annonce 60 % de victoire à
// domicile et 70 % de « moins de 2,5 buts » sans que les deux chiffres
// soient compatibles entre eux. Un modèle de langage interrogé marché par
// marché, lui, se contredit sans jamais s'en apercevoir.

export const SEUILS_OU = [1.5, 2.5, 3.5];

/** Clé stable d'une sélection, utilisée en base et pour les intervalles. */
export const cle = (marche, selection) => `${marche}:${selection}`;

/**
 * @param {number[][]} matrice  matrice[x][y] = P(dom marque x, ext marque y)
 * @returns {{marches:Array, parCle:Object, scoresProbables:Array}}
 */
export function marchesDepuisMatrice(matrice, options = {}) {
  const { seuils = SEUILS_OU, topScores = 5 } = options;
  const n = matrice.length;

  let pDom = 0, pNul = 0, pExt = 0, pBtts = 0;
  const pTotalButs = new Map();   // total de buts → probabilité
  const scores = [];

  for (let x = 0; x < n; x++) {
    for (let y = 0; y < matrice[x].length; y++) {
      const p = matrice[x][y];
      if (p <= 0) continue;

      if (x > y) pDom += p; else if (x === y) pNul += p; else pExt += p;
      if (x >= 1 && y >= 1) pBtts += p;

      const total = x + y;
      pTotalButs.set(total, (pTotalButs.get(total) || 0) + p);
      scores.push({ score: `${x}-${y}`, proba: p });
    }
  }

  const marches = [
    { marche: '1X2', selection: '1', proba: pDom },
    { marche: '1X2', selection: 'X', proba: pNul },
    { marche: '1X2', selection: '2', proba: pExt },
  ];

  for (const seuil of seuils) {
    // « Over 2,5 » = au moins 3 buts. Le seuil demi-entier évite tout remboursement.
    let over = 0;
    for (const [total, p] of pTotalButs) if (total > seuil) over += p;
    marches.push(
      { marche: `OU_${seuil}`, selection: 'over',  proba: over },
      { marche: `OU_${seuil}`, selection: 'under', proba: 1 - over },
    );
  }

  marches.push(
    { marche: 'BTTS', selection: 'oui', proba: pBtts },
    { marche: 'BTTS', selection: 'non', proba: 1 - pBtts },
  );

  const parCle = {};
  for (const m of marches) parCle[cle(m.marche, m.selection)] = m.proba;

  scores.sort((a, b) => b.proba - a.proba);

  return { marches, parCle, scoresProbables: scores.slice(0, topScores) };
}

export default { marchesDepuisMatrice, cle, SEUILS_OU };
