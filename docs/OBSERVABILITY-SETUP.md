# Observabilité OpenMulti — runbook d'activation (staging)

> But : activer le token ops `/metrics`, le faire scraper par Prometheus, et exploiter
> les séries. Le service expose déjà `GET /metrics` (format Prometheus) ; il ne reste
> que des étapes **ops** (secret + réseau + scrape). Commandes à lancer côté cluster.

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

## 2. Activer (rollout pour relire le secret)

```bash
kubectl -n openmulti-staging rollout restart deployment/openmulti
kubectl -n openmulti-staging rollout status deployment/openmulti --timeout=120s
```

## 3. Vérifier (depuis un pod déjà autorisé : multi-app)

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

## 4. Scrape Prometheus

### 4a. Autoriser le réseau (adapter au ns/labels de ton Prometheus)

```yaml
# allow-from-prometheus.yaml — kubectl apply -f
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-from-prometheus, namespace: openmulti-staging }
spec:
  podSelector: { matchLabels: { app: openmulti } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: monitoring } }
      ports: [{ port: 8080, protocol: TCP }]
```

### 4b. Job de scrape (Prometheus k8s SD + bearer depuis un secret)

```yaml
# Dans la config Prometheus. Le token va dans un secret monte -> credentials_file.
- job_name: openmulti-staging
  metrics_path: /metrics
  scheme: http
  authorization:
    type: Bearer
    credentials_file: /etc/prometheus/secrets/openmulti/OPENMULTI_METRICS_TOKEN
  kubernetes_sd_configs:
    - role: endpoints
      namespaces: { names: [openmulti-staging] }
  relabel_configs:
    - source_labels: [__meta_kubernetes_service_name]
      regex: openmulti
      action: keep
    - source_labels: [__meta_kubernetes_endpoint_port_name]
      regex: http
      action: keep
```

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
