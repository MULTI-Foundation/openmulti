# OpenMulti — Audit de sécurité

- **Date** : 2026-06-08
- **Cible** : repo `MULTI-Foundation/openmulti` @ `c30aca2` (post-merge PR #1)
- **Périmètre** : service HTTP OpenMulti (Hono/TypeScript) + image Docker + manifests k3s (`deploy/staging.yaml`) + pipeline CI (`.github/workflows/ci.yml`). Le code consommateur MyMULTI est hors périmètre (audité séparément).
- **Méthode** : revue de code manuelle (auth, routing, streaming, métriques, config), revue infra (Dockerfile, manifests, RBAC, NetworkPolicy), `npm audit`, analyse du modèle de menace.

## TL;DR — posture

Posture **globalement saine** pour un v0. L'infra est bien durcie et il n'y a **aucune faille critique** (pas de RCE, pas de SSRF, pas de secret versionné, 0 vuln npm). Les findings se concentrent sur la **couche applicative** et tournent autour d'un même axe : OpenMulti détient une clé OpenRouter **partagée** et n'impose, côté serveur, **aucune limite de débit ni de coût** par clé appelante. Acceptable tant que le seul appelant est MyMULTI derrière une NetworkPolicy stricte (staging actuel) ; **bloquant avant l'exposition publique** visée (`api.openmulti.ai`).

Chaque finding est noté pour les **deux contextes** : *staging actuel* (réseau verrouillé, 1 appelant de confiance) et *service public* (objectif annoncé).

## Points forts (à conserver)

- **Conteneur durci** : `runAsNonRoot` + `runAsUser:1000`, `allowPrivilegeEscalation:false`, `readOnlyRootFilesystem:true`, `capabilities.drop:[ALL]`, image multi-stage, `NODE_ENV=production`, limites CPU/mémoire.
- **Réseau** : NetworkPolicy `default-deny` (ingress+egress) sur le namespace dédié ; ingress restreint aux pods `multi-app` du ns `multi-staging` ; egress limité à DNS + 443. OpenMulti **n'est pas exposé à Internet** en staging.
- **RBAC CI** : ServiceAccount de déploiement scopé au seul ns `openmulti-staging` (ne peut toucher ni `multi-staging` ni la prod). Secrets jamais versionnés (créés hors manifeste, injectés via `secretKeyRef`).
- **Secrets** : `.env*` gitignorés (sauf `.env.example`), `.dockerignore` exclut `.env*`, aucune valeur sensible dans le repo.
- **Pas de SSRF** : l'URL upstream (`OPENROUTER_BASE_URL`) est **uniquement** côté serveur, jamais dérivée de la requête appelante.
- **Hygiène de logs** : le **contenu** des messages n'est jamais loggé (seulement `messages.length`) ; les clés brutes ne sont jamais loggées (`keyLabel` masque/hash → jamais le `sk_…`).
- **Auth fail-closed** : refuse de booter en production si l'allowlist de clés est vide (`config.ts`).
- **Dépendances** : surface minimale (hono + @hono/node-server), `npm ci` déterministe, `npm audit` = 0 vuln.

## Findings

| ID | Sévérité (public / staging) | Sujet | Statut |
|---|---|---|---|
| OM-01 | **Haute** / Moyenne | Pas de rate-limit ni de plafond de coût par clé → épuisement de coût / DoS sur la clé OpenRouter partagée | **Corrigé (opt-in)** |
| OM-02 | **Haute** / Moyenne | Pas de limite de taille de corps de requête → DoS mémoire | **Corrigé** |
| OM-03 | Moyenne / Moyenne | `/metrics` lisible par **n'importe quelle** clé appelante → fuite cross-tenant de métriques business | **Corrigé (opt-in)** |
| OM-04 | Moyenne / Faible | Comparaison de clé API non constante en temps (timing attack) | **Corrigé** |
| OM-05 | Moyenne / Faible | Entrée appelante (`model`, `purpose`) reflétée non-sanitisée dans les en-têtes de réponse (injection d'en-tête / CRLF) | **Corrigé** |
| OM-06 | Faible / Faible | Pass-through non restreint des champs de requête vers l'upstream | Ouvert |
| OM-07 | Faible / Faible | Corps/branche d'erreur upstream renvoyés verbatim (divulgation d'info) | Ouvert |
| OM-08 | Faible / Faible | `/health` non authentifié divulgue la version (fingerprinting) | Ouvert |
| OM-09 | Faible / Faible | Image référencée par tag (`:latest`) et non par digest (immutabilité supply-chain) | Ouvert |
| OM-10 | Info / Info | Pas d'arrêt gracieux (SIGTERM) — flux en cours coupés au rollout (disponibilité) | Ouvert |

> **Mise à jour 2026-06-09** — OM-01/02/03 corrigés (branche `fix/security-hardening-om-01-02-03`),
> tous opt-in (défaut = comportement actuel), chacun avec ses tests (`test/security-hardening.test.ts`) :
> rate-limit par clé (`OPENMULTI_RATE_LIMIT_PER_MIN`), plafond `max_tokens`/tier
> (`OPENMULTI_MAX_TOKENS_*`), limite de taille de corps (`OPENMULTI_MAX_BODY_BYTES`, défaut 8 MiB,
> gardée au Content-Length + à la lecture), et token ops dédié pour `/metrics`
> (`OPENMULTI_METRICS_TOKEN`, comparaison constant-time, fallback sur l'auth appelante si absent).
>
> **Mise à jour 2026-06-09 (suite)** — OM-04/05 corrigés (branche `fix/security-hardening-om-04-05`) :
> comparaison constant-time des clés appelantes (sans court-circuit sur la clé qui matche) ; et
> sanitisation des en-têtes `X-OpenMulti-*` (`headerSafe` retire CR/LF + contrôles, cap 256) — choix
> de nettoyer en sortie plutôt que rejeter en entrée, pour ne casser aucune requête valide. Tests :
> `test/sanitize.test.ts` + cas d'intégration CRLF dans `contract.test.ts`.

---

### OM-01 — Aucun rate-limit ni plafond de coût par clé (Haute / Moyenne)

**Où** : `src/auth.ts`, `src/routes/chat.ts` (pas de garde de débit/coût), `src/config.ts`.
**Détail** : OpenMulti détient une clé OpenRouter **partagée** (`OPENROUTER_API_KEY`) et facture l'upstream pour le compte de l'opérateur. Une clé appelante valide peut émettre un nombre illimité de requêtes, demander **n'importe quel** modèle du catalogue (y compris les plus chers), et fixer un `max_tokens` arbitraire. La gestion des plafonds est **entièrement** côté MyMULTI (par design, cf `ARCHITECTURE.md` §10) — OpenMulti n'a aucune notion de quota propre.
**Impact** : une clé fuitée ou un appelant abusif → dépense OpenRouter non bornée (épuisement de budget) et/ou flooding → déni de service pour les autres appelants. Le `model` étant libre, le coût n'est pas borné par tier.
**Likelihood** : Moyenne en staging (1 appelant de confiance, réseau verrouillé) ; Haute en service public.
**Reco** :
- Rate-limit par clé (req/s + tokens/jour) au middleware — les compteurs du registre `metrics.ts` fournissent déjà la matière.
- Plafond `max_tokens` serveur par tier (clamp) pour borner le coût unitaire.
- (Service public) plafond de dépense par clé + circuit-breaker global sur la clé OpenRouter.

### OM-02 — Pas de limite de taille de corps (Haute / Moyenne)

**Où** : `src/routes/chat.ts` → `await c.req.json()`.
**Détail** : le corps entier est désérialisé en mémoire puis re-sérialisé vers l'upstream. Aucune borne de taille (Hono ne plafonne pas par défaut). Un corps géant (gros `messages`) → pression mémoire ; limite pod 256Mi → OOMKill.
**Impact** : DoS mémoire d'un simple POST volumineux.
**Reco** : imposer une taille max de corps (ex. `Content-Length` + garde de lecture) et un plafond `messages.length` ; rejeter en 413.

### OM-03 — `/metrics` lisible par toute clé appelante (Moyenne)

**Où** : `src/app.ts` (`app.use('/metrics', auth)`), `src/metrics.ts` (`renderProm`).
**Détail** : `/metrics` est protégé par **le même** middleware d'auth que `/v1`. Donc n'importe quelle clé appelante valide peut lire **toutes** les séries — coût, tokens, modèles, taux d'erreur — **de tous les projets** (labellisés par projet). Si un 2ᵉ consommateur existe, il lit les métriques business de MyMULTI.
**Impact** : divulgation cross-tenant de données business (coût/usage) à tout détenteur d'une clé valide.
**Reco** : protéger `/metrics` par un **token d'ops dédié** (`OPENMULTI_METRICS_TOKEN`) distinct des clés appelantes, et/ou restreindre l'accès réseau au seul scraper Prometheus. En staging, le réseau verrouillé limite déjà la portée mais la séparation logique reste recommandée.

### OM-04 — Comparaison de clé non constante en temps (Moyenne / Faible)

**Où** : `src/auth.ts` → `config.apiKeys.includes(key)`.
**Détail** : `Array.includes` compare octet par octet avec court-circuit → fuite de timing théorique permettant de deviner une clé valide caractère par caractère.
**Impact** : exfiltration de clé par mesure de timing (difficile sur le réseau, réaliste localement/à fort volume).
**Reco** : comparaison constante (`crypto.timingSafeEqual` sur des longueurs égalisées, ou comparer un hash de la clé fournie aux hash des clés autorisées).

### OM-05 — Entrée appelante reflétée dans les en-têtes de réponse (Moyenne / Faible)

**Où** : `src/routes/chat.ts` → `headers: { 'X-OpenMulti-Model': decision.model, 'X-OpenMulti-Reason': decision.reason }`.
**Détail** : sur le chemin "modèle concret", `decision.model === req.model` (contrôlé par l'appelant). `decision.reason` inclut `openmulti.purpose`, une **chaîne libre** également contrôlée par l'appelant. Ces valeurs sont reflétées dans des en-têtes HTTP de réponse sans validation. Un `\r\n` injecté tente une scission d'en-tête (response splitting). En pratique la couche http de Node **rejette** les valeurs d'en-tête contenant `\r\n` (→ 500 plutôt qu'une scission), donc l'exploitation est probablement neutralisée par le runtime — mais refléter de l'entrée non sanitisée dans un en-tête reste une mauvaise pratique.
**Reco** : valider `model`/`purpose` contre un charset strict (ex. `^[A-Za-z0-9._:\-\/]+$`) avant de router, et/ou ne refléter que des valeurs serveur. Borne aussi la longueur du `reason`.

### OM-06 — Pass-through non restreint vers l'upstream (Faible)

**Où** : `src/types.ts` (`[k: string]: unknown`), `src/providers/openrouter.ts` (`{ ...rest }`).
**Détail** : tous les champs de la requête appelante sont transmis à OpenRouter (`models`, `transforms`, `route`, options `provider.order/only/ignore`, etc.). L'appelant peut donc influencer la sélection de provider, désactiver des transforms, etc. — au-delà de l'abstraction tier voulue. Ce n'est pas une compromission serveur (c'est leur propre appel LLM), mais OpenMulti n'impose aucune politique sur ce qui est demandé en amont.
**Reco** : passer à une **allowlist** de champs transmis (les champs OpenAI/OpenRouter explicitement supportés) plutôt qu'un pass-through total ; au minimum, documenter ce contrat.

### OM-07 — Erreur upstream renvoyée verbatim (Faible)

**Où** : `src/routes/chat.ts` → `new Response(text, { status: upstream.status, … })`.
**Détail** : le corps et le statut d'erreur d'OpenRouter sont renvoyés tels quels à l'appelant. Peut divulguer des détails internes (provider, routing, identité de l'upstream).
**Reco** : normaliser les erreurs (mapper vers un schéma d'erreur OpenMulti stable), logguer le détail côté serveur seulement.

### OM-08 — `/health` divulgue la version (Faible)

**Où** : `src/app.ts` → `{ status, service, version: '0.0.1' }`.
**Détail** : endpoint non authentifié exposant nom de service + version (fingerprinting d'éventuelles CVE). Acceptable pour une sonde k8s, mais inutile d'exposer la version publiquement.
**Reco** : si exposé hors cluster, retirer `version`/`service` de la réponse publique (ou garder un `/health` interne riche et un `/health` public minimal).

### OM-09 — Image par tag, pas par digest (Faible)

**Où** : `deploy/staging.yaml` (`image: …/openmulti:latest`), `Dockerfile` (`FROM node:22-alpine`).
**Détail** : la CI fait bien `set image` au **sha exact** à chaque déploiement (les workloads tournent donc épinglés), mais un `kubectl apply` à froid tirerait `:latest` ; et l'image de base est référencée par tag mutable, pas par digest.
**Reco** : épingler l'image de base par digest (`node:22-alpine@sha256:…`) ; envisager la signature/attestation d'image (cosign) avant l'exposition publique.

### OM-10 — Pas d'arrêt gracieux (Info)

**Où** : `src/index.ts`.
**Détail** : pas de handler SIGTERM ; au rollout, les flux SSE en cours sont coupés net. Impact disponibilité plutôt que sécurité.
**Reco** : drainer les connexions sur SIGTERM (fermer le serveur, laisser un délai aux streams en cours).

## Hors périmètre / non-findings

- **SSRF** : non applicable — l'upstream est figé côté serveur.
- **Plafonds / facturation** : par design 100% MyMULTI (cf `ARCHITECTURE.md`). OM-01 ne conteste pas ce choix mais souligne qu'OpenMulti a besoin d'un garde-fou *propre* (rate-limit/circuit-breaker) avant l'ouverture publique, indépendant de la compta MyMULTI.
- **Modération / prompt-injection du contenu** : OpenMulti ne fait que router ; l'interprétation du contenu relève de l'application consommatrice.
- **CORS** : non pertinent (API serveur-à-serveur ; aucun en-tête CORS émis → pas de lecture cross-origin navigateur).

## Feuille de route de remédiation (priorisée)

**Avant toute exposition publique (`api.openmulti.ai`)** :
1. OM-01 — rate-limit + plafond de coût/`max_tokens` par clé (+ circuit-breaker global).
2. OM-02 — limite de taille de corps + nb de messages.
3. OM-03 — token d'ops dédié pour `/metrics`.

**Durcissement à court terme (faisable maintenant, staging)** :
4. OM-04 — comparaison de clé constante en temps.
5. OM-05 — validation `model`/`purpose` + bornage avant reflet en en-tête.

**Hygiène / dette** :
6. OM-06 allowlist de champs ; OM-07 normalisation d'erreurs ; OM-08 health public minimal ; OM-09 digest+signature d'image ; OM-10 arrêt gracieux.

> Chaque correctif de comportement doit arriver **avec son test** (règle projet, cf `CLAUDE.md`). Idéalement, ajouter au `contract.test.ts`/aux tests unitaires : rejet >limite de taille (OM-02), 401 `/metrics` sans token d'ops (OM-03), rejet d'un `model`/`purpose` avec charset invalide (OM-05).
