// Tests du bandit amorti (la stratégie 'smart' avec DECAY_WINDOW > 0, le défaut).
// Le mode sans amortissement (WINDOW=0, legacy) est verrouillé par select.test.ts.
// Tout est déterministe (pas de RNG) : on déroule des séquences en boucle fermée
// (select -> record) et on vérifie les propriétés bandit — exploration continue,
// guérison d'un modèle malade, primauté du récent sur l'historique.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Lus à l'import par select.ts / metrics.ts — fenêtre courte pour des tests courts.
// rho = 1 - 1/20 = 0.95 ; exploration en régime établi ~ MIN_SAMPLES/WINDOW = 10 %.
process.env.OPENROUTER_API_KEY ||= 'test-upstream-key' // metrics.ts importe catalog/pricing -> config
process.env.OPENMULTI_SMART_MIN_SAMPLES = '2'
process.env.OPENMULTI_SMART_MAX_ERROR_RATE = '0.2'
process.env.OPENMULTI_SMART_DECAY_WINDOW = '20'

const { selectModel, _setBanditClockForTests } = await import('../src/select.ts')
const { recordRequest, modelAggregate, renderProm, _resetMetrics, _setKnownModelsForTest } = await import('../src/metrics.ts')

beforeEach(() => {
  _resetMetrics()
  _setBanditClockForTests(null)
  // Les ids synthétiques doivent être "connus" sinon le bornage de cardinalité les
  // collapse sur 'other' (cf metrics-cardinality.test.ts).
  _setKnownModelsForTest(['a/1', 'b/2'])
})

test('decay: la vue bandit s\'amortit, les compteurs Prometheus restent monotones', () => {
  recordRequest({ key: 'k', model: 'a/1', costUsd: 1 })
  recordRequest({ key: 'k', model: 'b/2' }) // amortit a/1 d'un facteur rho
  const a = modelAggregate('a/1')
  assert.ok(a.requests > 0.94 && a.requests < 1, `requests amorti attendu ~0.95, obtenu ${a.requests}`)
  assert.ok(a.costUsd > 0.94 && a.costUsd < 1)
  // Le compteur exposé sur /metrics, lui, ne décroît jamais.
  assert.match(renderProm(), /openmulti_requests_total\{key="k",model="a\/1",provider="openrouter"\} 1\b/)
})

test('refresh: le candidat non élu continue d\'être ré-échantillonné (pas d\'exploit éternel)', () => {
  // Boucle fermée : b/2 moins cher devient l'élu, mais le décompte amorti de a/1
  // repasse périodiquement sous MIN_SAMPLES -> il revoit du trafic. En mode legacy
  // (stats à vie), a/1 ne serait plus JAMAIS choisi après la phase de remplissage.
  const picks: string[] = []
  for (let i = 0; i < 100; i++) {
    const s = selectModel(['a/1', 'b/2'], 'smart')
    picks.push(s.model)
    recordRequest({ key: 'k', model: s.model, costUsd: s.model === 'a/1' ? 0.1 : 0.01 })
  }
  const tail = picks.slice(50)
  const aPicks = tail.filter((m) => m === 'a/1').length
  assert.ok(aPicks >= 2, `a/1 doit rester exploré en régime établi (vu ${aPicks} fois sur ${tail.length})`)
  assert.ok(aPicks <= tail.length / 4, `l'exploration doit rester minoritaire (vu ${aPicks} fois sur ${tail.length})`)
})

test('guérison: un modèle malade redevient éligible une fois ses erreurs amorties', () => {
  // b/2 (moins cher) est en panne au début : écarté comme malsain, mais l'exploration
  // continue le re-teste. Quand l'incident se termine, ses succès diluent le taux
  // d'erreur amorti -> il redevient sain et reprend le trafic. En mode legacy, le
  // taux d'erreur à vie le bannirait durablement.
  const picks: string[] = []
  for (let i = 0; i < 200; i++) {
    const bDown = i < 60
    const s = selectModel(['a/1', 'b/2'], 'smart')
    picks.push(s.model)
    recordRequest({
      key: 'k',
      model: s.model,
      costUsd: s.model === 'a/1' ? 0.1 : 0.01,
      error: s.model === 'b/2' && bDown,
    })
  }
  const incident = picks.slice(20, 60)
  const after = picks.slice(150)
  const bDuring = incident.filter((m) => m === 'b/2').length
  const bAfter = after.filter((m) => m === 'b/2').length
  assert.ok(bDuring <= incident.length / 4, `pendant l'incident, b/2 doit rester minoritaire (${bDuring}/${incident.length})`)
  assert.ok(bAfter > after.length / 2, `après guérison, b/2 (moins cher) doit redevenir l'élu (${bAfter}/${after.length})`)
})

