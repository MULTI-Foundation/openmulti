# Observabilité OpenMulti — runbook d'activation (staging)

> But : activer le token ops `/metrics`, le faire scraper par Prometheus, et exploiter
> les séries. Le service expose déjà `GET /metrics` (format Prometheus) ; il ne reste
> que des étapes **ops** (secret + réseau + scrape). Commandes à lancer côté cluster.

> **État staging (2026-06-09)** : étapes 1–3 **faites** — `OPENMULTI_METRICS_TOKEN` posé dans
> le secret + référencé dans l'env du déploiement ; `/metrics` rend 401 sans token, 200 avec
> (OM-03 fermé). Reste l'étape 4 (scrape) : **aucun Prometheus déployé** → N/A pour l'instant.

## État de départ

- `/metrics` est protégé par `metricsAuth` : **tant que `OPENMULTI_METRICS_TOKEN` n'est
  pas posé, il retombe sur l'auth par clé appelante** (n'importe quelle clé valide peut
  lire — OM-03). Poser le token coupe cette lecture cross-tenant.
- Le déploiement (`deploy/staging.yaml`) câble déjà `OPENMULTI_METRICS_TOKEN` via
  `secretKeyRef … optional: true` : il suffit d'ajouter la clé au secret + rollout.
- Réseau : le namespace est en `default-deny` ; seul `multi-app` (ns `multi-staging`)
  atteint `:8080`. Un scraper Prometheus doit être **explicitement autorisé** (étape 4).

## 1. Générer + stocker le token ops

```bash
TOKEN=$(openssl rand -hex 32)
kubectl -n openmulti-staging patch secret openmulti-secrets --type merge \
  -p "{\"stringData\":{\"OPENMULTI_METRICS_TOKEN\":\"$TOKEN\"}}"
echo "Token (a donner au scraper, ne pas logger ailleurs): $TOKEN"
```

## 2. Référencer la clé dans l'env du déploiement

> ⚠️ **Indispensable.** La CI ne fait que `kubectl set image` — elle ne ré-applique
> **jamais** `deploy/staging.yaml`. Un ajout d'env dans le manifeste (ici
> `OPENMULTI_METRICS_TOKEN`) n'atteint donc le pod **que** par une action admin manuelle.
> Sans ça, `/metrics` reste en fallback (toute clé appelante le lit) et le token est ignoré.

