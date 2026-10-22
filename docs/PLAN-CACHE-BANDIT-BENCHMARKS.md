# Plan — prompt caching, bandit partagé, curation par benchmarks (2026-10-21)

Trois lots issus de la revue du 2026-10-21 (backlog recherche `openmulti-research/ENGINEERING_BACKLOG.md`
+ état prod). Ordre : lot 1 (fait, branche `feat/prompt-cache-accounting`), lot 2 (R-1, à décider),
lot 3 (benchmarks OpenRouter, console). Chaque fait ci-dessous a été vérifié le 2026-10-21 à la
source citée — rien de mémoire.

## Lot 1 — comptabilité du prompt caching (FAIT, à relire/merger)

Avant : `pricing.ts` facturait tout l'input au tarif cache MISS (borne haute), l'écriture de cache
Anthropic (1.25x) au tarif input (borne BASSE), et aucun chemin direct ne lisait les tokens cachés.
Le bandit ne voyait donc jamais la remise réelle d'un modèle qui cache bien.

Fait :
- `ModelPrice.cachedInputPerMTok` / `cacheWriteInputPerMTok` (optionnels ; absents = plein tarif,
  jamais optimiste par défaut). `computeCostUsd(model, prompt, completion, { read, write })`, comptes
  écrêtés au prompt. Override env `OPENMULTI_PRICING_JSON` les accepte.
- Tarifs vérifiés : Anthropic (platform.claude.com/docs/en/about-claude/pricing : hit 0.1x, écriture
  5 min 1.25x), OpenAI (developers.openai.com/api/docs/pricing, colonne « Cached input »), Moonshot
  kimi-k2.6 (0.16, vérif repo 2026-06-10). NON modélisés (plein tarif) : DeepSeek (page pricing rendue
  côté client, seule la version CNY est lisible : flash hit 0.02¥ / miss 1¥ / out 4¥ heures creuses —
  à convertir sur la page USD avant d'inscrire quoi que ce soit), Z.ai, Qwen, Mistral, Gemini.
- Lecture des tokens cachés (`sse.ts` `cachedPromptTokens`) : `prompt_tokens_details.cached_tokens`
  (OpenAI, Moonshot, OpenRouter) ou `prompt_cache_hit_tokens` (DeepSeek, api-docs.deepseek.com/guides/kv_cache).
  Anthropic : `cache_read_input_tokens` / `cache_creation_input_tokens`, exposés à l'appelant en
  graphie OpenAI (`prompt_tokens_details`).
- `cache_control` passe tel quel vers Anthropic direct (parts texte user + system → blocs). Pas
  d'auto-marquage : l'écriture coûte 1.25x, seul l'appelant sait s'il relira.
- Devis (`plan.ts`) : `cache_control` présent → borne d'entrée au tarif d'écriture (pire cas).
- Métrique `openmulti_tokens_total{kind="prompt_cached"}` (sous-ensemble de `prompt`) : taux de cache
  par projet × modèle × chemin.

Effets de bord à connaître :
- `PRICING_TABLE_VERSION` change → les jetons de devis émis avant le déploiement sont refusés (409
  `quote_conflict`, comportement E-1 attendu).
- Le chemin OpenRouter était déjà juste (cost calculé par OpenRouter, remise comprise) ; seule la
  métrique `prompt_cached` y est nouvelle.

Reste ouvert (décision produit) : auto-marquage `cache_control` pour `purpose: agent` sur Anthropic
direct (boucles OpenClaw : relecture quasi certaine, gain ~10x sur l'input répété ; perte de 25 % sur
un appel unique). Proposition : opt-in `OPENMULTI_ANTHROPIC_AUTO_CACHE=agent`, marqueur sur le
dernier bloc system + la dernière tool definition, jamais sur les messages.

## Lot 2 — R-1 : état du bandit partagé entre pods (FAIT, 2026-10-22)

Constat : prod = 2 replicas, bandit en mémoire par pod → apprentissage split-brain, cold start à
chaque rollout. À faible trafic (le cas prod), c'est pire : 10 échantillons par candidat ET par pod
avant d'exploiter, et un bras malade re-sondé seulement après ~600 observations (décompte amorti
sous le plancher) — des semaines.

Décision (après discussion) : PAS de décote temporelle. Un horizon court évapore les données à
faible trafic (exploration permanente = régime effondré par le trafic) ; un horizon long n'apporte
rien. La décote par observation est conservée, le temps n'entre que dans la sonde de guérison.

Fait (`src/bandit.ts`, extrait de `metrics.ts`) :
- État partagé : observation appliquée en mémoire + `EVAL` Lua atomique fire-and-forget sur le hash
  `bandit:arms` (décote des bras en portée + ajout, purge sous 1e-4) ; refresh 10 s qui remplace la
  vue mémoire ; premier refresh au boot = reprise après rollout. Zéro I/O sur le chemin chaud.
  Store down = vue locale ; pertes comptées (`openmulti_bandit_store_drops_total`).
  `OPENMULTI_BANDIT_SHARED=0` = état par pod (historique).