test('plancher de guérison: un bras malsain au-dessus du plancher n\'est PAS ré-exploré', () => {
  // Vécu prod 2026-07-30 : la décote étant GLOBALE, un bras mort retombait sous
  // MIN_SAMPLES au rythme du trafic global et re-captait ~MIN_SAMPLES/WINDOW du trafic
  // via le fallback P0-10. Désormais, malsain + au-dessus du plancher -> exploit (bras sain).
  const agg: Record<string, { requests: number; errors: number; costUsd: number }> = {
    'a/1': { requests: 50, errors: 0, costUsd: 0.5 },
    'b/2': { requests: 1.2, errors: 1.2, costUsd: 0 }, // mort (100 % d'erreurs), coût observé nul
  }
  const s = selectModel(['a/1', 'b/2'], 'smart', (m) => agg[m]!)
  assert.equal(s.model, 'a/1', 'le bras mort ne doit pas capter le trafic (même "gratuit")')
})

test('plancher de guérison: retombé sous le plancher, le bras malsain est re-sondé', () => {
  const agg: Record<string, { requests: number; errors: number; costUsd: number }> = {
    'a/1': { requests: 50, errors: 0, costUsd: 0.5 },
    'b/2': { requests: 0.4, errors: 0.4, costUsd: 0 }, // sous le plancher (MIN_SAMPLES/10, min 0.5)
  }
  const s = selectModel(['a/1', 'b/2'], 'smart', (m) => agg[m]!)
  assert.equal(s.model, 'b/2', 'la sonde de guérison doit subsister')
})

test('boucle fermée: un bras mort en PERMANENCE ne capte qu\'une part marginale du trafic', () => {
  // Contrairement au test de guérison (incident borné), b/2 ne guérit jamais — le cas
  // prod (modèle absent du vendor). Sa part doit rester à ~plancher/WINDOW, pas
  // ~MIN_SAMPLES/WINDOW.
  let bPicks = 0
  for (let i = 0; i < 200; i++) {
    const s = selectModel(['a/1', 'b/2'], 'smart')
    if (s.model === 'b/2') bPicks++
    recordRequest({ key: 'k', model: s.model, costUsd: s.model === 'b/2' ? 0 : 0.01, error: s.model === 'b/2' })
  }
  assert.ok(bPicks >= 1, 'la sonde de guérison doit continuer d\'exister')
  assert.ok(bPicks <= 200 * 0.08, `part du bras mort attendue marginale, obtenu ${bPicks}/200`)
})

test('récence: un historique pas cher ne masque pas un coût récent élevé', () => {
  // a/1 a un long passé très bon marché puis devient cher ; b/2 est stable à 0.05.
  // Moyenne à vie de a/1 : (100*0.001 + 5*1)/105 ≈ 0.049 < 0.05 -> le legacy
  // choisirait a/1. La vue amortie pèse le récent : a/1 ≈ 0.23/req -> b/2 gagne.
  for (let i = 0; i < 100; i++) recordRequest({ key: 'k', model: 'a/1', costUsd: 0.001 })
  for (let i = 0; i < 5; i++) recordRequest({ key: 'k', model: 'a/1', costUsd: 1 })
  for (let i = 0; i < 3; i++) recordRequest({ key: 'k', model: 'b/2', costUsd: 0.05 })
  const s = selectModel(['a/1', 'b/2'], 'smart')
  assert.equal(s.model, 'b/2')
})

// ── Sonde de guérison temporelle (R-1, faible trafic) ────────────────────────────
// Défaut OPENMULTI_SMART_RECOVERY_PROBE_S=600 : un bras malsain silencieux depuis 10 min
// reçoit une requête, quel que soit son décompte amorti.

type Agg = { requests: number; errors: number; costUsd: number; lastErrorAt?: number }

test('sonde temporelle : un bras malsain au-dessus du plancher est re-sondé après le délai', () => {
  const agg: Record<string, Agg> = {
    'a/1': { requests: 50, errors: 0, costUsd: 0.5 },
    'b/2': { requests: 8, errors: 8, costUsd: 0, lastErrorAt: 1_000_000 }, // mort, bien au-dessus du plancher
  }
  _setBanditClockForTests(() => 1_000_000 + 599_000)
  assert.equal(selectModel(['a/1', 'b/2'], 'smart', (m) => agg[m]!).model, 'a/1', 'avant le délai : pas de sonde')
  _setBanditClockForTests(() => 1_000_000 + 600_000)
  const s = selectModel(['a/1', 'b/2'], 'smart', (m) => agg[m]!)
  assert.equal(s.model, 'b/2')
  assert.match(s.note, /recovery probe/)
})

test('sonde temporelle : sans horodatage (bras jamais en erreur, ou état legacy) rien ne change', () => {
  const agg: Record<string, Agg> = {
    'a/1': { requests: 50, errors: 0, costUsd: 0.5 },
    'b/2': { requests: 8, errors: 8, costUsd: 0 },
  }
  _setBanditClockForTests(() => 10 ** 12)
  assert.equal(selectModel(['a/1', 'b/2'], 'smart', (m) => agg[m]!).model, 'a/1')
})

