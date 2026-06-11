# OpenMulti — API

OpenMulti est une passerelle compatible OpenAI : tout client/SDK OpenAI fonctionne en
changeant `base_url` et la clé. La valeur ajoutée passe par le champ `model` (alias
d'intention) et l'extension `openmulti` — les deux sont optionnels : sans eux, OpenMulti
se comporte comme un proxy transparent.

## Authentification

`Authorization: Bearer sk_<projet>_<secret>` — une clé par projet consommateur.
Sans clé valide : `401`.

## POST /v1/chat/completions

Corps : requête OpenAI standard (`messages`, `stream`, `max_tokens`, `tools`, …), plus :

| Champ | Valeurs | Effet |
|---|---|---|
| `model` | `auto` | OpenMulti choisit (tier par défaut : balanced) |
| | `auto:economy` / `auto:balanced` / `auto:quality` | tier encodé dans l'alias |
| | `vendor/model` concret | honoré tel quel, aucun routage |
| `openmulti.tier` | `economy` / `balanced` / `quality` | niveau qualité/prix visé |
| `openmulti.purpose` | `generation`, `light`, `agent`, … | la tâche ; affine le choix (ex. `agent` → modèle de code) |
| `openmulti.allow` | `["vendor/model", …]` | contrainte dure : ne choisir que dans cette liste |
| `openmulti.route` | `default` / `smart` | `smart` = bandit coût/santé parmi les candidats du tier |
| `modalities` | `["image","text"]` | génération d'image (routée vers le modèle image) |

Réponse : OpenAI standard.
- `usage.cost` (USD) est **toujours** présent en fin de réponse/stream — fourni par
  l'upstream ou synthétisé par OpenMulti sur les chemins directs.
- Si la requête contenait un bloc `openmulti`, la réponse non-stream porte
  `openmulti.reason` (trace de routage lisible). Sinon la réponse est strictement
  identique à celle de l'upstream.
- En stream, la décision de routage est exposée dans les en-têtes `X-OpenMulti-Model`
  et `X-OpenMulti-Reason`.

Erreurs : `400` (corps invalide), `401`, `413` (corps > limite), `429` (rate limit,
avec `Retry-After`), `504` (upstream injoignable après retries). Les erreurs upstream
sont relayées avec leur statut d'origine.

## POST /v1/embeddings

Pass-through OpenAI-compatible (`input`, `model`, `dimensions`, …) :
`model: "auto"` → le modèle d'embeddings par défaut (`OPENMULTI_MODEL_EMBEDDING`,
`openai/text-embedding-3-small` sinon) ; un id concret est honoré tel quel. Mêmes
règles que le chat : bloc `openmulti` strippé à l'aller, réponse byte-identique sans
extension, retry borné sur panne transitoire, plafond de dépense appliqué, usage/coût
mesurés.

## Tool-calling & structured outputs

`tools`, `tool_choice`, `response_format` (json_schema) et les messages `role: "tool"`
passent **verbatim** vers l'upstream, et les réponses `tool_calls` reviennent
intactes — garanti par le test de contrat (cas 6a/6b), pas seulement constaté.

## GET /v1/models

Liste OpenAI (`{object:"list", data:[…]}`) : les alias d'intention (`auto`,
`auto:<tier>`, marqués `openmulti.alias: true`) puis les modèles concrets servis, avec
pour chacun `openmulti.tiers`, `openmulti.purposes`, et `openmulti.pricing`
(USD/MTok, uniquement quand le prix est vérifié — chemins directs ; sur le chemin
OpenRouter, le coût réel arrive par réponse dans `usage.cost`).

## GET /metrics (ops)

Prometheus, authentifié (token ops dédié ou clé appelante). Compteurs par
projet × modèle × chemin d'accès. Réservé à l'exploitation — voir
`docs/OBSERVABILITY-SETUP.md`.

## Administration des clés et plafonds (ops)

Token ops strictement requis (comme `/admin/usage`).

- `POST /admin/keys {project, capUsdPerDay?}` → `{key, id, project}` — le secret n'est
  retourné **qu'à la création**. Le projet doit matcher `^[a-z0-9-]{1,32}$`.
- `GET /admin/keys` → liste **rédigée** (id, projet, date, état, plafond — jamais le secret).
- `DELETE /admin/keys/:id` → révocation (effet immédiat sur le pod local, ≤ 10 s ailleurs).
- `PUT /admin/caps/:project {usdPerDay}` → plafond de dépense **journalier (UTC), par
  projet** (l'unité de facturation — toutes les clés d'un projet le partagent ; `0` le
  retire). Plafond atteint → les requêtes du projet reçoivent `429`
  `spend_cap_exceeded` avec `Retry-After` jusqu'à minuit UTC. Sans plafond : aucun
  changement. Panne du store : fail-open (le trafic n'est jamais coupé par une panne Redis).

## GET /admin/usage (ops)

`?key=<projet>&days=<n>` — l'usage **durable** d'un projet (requêtes, erreurs, tokens,
coût USD) agrégé sur la fenêtre : totaux, par modèle×chemin, par jour UTC. C'est la
source pour facturer (survit aux restarts, contrairement à /metrics). Token ops
strictement requis (`OPENMULTI_METRICS_TOKEN`) — une clé appelante est refusée.
`503` si le metering n'est pas configuré (`REDIS_URL`).