Patch chirurgical (préserve le sha de l'image et les autres env ; déclenche le rollout) :

```bash
kubectl -n openmulti-staging patch deployment openmulti --type strategic -p '{"spec":{"template":{"spec":{"containers":[{"name":"openmulti","env":[{"name":"OPENMULTI_METRICS_TOKEN","valueFrom":{"secretKeyRef":{"name":"openmulti-secrets","key":"OPENMULTI_METRICS_TOKEN","optional":true}}}]}]}}}}'
kubectl -n openmulti-staging rollout status deployment/openmulti --timeout=120s
```

> Alternative : `kubectl apply -f deploy/staging.yaml` (réconcilie tout le manifeste) **mais**
> il repasse l'image à `:latest` — re-pinner ensuite au sha avec `kubectl set image`.

## 3. Vérifier

Option admin (port-forward, indépendant de la NetworkPolicy et du tooling du pod) :

```bash
TOKEN=$(kubectl -n openmulti-staging get secret openmulti-secrets -o jsonpath='{.data.OPENMULTI_METRICS_TOKEN}' | base64 -d)
kubectl -n openmulti-staging port-forward deploy/openmulti 18080:8080 >/dev/null 2>&1 &
sleep 3
curl -s -o /dev/null -w 'sans token   -> %{http_code}\n' http://127.0.0.1:18080/metrics            # 401
curl -s -o /dev/null -w 'avec token   -> %{http_code}\n' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18080/metrics  # 200
kill %1
```

Option depuis un pod déjà autorisé (multi-app) :

```bash
POD=$(kubectl -n multi-staging get pods -l app=multi-app -o name | head -1)
URL=http://openmulti.openmulti-staging.svc.cluster.local:8080/metrics
# avec le bon token -> 200 + series (curl ou wget selon l'image)
kubectl -n multi-staging exec "$POD" -- sh -c \
  "curl -fsS -H 'Authorization: Bearer $TOKEN' $URL 2>/dev/null | head -20 || \
   wget -qO- --header='Authorization: Bearer $TOKEN' $URL | head -20"
# sans token -> 401 (la lecture cross-tenant est bien coupee)
kubectl -n multi-staging exec "$POD" -- sh -c "curl -s -o /dev/null -w '%{http_code}\n' $URL"
```

## 4. Stack Prometheus + Grafana (légère, déjà déployée)

Une stack mono-pod prête à l'emploi vit dans **`deploy/monitoring.yaml`** (ns `monitoring`) :
Prometheus scrape `/metrics` avec le token ops, Grafana avec datasource + dashboard
« OpenMulti » provisionnés. **Déployée en staging le 2026-06-09** (scrape `up=1` vérifié).

Re-déploiement / reproduction (le bootstrap des secrets est dans l'en-tête du manifeste) :

```bash
TOK=$(kubectl -n openmulti-staging get secret openmulti-secrets -o jsonpath='{.data.OPENMULTI_METRICS_TOKEN}' | base64 -d)
kubectl create ns monitoring
kubectl -n monitoring create secret generic openmulti-scrape --from-literal=token="$TOK"
kubectl -n monitoring create secret generic grafana-admin --from-literal=password="$(openssl rand -hex 16)"
kubectl apply -f deploy/monitoring.yaml
```

> La NetworkPolicy `allow-from-monitoring` (dans le manifeste) autorise le pod Prometheus à
> scraper `openmulti:8080` malgré le `default-deny`.

### Accès

```bash
# Grafana (dashboard "OpenMulti" auto-chargé). Login admin / <secret>.
kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n monitoring port-forward svc/grafana 3000:3000   # -> http://127.0.0.1:3000
# Prometheus (cibles / requêtes brutes)
kubectl -n monitoring port-forward svc/prometheus 9090:9090 # -> http://127.0.0.1:9090
```

> Les séries restent **vides tant qu'openmulti ne reçoit pas de trafic** (il n'est nourri que
> par MyMULTI quand `OPENMULTI_ENABLED=true`). La cible est `up` immédiatement ; les courbes se
> remplissent dès les premiers appels. Données Prometheus **éphémères** (emptyDir, rétention 3j).

> Alternative prometheus-operator : un `ServiceMonitor` (ajouter d'abord un label au
> Service `openmulti` pour le sélecteur, + un `bearerTokenSecret` pointant la clé
> `OPENMULTI_METRICS_TOKEN` du secret `openmulti-secrets`).

## 5. Séries exposées + requêtes utiles

Labels : `key` (= projet, jamais le secret), `model`, et `kind` (prompt|completion) pour les tokens.

| Série | Type |
|---|---|
| `openmulti_requests_total{key,model}` | counter |
| `openmulti_request_errors_total{key,model}` | counter |
| `openmulti_retries_total{key,model}` | counter |
| `openmulti_tokens_total{key,model,kind}` | counter |
| `openmulti_cost_usd_total{key,model}` | counter |
| `openmulti_request_duration_ms_sum` / `_count{key,model}` | counter (moyenne = sum/count) |

PromQL :

```promql
# Coût $/h par projet
sum by (key) (rate(openmulti_cost_usd_total[1h])) * 3600
# Taux d'erreur par modèle
sum by (model) (rate(openmulti_request_errors_total[5m]))
  / sum by (model) (rate(openmulti_requests_total[5m]))
# Latence moyenne (ms) par modèle
sum by (model) (rate(openmulti_request_duration_ms_sum[5m]))
  / sum by (model) (rate(openmulti_request_duration_ms_count[5m]))
# Retries / s par modèle (santé upstream)
sum by (model) (rate(openmulti_retries_total[5m]))
# Tokens / s par projet et type
sum by (key, kind) (rate(openmulti_tokens_total[5m]))
```

> **Caveat** : les métriques sont **in-memory par pod** et repartent de zéro au
> rollout/restart. `rate()` gère la remise à zéro des counters ; pour des totaux absolus
> durables il faudra un store (hors v0). Avec `replicas: 1`, pas d'agrégation multi-pod
> à gérer pour l'instant.

## Hors périmètre de ce runbook

- **Rate-limit / plafonds `max_tokens`** (`OPENMULTI_RATE_LIMIT_PER_MIN`,
  `OPENMULTI_MAX_TOKENS_*`) : laissés **OFF** tant que le profil de trafic MyMULTI n'est
  pas mesuré (justement via les métriques ci-dessus). Les activer ensuite, valeurs dans
  `deploy/staging.yaml` (commentées).
- Ces métriques sont le **socle** du pilote de routing `smart` (A/B coût/qualité) et du
  futur billing par clé.