- R-2 au passage : décote à portée des candidats de la décision (`RequestRecord.candidates`), globale
  sinon.
- Sonde de guérison temporelle : bras malsain silencieux depuis `OPENMULTI_SMART_RECOVERY_PROBE_S`
  (600 s) → une requête, prioritaire sur l'exploration ; échec = délai complet, succès = enchaîne
  jusqu'à guérison. Le plancher de décompte historique subsiste (états sans horodatage).
- Tests : `test/bandit-shared.test.ts` (10), `test/bandit.test.ts` (+5, horloge injectée),
  `test/bandit-redis.test.ts` (Lua ≡ mémoire contre un vrai Redis 8, gated par
  `OPENMULTI_TEST_REDIS_URL` — vérifié localement, 2/2).

À surveiller après déploiement : `openmulti_bandit_store_drops_total` (doit rester à 0) et les
raisons `smart: recovery probe` dans les logs (une par bras malade et par délai, pas plus).

## Lot 3 — curation par benchmarks OpenRouter + Pareto + dérive de prix (FAIT, 2026-10-22)

Source vérifiée : exports publics quotidiens, CC BY 4.0, sans clé :
`https://openrouter.ai/api/v1/datasets/exports/benchmark-leaderboard/latest.json`
(manifest + sha256 dans `latest.manifest.json`). ~2 180 lignes, 2 benchmarks
(`gpqa_diamond`, `tau_bench_verified_airline`), une ligne par (benchmark, version de modèle, provider).
L'endpoint `/api/v1/benchmarks` exige une clé. Le badge « Pareto » n'est PAS dans l'export : recalculé.

Fait :
- Gateway `src/openrouter-benchmarks.ts` : manifest → export daté, sha256 vérifié avant parsing,
  cache 24 h, fail-open (dernier état connu, sinon null). Agrégation par benchmark × modèle : ligne
  `auto-routing` si mesurée, sinon la plus précise (coût de la MÊME ligne). Front de Pareto + « best
  value » (≤ 5 pts du max, le moins cher du front). `GET /admin/benchmarks`.
- Gateway `src/pricing-drift.ts` : table vs feed `/api/v1/models` (prix par token → $/MTok), tolérance
  `OPENMULTI_PRICING_DRIFT_PCT` (10). `GET /admin/pricing/drift`, jauge
  `openmulti_pricing_drift_ratio{model,side}`, un warn par changement de l'ensemble dérivant. Jamais
  de correction automatique.
- Console `/admin/models` : badges par candidat de slot (τ²-airline / GPQA : accuracy, coût par tâche,
  ★ Pareto ; « prix ≠ OpenRouter ») + section « Signaux de curation » : front de Pareto par benchmark
  (modèles au catalogue surlignés, bascule « tous les modèles », lien page OpenRouter, attribution
  CC BY 4.0, limites dites) + tableau de dérive de prix. Les deux signaux sont optionnels : la page
  reste entière s'ils manquent.
- Vérifié de bout en bout le 2026-10-22 contre les exports du jour : 159 modèles GPQA (front 9),
  146 τ²-airline (front 6) ; dérive sur 7 modèles tarifés (deepseek-chat, deepseek-v4-flash,
  kimi-k2.6, gpt-oss-120b, qwen-plus, glm-4.5-air, glm-5) — À VÉRIFIER à la source de chaque vendor
  avant de toucher `pricing.ts` (règle du repo).
- Tests : `test/openrouter-benchmarks.test.ts` (10), `test/pricing-drift.test.ts` (6).

Limites dites dans l'UI : τ²-airline mesure du tool-calling agentique (proxy des `agent_*`), GPQA du
raisonnement scientifique ; ni l'un ni l'autre ne mesure la rédaction ou le code. Un modèle absent
n'est pas « mauvais », il n'a pas été passé. Le gateway n'utilise aucun de ces scores dans le routage.

## Clôture 2026-10-22

- Auto `cache_control` agent : FAIT en opt-in (`src/auto-cache.ts`, `OPENMULTI_ANTHROPIC_AUTO_CACHE=agent`),
  devis borné au tarif d'écriture. Non activé en prod par défaut : à poser dans les manifests ops si voulu.
- Dérive de prix vérifiée à la source le 2026-10-22 : seul `z-ai/glm-5` était périmé (0.6/1.92 → 1/3.2,
  cached 0.2, corrigé). kimi-k2.6, qwen-plus, glm-4.5-air : la table = prix vendor, OpenRouter affiche un
  provider tiers moins cher (pas une erreur de table). gpt-oss-120b : borne multi-providers par
  construction. deepseek-chat côté OpenRouter n'est pas le même modèle que l'alias DeepSeek direct.
- DeepSeek en USD : page officielle non lisible (403 / rendu client) — prix cache NON inscrits (sources
  secondaires seulement). À reprendre quand la page redevient lisible.
