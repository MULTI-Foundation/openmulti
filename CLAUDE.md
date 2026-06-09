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
2. **`buildUpstreamBody(req, model)`** (`src/providers/openrouter.ts`) → strips the `openmulti`
   block (provider must never see it), sets the resolved model, applies the **iso-comportement
   steering** (see below).
3. **`callUpstream(body)`** → POST to OpenRouter with a 30s connect timeout.
4. Pipe back. **Streaming**: SSE is passed through *untouched* (so the caller's own usage parsing
   keeps working) with a 60s inter-chunk watchdog that aborts a stalled upstream; route decision is
   surfaced via `X-OpenMulti-*` headers. **Non-stream**: the `openmulti.reason` block is attached
   **only if the caller sent an `openmulti` extension** — otherwise the response stays byte-identical
   to the upstream, so a plain OpenAI client sees no extra field.

## Two files hold the only knobs that matter

- **`src/catalog.ts`** — the *single* place mapping tier → **candidate models** (`candidatesFor`,
  ordered; the **first is the iso primary**) plus per-task overrides (`purpose: 'agent'` → a code
  model on balanced/quality). Config precedence per slot: plural env `OPENMULTI_MODELS_[PURPOSE_]TIER`
  (full set) > singular `OPENMULTI_MODEL_[PURPOSE_]TIER` (back-compat) > built-in default. Changing
  "which model is economy/balanced/quality" happens here, and *no consuming project changes a line*.
- **`src/select.ts`** — picks one candidate (the v1 "intelligence" seam). `default` returns the
  first candidate (= iso, the contract-locked behavior); `smart` is a deterministic
  explore-then-exploit over the metrics registry (fill to `MIN_SAMPLES`, then cheapest healthy,
  ties → primary). **Opt-in**: `smart` only runs when a caller sends `openmulti.route: 'smart'` or
  `OPENMULTI_DEFAULT_ROUTE=smart`. With a single candidate, `smart` ≡ `default`. A real bandit
  (exploration/decay) is the next increment — this is the seam for it.
- **`src/providers/openrouter.ts` → `buildUpstreamBody`** — the steering ported 1:1 from MyMULTI:
  force `usage.include: true` (cost in the final chunk), `provider.sort: 'throughput'`, and a
  `max_tokens` floor of 32000 for the `moonshotai/kimi-k2*` family when unset (Moonshot's 8192
  default truncates long agent generations). These exist for behavioral parity — don't drop them.

## Upstream retry (same model only)

`routes/chat.ts` wraps the upstream call in a bounded retry loop (`OPENMULTI_MAX_RETRIES`,
default 2) for transient failures: connect errors and `isRetryableStatus` (429/500/502/503/504).
It **retries the same model** — it never switches models, because that would change the answer
(cross-model fallback is v1 territory). Retries only fire *before* any byte reaches the client,
so the same loop covers stream and non-stream. Backoff is exponential (cap 2s) and honors a sane
`Retry-After`. 4xx (except 429) is deterministic and returned as-is. Counted in
`openmulti_retries_total`.

## The contract is law

`test/contract.test.ts` locks the 5 coupling points MyMULTI depends on (documented in
`docs/ARCHITECTURE.md` §5): `usage.cost` preserved, pure-OpenAI response without the extension,
`openmulti.reason` exposed with it, `auto`+tier resolution / concrete-id honoring, Bearer auth.
You may freely change the catalog, routing, providers — **as long as these tests stay green.** If a
change requires editing the contract test's assertions, that is an interface change to MyMULTI and
must be treated as such (coordinate, don't just make the test pass).

## Auth & deploy

- **Auth** (`src/auth.ts`): v0 is a static Bearer allowlist (`OPENMULTI_API_KEYS`, comma-separated;
  empty = open, dev only). Each consuming project gets its own `sk_` key. OpenMulti knows nothing
  about the caller's tenants — the key is only for future per-key metering.
- **Deploy**: push to `main` → CI (`.github/workflows/ci.yml`) runs typecheck + contract test, builds
  & pushes a multi-stage image to GHCR, then `kubectl set image` rolls it out to the **`openmulti-staging`**
  k3s namespace (dedicated, isolated from `multi-staging`). Manifests in `deploy/staging.yaml`.

## Observability

`src/log.ts` emits one JSON object per line (`log.info/warn/error`) — don't reintroduce
free-text `console.log`. `src/metrics.ts` is an in-process Prometheus registry (resets on
restart) exposed at **`GET /metrics`** (authed — exposes per-project cost/token data). Requests
are recorded in `routes/chat.ts` at completion / upstream error / stream stall. Metrics are
labelled by **project** (`keyLabel`: `sk_<project>_<secret>` → `<project>`, never the raw
secret) × model. This is the substrate for the roadmap's per-key billing and quality monitoring;
it is pure side-channel and must never alter a proxied response. Activation côté cluster (token
ops, scrape Prometheus, requêtes PromQL) : `docs/OBSERVABILITY-SETUP.md`.

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
OM-06 (request-field pass-through → allowlist), OM-07 (upstream error pass-through → normalize),
OM-09 (pin base image by digest + sign). Nothing is left open without a decision.

## Conventions

ESM throughout (`"type": "module"`); **relative imports must use the `.js` extension** even for `.ts`
sources (`verbatimModuleSyntax` + Bundler resolution). `strict` + `noUncheckedIndexedAccess` are on.
Comments in the codebase are largely in French — match the surrounding language of the file you edit.
