# OpenMulti - Architecture & contrat de decouplage

> Doc fondateur du chantier "decoupler le gateway de MyMULTI en service autonome OpenMulti".
> Statut: valide (forme HTTP / TypeScript / billing reste dans MyMULTI). A executer en strangler, zero regression.
> Repo cible du service: github.com/MULTI-Foundation/openmulti (Apache 2.0).

## 1. Vision

OpenMulti est une **couche d'intelligence**, pas un simple proxy. Tu envoies une requete,
OpenMulti choisit le meilleur modele parmi des centaines, optimise l'appel, et apprend le
contexte avec le temps. API OpenAI-compatible, drop-in (`base_url` + cle `sk_...`), open source.

MyMULTI devient un **consommateur** d'OpenMulti: il appelle "sans trop reflechir" et garde
toute sa logique metier (qui paye, combien, quel plafond). OpenMulti decide "quel modele +
comment optimiser l'appel".

Regle d'or du decouplage:
- **OpenMulti** = "quel modele, et comment optimiser cet appel".
- **MyMULTI** = "ce tenant a-t-il le droit d'appeler, et je compte sa depense contre mes plans".

## 2. Etat actuel (point de depart)

Le "gateway" d'aujourd'hui n'est pas un gateway: c'est deux choses collees dans `lib/llm/`.

- `lib/llm/client.ts` (~176 lignes): appelle OpenRouter en direct (fetch natif), catalogue
  de modeles en dur (`MODELS`, `IMAGE_MODELS`), image gen multimodale.
- `lib/llm/gateway.ts` (~499 lignes): resolution modele par plan/business, caps abonnement,
  rate-limits, logging usage, ARS Coach, image gateway.
- `app/api/llm/v1/chat/completions/route.ts`: proxy OpenAI-compatible pour les agents OpenClaw
  (auth par `gatewayToken`, allowlist, softFail, steering provider, watchdog stream).

Le catalogue de modeles **fuit dans MyMULTI**: `DEFAULT_MODELS` et `plan.allowedModels`
contiennent des IDs OpenRouter en dur. C'est le couplage central a casser.

## 3. La frontiere: A (OpenMulti) vs B (MyMULTI)

