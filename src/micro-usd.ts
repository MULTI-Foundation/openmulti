// Comptabilité interne en micro-USD ENTIERS (E-4). Les ledgers crédits/dépense
// accumulaient des flottants IEEE (HINCRBYFLOAT, Number/1e6) : chaque incrément peut
// introduire un epsilon, et un solde censé tomber à zéro exact n'y tombe jamais tout
// à fait. En interne tout compte désormais en micro-dollars entiers (1 µ$ = 1e-6 $,
// la précision du rail USDC : ses unités atomiques SONT des micro-USD) ; la surface
// externe (API admin/balance, réponses, config) reste en USD flottants — la conversion
// ne se fait qu'aux frontières, jamais dans une boucle d'accumulation.

/** USD (float de frontière) -> micro-USD entier, arrondi au plus proche (erreur max
 * 0.5 µ$ par conversion, jamais de dérive cumulée : on n'accumule que des entiers). */
export function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000)
}

/** micro-USD entier -> USD (frontière de sortie uniquement). */
export function microToUsd(micro: number): number {
  return micro / 1_000_000
}