test('sonde temporelle : prioritaire sur l\'exploration d\'un perdant sain sous-échantillonné', () => {
  // En régime établi un perdant sain est presque toujours sous MIN_SAMPLES : sans
  // priorité, la sonde (branche de repli) ne serait jamais atteinte.
  const agg: Record<string, Agg> = {
    'a/1': { requests: 50, errors: 0, costUsd: 0.5 },
    'b/2': { requests: 1.5, errors: 0, costUsd: 0.05 }, // sain, sous-échantillonné (MIN=2)
    'c/3': { requests: 6, errors: 6, costUsd: 0, lastErrorAt: 0 },
  }
  _setBanditClockForTests(() => 600_000)
  assert.equal(selectModel(['a/1', 'b/2', 'c/3'], 'smart', (m) => agg[m]!).model, 'c/3')
})

test('boucle fermée à faible trafic : panne de 10 min, guérison en quelques sondes, pas en semaines', () => {
  // 2 requêtes/heure. b/2 (moins cher) tombe en panne pendant 10 minutes puis guérit.
  // Par décote seule, revenir sous le plancher (0.5 depuis ~2) demanderait ~28 obs = 14 h ;
  // ici la sonde temporelle le remet en course en ~1 h après la guérison.
  let t = 0
  _setBanditClockForTests(() => t)
  const picks: Array<[number, string]> = []
  for (let i = 0; i < 60; i++) {
    t = i * 30 * 60_000 // une requête toutes les 30 min
    const bDown = t >= 2 * 3_600_000 && t < 2 * 3_600_000 + 10 * 60_000 // panne 2h00 -> 2h10 (1 requête)
    const s = selectModel(['a/1', 'b/2'], 'smart')
    picks.push([t, s.model])
    recordRequest({ key: 'k', model: s.model, costUsd: s.model === 'a/1' ? 0.1 : 0.01, error: s.model === 'b/2' && bDown })
  }
  const failedAt = picks.find(([, m], i) => m === 'b/2' && i > 0 && picks[i]![0] >= 2 * 3_600_000)
  assert.ok(failedAt, 'b/2 a bien été servi pendant la panne')
  // Première requête servie à b/2 après la panne : au plus 1 h après (sonde due à +10 min,
  // prochaine requête au plus 30 min plus tard).
  const firstBack = picks.find(([tt, m]) => m === 'b/2' && tt > 2 * 3_600_000 + 10 * 60_000)
  assert.ok(firstBack && firstBack[0] - (2 * 3_600_000 + 10 * 60_000) <= 3_600_000, `retour de b/2 à t=${firstBack?.[0]}`)
  // Et en fin de série, b/2 (moins cher, guéri) est redevenu l'élu majoritaire.
  const tail = picks.slice(45).filter(([, m]) => m === 'b/2').length
  assert.ok(tail > 10, `b/2 doit redevenir l'élu après guérison (${tail}/15)`)
})

test('sonde temporelle : une sonde qui ÉCHOUE repousse la suivante d\'un délai complet', () => {
  let t = 0
  _setBanditClockForTests(() => t)
  _setKnownModelsForTest(['a/1', 'b/2'])
  // b/2 mort : 5 erreurs, puis a/1 bien échantillonné. Les observations de a/1 sont
  // à portée {a/1} (R-2) : b/2 ne s'amortit pas, donc la sonde par plancher de décompte
  // ne joue pas — seule la sonde temporelle gouverne.
  for (let i = 0; i < 5; i++) { t += 1000; recordRequest({ key: 'k', model: 'b/2', error: true, costUsd: 0, candidates: ['b/2'] }) }
  for (let i = 0; i < 20; i++) { t += 1000; recordRequest({ key: 'k', model: 'a/1', costUsd: 0.01, candidates: ['a/1'] }) }
  const probesAt: number[] = []
  for (let i = 0; i < 200; i++) {
    t += 60_000 // une requête par minute pendant 200 min
    const s = selectModel(['a/1', 'b/2'], 'smart')
    if (s.model === 'b/2') probesAt.push(t)
    recordRequest({ key: 'k', model: s.model, costUsd: 0.01, error: s.model === 'b/2', candidates: [s.model] })
  }
  // Délai 600 s, 200 min de trafic : 20 sondes (une par délai), jamais deux à moins de 600 s.
  assert.ok(probesAt.length >= 19 && probesAt.length <= 20, `un bras mort coûte UNE requête par délai (vu ${probesAt.length} sur 200 min)`)
  for (let i = 1; i < probesAt.length; i++) assert.ok(probesAt[i]! - probesAt[i - 1]! >= 600_000, 'deux sondes à moins d\'un délai')
})