| Bloc A - va dans OpenMulti | Bloc B - reste dans MyMULTI |
|---|---|
| Connexion providers (OpenRouter aujourd'hui, direct demain) | Resolution plan/business -> tier |
| Catalogue de modeles + mapping tier -> modele | Abonnement + cap mensuel USD (Stripe plans) |
| Routing `auto`, fallback, selection par tache | Logging `llm_usage`, `incrementBusinessCost` |
| Steering provider (`sort:throughput`, hack max_tokens Kimi) | Rate-limits jour (tokens) + images/jour |
| Watchdog stream stalle, streaming SSE | ARS Coach (caps pre/post-email) |
| Extraction usage/cout, image gen | Auth `gatewayToken` OpenClaw, `softFailPreference` |
| (plus tard) token reducer, monitoring qualite, learning | Compta + facturation, dashboard usage |

Consequence rassurante: **toute la logique billing/tenancy de MyMULTI ne bouge pas**. On ne
deplace derriere une frontiere HTTP que `client.ts` (l'appel OpenRouter) + le catalogue.

## 4. Le choix du modele: comment l'intelligence vit dans OpenMulti

C'est le point qui fait ou casse le decouplage.

Aujourd'hui MyMULTI dicte un **ID de modele exact** (`anthropic/claude-sonnet-4-5`). Demain
MyMULTI envoie une **intention**: un couple `(purpose, tier qualite/prix)`. OpenMulti recoit
`model: "auto"` + l'intention, et choisit l'ID reel dans **son** catalogue.

| Decision | Qui |
|---|---|
| "tache `agent`, business plan `pro` -> tier **balanced**" | MyMULTI (billing, reste) |
| "tier balanced + tache agent = `kimi-k2.6` aujourd'hui, autre demain" | OpenMulti (catalogue + routing) |

MyMULTI ne connait plus quels modeles existent: il connait 3 tiers. Changer le modele texte
de demain = toucher OpenMulti, MyMULTI ne bouge pas.

L'abstraction tier est **forward-compatible**:
- **v0**: tier -> un modele fixe (iso-comportement, zero regression).
- **v1**: tier -> routing reel entre plusieurs candidats du tier (le cerveau).
- **v2**: routing appris sur le contexte/feedback.

On ne passe jamais a la phase suivante sans que MyMULTI soit deja stable sur la precedente.

## 5. Le contrat d'API

OpenMulti expose l'API OpenAI standard (`POST /v1/chat/completions`, streaming inclus) plus
une extension OpenMulti.

Requete MyMULTI -> OpenMulti:
```jsonc
{
  "model": "auto",                 // ou alias "auto:economy" / "auto:quality"
  "messages": [ ... ],
  "stream": true,
  "openmulti": {
    "tier": "economy | balanced | quality",  // le tag qualite/prix
    "purpose": "agent | generation | light | edit-html-block",  // hint de tache (optionnel)
    "allow": ["provider/model", ...]          // contrainte dure optionnelle
                                              // (ex: OpenClaw impose un modele precis)
  }
}
```

Reponse OpenMulti -> MyMULTI (OpenAI standard + extension):
```jsonc
{
  "id": "...",
  "model": "anthropic/claude-sonnet-4-6",   // modele REELLEMENT choisi
  "choices": [ ... ],
  "usage": { "prompt_tokens": ..., "completion_tokens": ..., "cost": 0.0123 },
  "openmulti": { "reason": "agent task, balanced tier, fast provider" }  // tracabilite
}
```

Auth: header `Authorization: Bearer sk_...` (cle OpenMulti du projet appelant). OpenMulti fait
sa propre metrologie par cle (pour SON billing futur), mais ne connait **rien** des businesses
MyMULTI, de Stripe, ni des caps MyMULTI.

`usage.cost` est conserve: MyMULTI continue sa compta exactement comme aujourd'hui
(`logUsage` + `incrementBusinessCost`). Rien ne change cote facturation.

## 6. Les tiers

3 tiers (extensibles). Mapping tier -> modeles candidats vit dans OpenMulti uniquement.

| Tier | Intention | Exemple v0 (iso-comportement, a confirmer) |
|---|---|---|
| `economy` | le moins cher qui fait le job | `anthropic/claude-haiku-4-5` (= `MODELS.LIGHT`) |
| `balanced` | rapport qualite/prix | `anthropic/claude-sonnet-4-5` (= `MODELS.GENERATION`) |
| `quality` | priorite qualite | modele haut de gamme du catalogue |

Mapping MyMULTI `plan x purpose -> tier` (remplace `DEFAULT_MODELS`, surface reduite, plus
aucun ID OpenRouter dans MyMULTI):

| plan / purpose | generation | light | agent | edit-html-block |
|---|---|---|---|---|
| starter | economy | economy | economy | economy |
| pro | balanced | economy | balanced | balanced |
| business | balanced | economy | balanced | balanced |
| (no plan) | economy | economy | economy | economy |

Cette table est derivee 1:1 de l'actuel `DEFAULT_MODELS` (cf `lib/llm/gateway.ts:20`) pour
garantir l'iso-comportement v0.

## 7. Impact code MyMULTI (peu, et chirurgical)

Change:
- `DEFAULT_MODELS` + `plan.allowedModels` (IDs en dur) -> table `plan x purpose -> tier`.
- `modelConfigs` (override admin "quel modele pour ce plan") -> **migre vers OpenMulti**
  (c'est de l'override de catalogue). Voir nuance section 9.
- softFail "force le modele le moins cher" (`route.ts:75`) -> "envoie `tier: economy`".
  Reste une decision MyMULTI (liee au cap).
- `client.ts`: tape OpenMulti au lieu d'OpenRouter (derriere env var / flag).

Inchange:
- Caps, plans, abonnements, `llm_usage`, `incrementBusinessCost`, rate-limits, ARS Coach,
  auth `gatewayToken`, dashboard usage, toute la compta.

## 8. Plan de migration (strangler, zero regression)

Chaque phase est verifiable et rollback-able independamment.

1. **OpenMulti v0 = proxy iso-comportement.** Service TS separe qui reproduit EXACTEMENT le
   comportement actuel: memes IDs de modeles (via mapping tier fixe), meme `sort:throughput`,
   meme hack `max_tokens` Kimi, meme watchdog 60s. Pas d'intelligence encore.
   - Verif: diff de reponses sur un echantillon, parite stricte avec l'appel OpenRouter direct.
2. **MyMULTI pointe vers OpenMulti via flag.** Decoupe en sous-etapes:
   - **2a (fait):** `client.ts` + le proxy OpenClaw tapent OpenMulti via un upstream resolu
     (`lib/llm/upstream.ts`, flag `OPENMULTI_ENABLED`). IDs concrets, honores tels quels par
     OpenMulti (iso strict). Flag off = comportement actuel (rollback instantane).
   - **2b (fait, ADDITIF):** les appels internes (`llmGateway`/`llmGatewayStream`: light,
     generation, edit-html-block) envoient `model='auto' + openmulti:{tier,purpose}` quand le
     flag est on. `DEFAULT_MODELS` reste la source flag-off (supprime en phase 3). Mapping
     plan x purpose -> tier dans `lib/llm/tiers.ts`.
   - **2b-bis (a trancher produit):** convertir le path agent (provisioning OpenClaw, allowlist
     + softFail du proxy) en tiers. Question ouverte: l'agent choisit-il son modele ou OpenMulti
     choisit dans le tier ? Touche les containers -> hors d'un pas automatique.
   - Verif: parite sur staging, `/api/llm/v1` OpenClaw a l'identique, chat + image + ARS Coach
     + site editor OK.
3. **Bascule definitive.** OpenRouter n'est plus appele que par OpenMulti. On retire le flag et
   on supprime `DEFAULT_MODELS` (MyMULTI ne connait plus aucun ID de modele).
   - Verif: smoke prod, surveillance cout/latence 24-48h.
4. **Intelligence dans OpenMulti.** Routing `auto` reel (v1), puis token reducer, monitoring
   qualite. Adopte par MyMULTI purpose par purpose, opt-in. Aucun Big Bang.

Tag de rollback du point de depart: `pre-openmulti-decoupling`.

## 9. Nuance actee (a assumer)

Deplacer le catalogue + l'override admin (`modelConfigs`) dans OpenMulti veut dire que le
dashboard admin "changer le modele d'un plan" cote MyMULTI ne pilote plus directement un ID
de modele: il piloterait le **tier**, et le mapping tier -> modele vit dans OpenMulti. C'est
coherent avec la vision ("si demain je veux changer les modeles texte dans OpenMulti, je
peux") mais c'est une perte de granularite cote admin MyMULTI. Acte avant de coder (regle
projet #6: pas de regression silencieuse de feature).

## 10. Non-goals / hors perimetre v0-v3

- OpenMulti ne gere PAS le budget/plafond des businesses MyMULTI. Il route + optimise +
  metrique par cle. Le cap reste 100% MyMULTI.
- Pas de migration de schema DB MyMULTI cote billing.
- Le token reducer, le multi-model composition et le learning sont post-decouplage (phase 4+).

## 11. Decisions figees

- Forme: **service HTTP** (`api.openmulti.ai`, OpenAI-compatible). Pas une lib importee.
- Langage serveur: **TypeScript** (reutilise `client.ts`, meme stack, chemin le plus court
  vers l'iso-comportement).
- Frontiere policy: **billing 100% MyMULTI**; OpenMulti possede catalogue + tiers + routing.
- Contrat: **tiers qualite/prix** (`economy | balanced | quality`), pas d'IDs de modeles
  cote MyMULTI.
