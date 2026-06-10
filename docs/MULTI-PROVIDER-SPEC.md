# Multi-provider — spécification (v0 du design, 2026-06-10)

> Statut : **proposition de design**, rien n'est implémenté. Objectif : préparer le
> chantier « providers directs au-delà d'OpenRouter », prérequis structurel de la vision
> long terme (concurrencer OpenRouter plutôt que le consommer — cf `BILAN-2026-06-10.md`).
> Aucune décision ici ne modifie le contrat MyMULTI (`ARCHITECTURE.md` §5) : il reste la loi.

## 1. Pourquoi

Aujourd'hui OpenRouter **est** notre couche multi-provider : un seul adaptateur
(`src/providers/openrouter.ts`), une seule clé, un seul format de flux. Devenir un
concurrent suppose de parler **directement** aux fournisseurs (Anthropic, OpenAI, Google,
Mistral, DeepSeek, Groq…), pour trois raisons :

1. **Marge et coût** : OpenRouter prend ~5 % ; en direct, le bandit arbitre sur le vrai prix.
2. **Latence** : un hop de moins.
3. **Indépendance** : ne pas construire un produit sur l'infrastructure du concurrent visé.

## 2. Ce qui varie réellement d'un provider à l'autre

Inventaire tiré du code actuel (`openrouter.ts`, `routes/chat.ts`, `sse.ts`) :

| Dimension | OpenRouter (actuel) | Provider OpenAI-compatible direct | Anthropic direct |
|---|---|---|---|
| Endpoint + auth | `…/chat/completions`, `Bearer` | idem, `Bearer` | `/v1/messages`, `x-api-key` |
| Forme requête | OpenAI + steering propriétaire (`provider.sort`, `usage.include`) | OpenAI pur (retirer le steering OpenRouter !) | **traduction** (system, content blocks, tools) |
| Forme réponse | OpenAI | OpenAI | **traduction** |
| SSE | OpenAI (`data: {choices:[{delta…}]}`) | OpenAI | **événements différents** (`content_block_delta`…) → ré-encodage |
| `usage.cost` | fourni par OpenRouter | **absent** → à synthétiser | **absent** → à synthétiser |
| Statuts retryables | 429/5xx | 429/5xx | 429/5xx + `overloaded_error` (529) |
| Particularités | floor Kimi K2, sort throughput | — | header `anthropic-version`, etc. |

Deux observations structurantes :

- **Le format de fil (wire format) canonique d'OpenMulti est et reste OpenAI** : c'est le
  contrat MyMULTI (réponse byte-identique sans extension, SSE passé intact). Un provider
  non-OpenAI implique donc une couche de **traduction aller-retour, y compris du SSE** —
  c'est le morceau le plus risqué, à faire en dernier.
