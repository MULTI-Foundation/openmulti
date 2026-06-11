# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Chaque changement de comportement a un test

Règle non négociable (le mainteneur y tient). Tout changement qui touche le comportement
**arrive avec un test qui le verrouille**, dans la même passe — pas « plus tard ». Vaut pour les
fixes de robustesse autant que les features : un bug corrigé sans test de non-régression n'est pas
fini. Si un changement est dur à tester depuis l'app (parsing, boot, edge case de stream),
**extrais une fonction pure** et teste-la (cf `src/sse.ts` + `test/sse.test.ts`). Préfère un test
ciblé (`test/<unit>.test.ts`) au tout-intégration quand c'est de la logique isolable. Et ne jamais
prétendre « c'est testé » sans avoir mappé le changement à un test précis : avant de l'affirmer,
relis la liste `npm test` et pointe lequel couvre quoi. Garde le `npm test` + `npm run typecheck`
verts à chaque commit (la CI les rejoue par commit).

## Toujours vérifier avant d'affirmer ou de supprimer

Règle non négociable (le mainteneur y tient). Ne jamais qualifier du code de « mort »,
« inutilisé » ou « à supprimer », ni affirmer un comportement, sans l'avoir **vérifié dans le
code** — et pas seulement dans ce repo. OpenMulti a un consommateur réel, **MyMULTI**
(`/home/julien/multi`, voir `lib/llm/`) : un export qui paraît inutilisé ici peut être un *seam*
pour une capacité du bloc A (ex. la génération d'image passe par `modalities` sur
`/v1/chat/completions`). Avant de retirer ou de réécrire : grep l'usage ici **et** côté MyMULTI,
confronte à `docs/ARCHITECTURE.md`, et dans le doute demande. En cas de gap réel, le boucher
(et le verrouiller par un test de contrat) plutôt que d'effacer le marqueur.

## Commits : pas de co-signature

Le mainteneur ne veut **aucune co-signature Claude** sur les commits. Ne **jamais** ajouter de
trailer `Co-Authored-By: Claude …` (ni mention équivalente) aux messages de commit.

## What this is

OpenMulti is an OpenAI-compatible HTTP gateway (TypeScript / Hono) that turns a caller's
*intention* into a *concrete model call*. A caller sends `model: "auto"` plus an `openmulti`
extension `{ tier, purpose, allow }`; OpenMulti resolves that to a real provider/model id,
applies provider steering, forwards to the upstream provider (OpenRouter today), and pipes the
response back. It was just decoupled out of **MyMULTI**, which remains the only consumer for now.

The hard rule of the decoupling (see `docs/ARCHITECTURE.md`):
- **OpenMulti** owns "*which* model, and *how* to optimize this call" — catalog, tiers, routing, steering.
- **MyMULTI** (the caller) owns "is this tenant allowed, and bill their spend" — auth, plans, caps, usage logging. None of that lives here.

Current state is **v0: iso-comportement**. The routing is a deterministic tier→model lookup that
exactly reproduces MyMULTI's prior behavior. The "intelligence" (real `auto` routing, learning) is
intentionally not built yet — `src/router.ts` is the seam where it lands later. Do not add routing
intelligence without an explicit ask; v0's contract is "zero regression vs. the old direct call".

## Commands

```bash
npm run dev        # tsx watch src/index.ts (hot reload)
npm run typecheck  # tsc --noEmit — run this as the lint/CI gate (there is no eslint)
npm test           # node --test over test/*.test.ts (the contract test; upstream is mocked, no network)
npm run build      # tsc -> dist/
npm start          # node dist/index.js
```

Run a single test by name: `node --import tsx --test --test-name-pattern '4a' test/contract.test.ts`

`config.ts` throws on missing `OPENROUTER_API_KEY` at import time, so `dev`/`start` need a real
`.env` (copy `.env.example`). The contract test sets the required env vars itself before importing.

## Request flow (the whole request lifecycle)

`src/index.ts` (bootstrap) → `src/app.ts` (Hono app: `/health`, `auth` middleware on `/v1/*`,
mounts the chat route) → `src/routes/chat.ts` (`POST /v1/chat/completions`):

1. **`route(req)`** (`src/router.ts`) → `{ model, reason }`. Precedence: `openmulti.allow` (hard
   pin to first allowed) > a concrete `provider/model` id passed as `model` (honored as-is) >
   `tier` (from `openmulti.tier`, the `auto:<tier>` alias, or `DEFAULT_TIER`), refined by `purpose`.
