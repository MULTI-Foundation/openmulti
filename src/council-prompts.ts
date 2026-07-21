// Council / fusion (mixture-of-agents) — fonctions PURES de construction de prompts,
// d'anonymisation et d'agrégation d'usage. Aucune I/O : testables isolément (règle
// projet). L'orchestration (appels parallèles, agrégation) vit dans council.ts.

type Dict = Record<string, unknown>

/** Texte d'une réponse chat.completion (concatène les parts texte). */
export function responseText(data: unknown): string {
  const d = data as Dict | undefined
  const choices = (d?.choices as Dict[] | undefined) ?? []
  const msg = (choices[0]?.message as Dict | undefined) ?? {}
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && (p as Dict).type === 'text' ? String((p as Dict).text ?? '') : '')).join('')
  }
  return ''
}

/** Étiquette les réponses « Response A/B/C… » SANS jamais nommer le modèle (anti-biais
 * provider, comme la revue anonymisée de llm-council). */
export function anonymizeResponses(texts: string[]): string {
  return texts.map((t, i) => `### Response ${String.fromCharCode(65 + i)}\n${t.trim()}`).join('\n\n')
}

/** Mode `compare` (le COMPARE du langage MULTI) : les réponses sont mises EN REGARD,
 * chacune sous le nom du modèle qui l'a produite — l'inverse exact de l'anonymisation
 * (ici on VEUT voir qui dit quoi ; aucune synthèse, aucun juge). Pure : la borne de
 * sortie du devis (council-quote) est dérivée de CE gabarit rendu à vide. */
export function formatComparison(models: string[], texts: string[]): string {
  return models.map((m, i) => `### ${m}\n\n${(texts[i] ?? '').trim()}`).join('\n\n---\n\n')
}

/** Dernier message utilisateur (contexte synthétique pour les prompts juge/chair). */
function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Dict | undefined
    if (m?.role === 'user') {
      const c = m.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map((p) => (p && (p as Dict).type === 'text' ? String((p as Dict).text ?? '') : '')).join('')
    }
  }
  return ''
}

const REVIEW_INSTRUCTION =
  'You are one reviewer on a panel. Above is a user request and several candidate answers from other anonymous models. ' +
  'Rank the candidates from best to worst on accuracy and insight, and briefly justify. ' +
  'Do not reveal or guess which model wrote which answer. Be concise.'

/** Messages pour l'étape de revue par les pairs (mode deliberate) : un membre note les
 * autres réponses (anonymisées). */
export function buildReviewMessages(userMessages: unknown[], anonymized: string): Dict[] {
  const q = lastUserText(userMessages)
  return [{ role: 'user', content: `User request:\n${q}\n\nCandidate answers:\n${anonymized}\n\n---\n${REVIEW_INSTRUCTION}` }]
}

const CHAIR_SYSTEM =
  'You are the chair of a council of AI models. You are given a user request and several candidate answers (anonymized), ' +
  'optionally with peer reviews. Compare them: treat points all or most agree on as higher-confidence consensus, surface ' +
  'contradictions, preserve unique correct insights, and flag blind spots none addressed. Then write the single best, ' +
  'self-contained final answer for the user. Do not mention the council, the candidates, or that multiple models were ' +
  'consulted — output only the best answer as if you were answering directly.'

/** Messages pour la synthèse finale du chair : conversation d'origine + candidats (+
 * revues). Un message system pose le rôle ; les candidats arrivent en dernier message user. */
export function buildSynthesisMessages(userMessages: unknown[], anonymized: string, reviews: string[] = []): Dict[] {
  const reviewBlock = reviews.length ? `\n\nPeer reviews:\n${reviews.map((r, i) => `[Reviewer ${i + 1}]\n${r.trim()}`).join('\n\n')}` : ''
  return [
    { role: 'system', content: CHAIR_SYSTEM },
    ...(userMessages as Dict[]),
    { role: 'user', content: `Candidate answers to my latest request:\n${anonymized}${reviewBlock}\n\nWrite the best final answer now.` },
  ]
}

export interface UsagePart {
  prompt_tokens?: number
  completion_tokens?: number
  cost?: number
}

/** Somme des usages de tous les sous-appels (panel + revues + chair). Le coût n'est posé
 * que si au moins un sous-appel l'a fourni (jamais un faux zéro). */
export function aggregateUsage(parts: UsagePart[]): Dict {
  let prompt = 0
  let completion = 0
  let cost = 0
  let anyCost = false
  for (const u of parts) {
    prompt += u?.prompt_tokens ?? 0
    completion += u?.completion_tokens ?? 0
    if (typeof u?.cost === 'number') {
      cost += u.cost
      anyCost = true
    }
  }
  const usage: Dict = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  if (anyCost) usage.cost = cost
  return usage
}