- **`usage.cost` est un point de contrat** (coupling point #1). OpenRouter nous le donne ;
  en direct, personne ne le donne. Il faut une **table de prix par modèle** côté OpenMulti
  pour synthétiser `usage.cost` à partir des tokens — sinon le passage en direct casse le
  contrat ET affame le bandit (qui sélectionne au coût observé).

## 3. L'interface Provider proposée

```ts
// src/providers/types.ts (proposé)
export interface Provider {
  /** Identifiant stable, ex. 'openrouter', 'anthropic', 'openai'. */
  name: string
  /** Prépare le corps upstream : strip openmulti, set model, steering propre au provider.
   *  (= l'actuel buildUpstreamBody, par provider.) */
  buildBody(req: ChatRequest, model: string, maxTokensCeiling?: number): Record<string, unknown>
  /** POST l'appel (endpoint, auth, headers, timeout connect 30s). */
  call(body: Record<string, unknown>): Promise<UpstreamCall>
  /** Statuts qui méritent un retry same-model. */
  isRetryable(status: number): boolean
  /** Non-stream : normalise la réponse au format OpenAI + usage{cost} garanti. */
  normalizeResponse(data: Record<string, unknown>, model: string): Record<string, unknown>
  /** Stream : adapte le flux au SSE OpenAI (identité pour les providers OpenAI-shape)
   *  et expose le scanner usage/cost (l'actuel SseUsageScanner devient per-provider). */
  adaptStream(upstream: ReadableStream<Uint8Array>, model: string): AdaptedStream
}
```

Principes :

- `routes/chat.ts` ne connaît plus `openrouter.ts` : il reçoit un `Provider` résolu par le
  routeur et orchestre retry/watchdog/métriques comme aujourd'hui. La boucle de retry, le
  watchdog inter-chunk et l'enregistrement métriques sont **communs** et ne bougent pas.
- Pour OpenRouter, `normalizeResponse` = identité et `adaptStream` = passthrough byte-à-byte
  (le contrat « SSE intact » est garanti par construction pour le chemin actuel).
- Le steering actuel (usage.include, sort throughput, floor Kimi) part dans
  `OpenRouterProvider.buildBody` — il est propriétaire OpenRouter et ne doit PAS fuiter
  vers un provider direct.

## 4. Identité des modèles et résolution du provider

Le catalogue parle déjà en `vendor/model` (`anthropic/claude-sonnet-4-5`). Le **vendor
préfixe ≠ provider d'accès** : `anthropic/claude-sonnet-4-5` peut être servi par OpenRouter
*ou* par Anthropic direct. La résolution devient :

1. Le routeur choisit un modèle (tier/purpose/bandit — inchangé).
2. Un registre `providersFor(model)` liste les **chemins d'accès** disponibles, dans
   l'ordre : env `OPENMULTI_PROVIDER_<VENDOR>` (ex. `anthropic=direct|openrouter`), défaut
   `openrouter` (iso). Un chemin direct n'est éligible que si sa clé (`ANTHROPIC_API_KEY`…)
   est configurée — sinon fallback silencieux sur OpenRouter.
3. v2 (plus tard) : le bandit arbitre aussi **entre chemins d'accès** du même modèle
   (clé de stats `provider:model` au lieu de `model` dans la vue bandit de `metrics.ts`).

Aucun changement côté appelant : MyMULTI continue d'envoyer `auto` + tier, ou un id
`vendor/model`. Le chemin d'accès est une affaire interne d'OpenMulti, surfacé dans
`openmulti.reason` et `X-OpenMulti-*` pour la traçabilité.

## 5. La table de prix (nouvelle pièce obligatoire)

`src/pricing.ts` (proposé) : `{ 'vendor/model': { inputPerMTok, outputPerMTok } }`,
surchargée par env/fichier. Utilisée par `normalizeResponse`/`adaptStream` des providers
directs pour synthétiser `usage.cost = pTok*in/1e6 + cTok*out/1e6`.

- OpenRouter : on garde **son** cost (source de vérité de ce chemin, inclut leur marge).
- Direct : cost synthétisé, marqué `openmulti.cost_source: 'computed'` dans le bloc
  extension (jamais dans la réponse pure-OpenAI).
- Modèle absent de la table → cost absent + warning loggé + métrique dédiée : on ne
  fabrique pas un faux zéro (le bandit lirait « gratuit » → biais dangereux).
- Maintenance des prix : statique versionnée + override env pour corriger sans release.
  (Automatiser la sync depuis les pages pricing = chantier ops séparé.)

## 6. Découpage en incréments (chacun PR-able, contrat vert à chaque étape)

1. **Seam (pur refactor, zéro comportement)** — extraire l'interface `Provider`,
   `OpenRouterProvider` = code actuel déplacé 1:1, `routes/chat.ts` consomme l'interface.
   Verrou : `contract.test.ts` inchangé et vert ; aucun octet de différence sur le fil
   (les tests existants le prouvent déjà — c'est leur raison d'être).
2. **Table de prix + cost synthétique** — `pricing.ts` + tests unitaires purs (calcul,
   modèle inconnu, override env). Pas encore branchée sur un provider réel.
3. **Premier provider direct OpenAI-compatible** (le moins risqué : DeepSeek, Groq,
   Mistral ou OpenAI — corps et SSE déjà OpenAI-shape, seule l'auth/endpoint/cost change).
   Opt-in par env (`OPENMULTI_PROVIDER_<VENDOR>=direct`), défaut = OpenRouter (iso).
   Tests : contrat rejoué sur ce provider (upstream mocké), cost synthétisé vérifié,
   fallback sans clé vérifié.
4. **Bandit par chemin d'accès** — stats `provider:model`, le bandit arbitre
   direct vs OpenRouter au coût/santé observés. (Petit : la vue bandit est déjà là.)
5. **Anthropic direct (traduction complète)** — requête, réponse, SSE ré-encodé en
   chunks OpenAI. Le plus gros morceau ; exige une suite de tests de traduction dédiée
   (golden files des deux formats) et probablement l'extraction de fonctions pures de
   mapping (règle projet : logique isolable = testée isolément).
6. **(Plus tard)** BYOK par clé appelante, fallback cross-provider sur erreur,
   load-balancing multi-clés — le territoire Portkey, après l'assise ci-dessus.

## 7. Garde-fous

- **Chaque étape est opt-in et réversible par env** ; le défaut reste « tout passe par
  OpenRouter » tant que la confiance n'est pas établie chemin par chemin.
- **Le contrat MyMULTI ne bouge jamais** : si une étape exige de toucher
  `contract.test.ts`, c'est un changement d'interface → coordination, pas un contournement.
- **Sécurité** : chaque clé provider est un secret de plus (k8s secret + env, jamais
  versionnée) ; OM-06 (allowlist de champs) devient plus important encore — un champ
  pass-through toléré par OpenRouter peut être une injection chez un provider direct.
  À traiter au plus tard avec l'étape 3.
- **Observabilité** : les métriques gagnent un label `provider` (chemin d'accès) en plus
  de `model` — cardinalité toujours bornée (peu de chemins).