2. **`providerFor(model)`** (`src/providers/index.ts`) → the `Provider` carrying the call
   (the multi-provider seam, `docs/MULTI-PROVIDER-SPEC.md`). Default: OpenRouter for everything.
   Per-vendor opt-in via `OPENMULTI_PROVIDER_<VENDOR>` (today: Moonshot, `src/providers/moonshot.ts`;
   requires the vendor's API key, missing key = silent OpenRouter fallback): `direct` = always
   direct; `smart` = **path bandit** (spec step 4) — the same explore/exploit as the tier bandit
   (`selectModel` with a custom aggregator) over per-path decayed stats (`pathAggregate`), so
   direct vs OpenRouter is arbitrated on observed cost/health, a sick direct path falls back and
   can recover. The chosen path is traced in `reason` (`via moonshot`) and the `provider` label on
   all metrics (the tier-level view `modelAggregate` sums across paths).
   Then **`provider.buildBody(req, model)`** → strips the `openmulti` block (provider must never see
   it), sets the resolved model (Moonshot: vendor prefix stripped, `kimi-k2.6`), applies that
   provider's **own steering** (see below) — OpenRouter-isms (`usage.include`, `provider.sort`)
   never leak to a direct provider.
3. **`provider.call(body)`** → POST to the provider with a 30s connect timeout.
4. Pipe back. **Streaming**: on the OpenRouter path SSE is passed through *untouched* (so the
   caller's own usage parsing keeps working); a direct provider may adapt the stream via
   `provider.adaptStream` (Moonshot: injects the synthesized `usage.cost` into the final usage
   chunk — coupling point #1 applies to streams too; everything else passes verbatim). 60s
   inter-chunk watchdog aborts a stalled upstream; route decision is surfaced via `X-OpenMulti-*`
   headers. **Non-stream**: `provider.normalizeResponse` (identity on OpenRouter; Moonshot
   synthesizes `usage.cost` from `src/pricing.ts` — unknown model = no cost + warning +
   `openmulti_pricing_miss_total`, never a fake zero). The `openmulti.reason` block is attached
   **only if the caller sent an `openmulti` extension** — otherwise the response stays
   byte-identical to the upstream, so a plain OpenAI client sees no extra field.

## Two files hold the only knobs that matter

- **`src/catalog.ts`** — the *single* place mapping tier → **candidate models** (`candidatesFor`,
  ordered; the **first is the iso primary**) plus per-task overrides (`purpose: 'agent'` → a code
  model on balanced/quality). Config precedence per slot: plural env `OPENMULTI_MODELS_[PURPOSE_]TIER`
  (full set) > singular `OPENMULTI_MODEL_[PURPOSE_]TIER` (back-compat) > built-in default. Changing
  "which model is economy/balanced/quality" happens here, and *no consuming project changes a line*.
- **`src/select.ts`** — picks one candidate (the v1 "intelligence" seam). `default` returns the
  first candidate (= iso, the contract-locked behavior); `smart` is a deterministic **discounted
  bandit** (no RNG) over the metrics registry: observed stats decay per observation
  (`OPENMULTI_SMART_DECAY_WINDOW`, horizon in requests, default 200), and one rule — "decayed
  sample count < `MIN_SAMPLES` → explore the least-sampled" — covers both cold-start fill and
  continuous re-sampling of losers (~`MIN_SAMPLES/WINDOW` of traffic each, so data stays fresh and
  a degraded model can recover). Exploit = cheapest healthy by decayed cost/req, ties → primary.
  `WINDOW=0` reverts to lifetime stats (explore once, exploit forever — locked by
  `test/select.test.ts`; the bandit by `test/bandit.test.ts`). **Opt-in**: `smart` only runs when a
  caller sends `openmulti.route: 'smart'` or `OPENMULTI_DEFAULT_ROUTE=smart`. With a single
  candidate, `smart` ≡ `default`. The bandit view in `metrics.ts` is separate from the Prometheus
  counters, which stay monotonic.
- **`src/providers/openrouter.ts` → `buildUpstreamBody`** — the steering ported 1:1 from MyMULTI:
  force `usage.include: true` (cost in the final chunk), `provider.sort: 'throughput'`, and a
  `max_tokens` floor of 32000 for the `moonshotai/kimi-k2*` family when unset (Moonshot's 8192
  default truncates long agent generations). These exist for behavioral parity — don't drop them.

## Upstream retry (same model only) + path failover

`routes/chat.ts` wraps the upstream call in a bounded retry loop (`OPENMULTI_MAX_RETRIES`,
default 2) for transient failures: connect errors and `isRetryableStatus` (429/500/502/503/504).
It **retries the same model** — it never switches models, because that would change the answer
(cross-model fallback is out of scope). When the elected access path exhausts its retries on a
transient failure AND the model has an alternate path (`pathsFor`, today: moonshotai/* with a
Moonshot key), the request **fails over to the other path — same model, answer preserved**
(`OPENMULTI_PATH_FALLBACK=0` disables). The abandoned path's failure is recorded (bandit/metering
see the error, a sick path loses its election) and counted in `openmulti_path_fallback_total`;
the trace lands in `reason` (`via openrouter (fallback from moonshot)`). Retries/failovers only
fire *before* any byte reaches the client, so the same loop covers stream and non-stream. Backoff
is exponential (cap 2s) and honors a sane `Retry-After`. 4xx (except 429) is deterministic and
returned as-is — no retry, no failover. Counted in `openmulti_retries_total`.

## The contract is law

`test/contract.test.ts` locks the 5 coupling points MyMULTI depends on (documented in
`docs/ARCHITECTURE.md` §5): `usage.cost` preserved, pure-OpenAI response without the extension,
`openmulti.reason` exposed with it, `auto`+tier resolution / concrete-id honoring, Bearer auth.
You may freely change the catalog, routing, providers — **as long as these tests stay green.** If a
change requires editing the contract test's assertions, that is an interface change to MyMULTI and
must be treated as such (coordinate, don't just make the test pass).

## Auth & deploy

- **Auth** (`src/auth.ts`): Bearer allowlist = env keys (`OPENMULTI_API_KEYS`, comma-separated)
  ∪ the dynamic registry (`src/keys.ts`, Redis-backed, in-memory cache refreshed every 10s and
  immediately after a local admin mutation; both empty = open, dev only). Each consuming project
  gets its own `sk_<project>_…` key. Keys are created/revoked via `POST/DELETE /admin/keys`
  (strict ops token; the secret is returned only at creation, listings are redacted). **Spend
  caps are per PROJECT** (the billing unit): `PUT /admin/caps/:project`, enforced in
  `routes/chat.ts` from memory only (zero I/O on the hot path; local costs accumulate between
  refreshes) → 429 `spend_cap_exceeded` + Retry-After to UTC midnight. Store down = fail-open —
  a Redis outage never cuts traffic. OpenMulti still knows nothing about the caller's tenants.
- **Deploy**: push to `main` → CI (`.github/workflows/ci.yml`) runs typecheck + contract test, builds
  & pushes a multi-stage image to GHCR, then `kubectl set image` rolls it out to the **`openmulti-staging`**
  k3s namespace (dedicated, isolated from `multi-staging`). Manifests in `deploy/staging.yaml`.

## Observability

`src/log.ts` emits one JSON object per line (`log.info/warn/error`) — don't reintroduce
free-text `console.log`. `src/metrics.ts` is an in-process Prometheus registry (resets on
restart) exposed at **`GET /metrics`** (authed — exposes per-project cost/token data). Requests
are recorded in `routes/chat.ts` at completion / upstream error / stream stall. Metrics are
labelled by **project** (`keyLabel`: `sk_<project>_<secret>` → `<project>`, never the raw
secret) × model × provider (access path). This is the monitoring side; it is pure side-channel
and must never alter a proxied response. Activation côté cluster (token ops, scrape Prometheus,
requêtes PromQL) : `docs/OBSERVABILITY-SETUP.md`.

**Durable metering is separate** (`src/meter.ts`, the billing substrate — `docs/PRODUCT-V1.md`):
per key × UTC day × model × path counters in Redis/Valkey (`REDIS_URL`; empty = no-op, so dev and
tests are unchanged). Writes are fire-and-forget — a Redis outage never breaks a call, drops are
counted in `openmulti_meter_dropped_total`. Read via `GET /admin/usage?key=&days=` (strict ops
token, `adminAuth` — no caller-key fallback). Valkey runs in the same namespace
(`deploy/staging.yaml`, applied manually by an admin — the CI only does `set image`).

## Security gates (opt-in)

Hardening from `docs/SECURITY-AUDIT-2026-06-08.md`, all default-off / regression-free:
- **Body size** (`OPENMULTI_MAX_BODY_BYTES`, default 8 MiB) — Content-Length middleware in
  `app.ts` + byte check in the handler → 413.
- **Rate limit** (`OPENMULTI_RATE_LIMIT_PER_MIN`, 0=off) — per-project fixed 60s window
  (`ratelimit.ts`, in-memory, per pod) → 429 + Retry-After.
- **max_tokens ceiling** (`OPENMULTI_MAX_TOKENS_<TIER>`) — clamp in `buildUpstreamBody` after the
  Kimi floor, bounds unit cost.
- **/metrics ops token** (`OPENMULTI_METRICS_TOKEN`) — `metricsAuth` requires it (constant-time)
  when set, else falls back to caller-key auth. Stops cross-tenant metric reads.

- **Constant-time auth** (`auth.ts` `safeEqual`) — caller keys and the metrics token are compared
  in constant time, no short-circuit on the matching key (OM-04).
- **Header sanitization** (`sanitize.ts` `headerSafe`) — `X-OpenMulti-*` response headers strip
  CR/LF + control chars, so a caller-pinned model / echoed purpose can't inject headers (OM-05).

- **Graceful shutdown** (`shutdown.ts` `makeShutdown`, wired in `index.ts`) — SIGTERM/SIGINT drain
  in-flight requests/streams then exit, with a timeout guard (OM-10). `/health` no longer leaks the
  version (OM-08).

Deferred findings (all Low, resolution documented in the audit, to do **before public exposure**):
OM-06 (request-field pass-through → allowlist), OM-07 (upstream error pass-through → normalize).
OM-09 is partially closed (base image pinned by digest in the Dockerfile, bump procedure in a
comment there; cosign signing in CI remains). Nothing is left open without a decision.

## Conventions

ESM throughout (`"type": "module"`); **relative imports must use the `.js` extension** even for `.ts`
sources (`verbatimModuleSyntax` + Bundler resolution). `strict` + `noUncheckedIndexedAccess` are on.
Comments in the codebase are largely in French — match the surrounding language of the file you edit.
