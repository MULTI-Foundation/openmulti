# Produit v1 — cadrage (2026-06-11)

> Périmètre acté par le mainteneur le 11 juin : amener OpenMulti « au niveau d'un
> OpenRouter pour nos clients », **sans** l'exposition publique pour l'instant
> (OM-06/07 + ingress/TLS restent différés, cf l'audit) et **sans** BYOK.
> Le jalon 3 (différenciation : compress, optimize) viendra après.

## Ce qui est dans le périmètre

### Socle business (ex-jalon 1, items 2-4)

1. **Cycle de vie des clés** — sortir les clés de l'env statique : créer/révoquer
   sans redéploiement, plusieurs clés par projet, plafonds par clé (dépense/jour,
   rate limit). API d'admin authentifiée par le token ops (`OPENMULTI_METRICS_TOKEN`
   ou un token admin dédié).
2. **Metering durable** — les métriques in-memory s'effacent au restart : inutilisable
   pour facturer. Comptage persistant par clé × modèle (requêtes, tokens, coût),
   distinct de Prometheus (qui reste le monitoring).
3. **API produit minimale** — `GET /v1/models` (catalogue + tiers + prix connus),
   docs API (`docs/API.md`).

### Parité d'usage (ex-jalon 2, sauf BYOK)

4. **Fallback cross-provider** (étape 6 de la spec multi-provider) : d'abord entre
   chemins d'accès du même modèle (préserve la réponse), puis cross-model opt-in.
5. **Endpoints supplémentaires** : embeddings (pass-through OpenRouter) en premier ;
   et **verrouiller par tests de contrat** le pass-through tool-calling / structured
   outputs (ça transite déjà, ça doit être garanti).
6. **État partagé** : rate-limit/metering multi-replica (le bandit peut rester
   per-pod, il est advisory).
7. **Curation catalogue** : 15-20 modèles bien choisis par tier/purpose, prix
   vérifiés pour les chemins directs (continu, config + pricing).

## Décisions structurantes

- **Store : Redis** (mono-pod, PVC local-path comme Prometheus, AOF). Une seule pièce
  d'infra couvre 1 (registre de clés), 2 (compteurs durables) et 6 (rate-limit
  partagé). SQLite écarté (bloque le multi-replica) ; Postgres surdimensionné ici.
- **Compat descendante stricte** : `OPENMULTI_API_KEYS` (env) reste valide — les clés
  env sont fusionnées avec le registre Redis, et sans Redis configuré, tout marche
  comme aujourd'hui (dev local, tests). Chaque brique est opt-in par env.
- **Prometheus ne facture pas** : le metering durable est une écriture séparée
  (Redis), Prometheus reste le monitoring temps réel. Pas de double usage.

## Hors périmètre (différé, décision du 11 juin)

- Exposition publique : ingress/TLS/domaine, OM-06 (allowlist de champs), OM-07
  (normalisation des erreurs), page de statut publique.
- BYOK (le client apporte sa clé vendor).
- Jalon 3 : `openmulti.compress` (Headroom-like), optimize (optillm-like), latence
  dans le score bandit.

## Ordre d'exécution

| # | Incrément | Statut |
|---|---|---|
| A | `GET /v1/models` + docs API | ✅ PR #18 |
| B | Valkey + metering durable par clé (`meter.ts`, `/admin/usage`) | ✅ |
| C | Cycle de vie des clés + plafonds de dépense | |
| D | Fallback cross-provider (chemins d'abord) | |
| E | Embeddings + tests de contrat tools/structured outputs | |
| F | Rate-limit sur l'état partagé | |
| G | Curation catalogue (continu) | |

> Choix d'image acté le 11 juin : **Valkey** (fork Redis, Linux Foundation, BSD) —
> protocole et client identiques, licence sans ambiguïté. Activation staging : les
> objets Valkey de `deploy/staging.yaml` sont à appliquer manuellement par un admin
> (la CI ne fait que `set image`), cf l'en-tête du manifeste.
