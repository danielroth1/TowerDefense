# Deploy an External Project to the k3s Cluster

Use this guide to deploy any containerized project onto the existing k3s server
under a subdomain (e.g. `towerdefense.shopping-now.net`). Each project runs in
its own Kubernetes namespace with automatic TLS via Let's Encrypt.

---

## How to Use This File

1. **Copy** this file into the other project:
   ```
   other-project/.github/instructions/k3s-external-project.instructions.md
   ```
2. **Tell the AI** what you want. The AI reads this file and generates
   deployment artifacts for your project. You do **not** edit placeholders —
   the AI fills them in. Example prompts:
   > "Set up k3s deployment for towerdefense.shopping-now.net"
   > "Generate k3s deploy scripts for this project as SUBDOMAIN.shopping-now.net"

3. **What the AI creates** (and then you run yourself):
   - `k8s/` — Kubernetes manifests (namespace, deployment, service, ingress)
   - `scripts/deploy.sh` — one-command deploy script
   - `.vscode/tasks.json` — VS Code tasks for build, push, deploy, status, logs

4. **One prerequisite per project**: point a DNS A record for the subdomain to
   your k3s server IP (or use a wildcard `*.shopping-now.net` once).

> **Do NOT ask the AI to deploy directly.** The AI generates the scripts and
> manifests. You run `bash scripts/deploy.sh` or use the VS Code tasks.
>
> **Do I need to copy `.env.deploy`?** No — if your project is a sibling of
> `ERPDemo/`, the deploy script automatically sources `../ERPDemo/.env.deploy`.
> If not a sibling, create a minimal `.env.deploy` with these 4 lines:
> ```bash
> K3S_SERVER="<user>@<ip>"
> K3S_SSH_PORT="<port>"
> YOURUSER="<github-username>"
> GHCR_TOKEN="<ghp_yourTokenHere>"
> ```

---

## How It Works

```
Browser ──► k3s Server (port 80/443)
              └── Traefik (built-in, kube-system)
                    │ reads Ingress resources from all namespaces
                    │ terminates TLS (cert-manager)
                    ▼
                  Ingress: host=towerdefense.shopping-now.net
                    └──► towerdefense-service (ClusterIP, namespace: towerdefense)
                           └──► towerdefense Pod  (your app container)
```

- **Traefik v2** is built into k3s — no installation needed
- **Routing** is driven by standard Kubernetes Ingress resources
- **TLS** certificates are auto-provisioned by cert-manager (HTTP01 challenge via Traefik)
- **Images** are built on your Mac, pushed to ghcr.io, and pulled by k3s

---

## Prerequisites

| What | How to check |
|------|-------------|
| k3s server running | `ssh -p ${K3S_SSH_PORT} ${K3S_SERVER} kubectl get nodes` |
| kubectl + kubeconfig | `KUBECONFIG=~/.kube/k3s-erp.yaml kubectl cluster-info` |
| Docker with buildx | `docker buildx ls` |
| Logged into ghcr.io | `docker login ghcr.io` (GitHub PAT with `read:packages` + `write:packages`) |
| cert-manager installed | `KUBECONFIG=~/.kube/k3s-erp.yaml kubectl get clusterissuer letsencrypt-prod` |
| Domain DNS | A record pointing the subdomain to the k3s server IP |

> **cert-manager** was installed once via `infrastructure/cert-manager/install.sh` and
> created the `letsencrypt-prod` ClusterIssuer — it works cluster-wide. Do NOT
> reinstall it per project.

---

## AI Instructions — What to Generate

When asked to "set up k3s deployment" for a project, generate these files.
Derive `PROJECT_NAME` from the subdomain or project folder name. Detect the
Dockerfile and the port the app listens on by reading the project.

### 1. `k8s/namespace.yaml`

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: PROJECT_NAME
```

### 2. `k8s/deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: PROJECT_NAME
  namespace: PROJECT_NAME
  labels:
    app: PROJECT_NAME
spec:
  replicas: 1
  selector:
    matchLabels:
      app: PROJECT_NAME
  template:
    metadata:
      labels:
        app: PROJECT_NAME
    spec:
      imagePullSecrets:
        - name: ghcr-secret
      containers:
        - name: app
          image: ghcr.io/YOURUSER/PROJECT_NAME:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 80          # ← detect from Dockerfile/nginx config
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "256Mi"
              cpu: "500m"
```

> Set `containerPort` to the port the app actually listens on. Detect this
> from `EXPOSE` in the Dockerfile or the framework defaults (React: 80, Node: 3000, Go: 8080).

### 3. `k8s/service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: PROJECT_NAME-service
  namespace: PROJECT_NAME
spec:
  type: ClusterIP
  selector:
    app: PROJECT_NAME
  ports:
    - port: 80
      targetPort: 80           # ← must match containerPort in deployment
```

> If the app runs on a non-80 port (e.g. 3000 for Node), set `targetPort` to
> that port. `port: 80` is the internal service port — it stays 80.

### 4. `k8s/ingress.yaml`

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: PROJECT_NAME-ingress
  namespace: PROJECT_NAME
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: "web,websecure"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - SUBDOMAIN.shopping-now.net
      secretName: PROJECT_NAME-tls-cert
  rules:
    - host: SUBDOMAIN.shopping-now.net
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: PROJECT_NAME-service
                port:
                  number: 80
```

> Do NOT change `ingressClassName`, the annotations, or the TLS section
> structure. Only fill in `PROJECT_NAME` and `SUBDOMAIN`.

### 5. `scripts/deploy.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────
PROJECT="PROJECT_NAME"
SUBDOMAIN="SUBDOMAIN"
REGISTRY="${REGISTRY:-ghcr.io/YOURUSER}"
TAG="${TAG:-latest}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load shared config ────────────────────────────────────────────────────
if [ -f "$REPO_ROOT/../ERPDemo/.env.deploy" ]; then
  source "$REPO_ROOT/../ERPDemo/.env.deploy"
elif [ -f "$REPO_ROOT/.env.deploy" ]; then
  source "$REPO_ROOT/.env.deploy"
else
  echo "WARNING: .env.deploy not found — set YOURUSER, GHCR_TOKEN, K3S_SERVER manually"
fi

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/k3s-erp.yaml}"
export KUBECONFIG

echo "════════════════════════════════════════════════════════════"
echo " $PROJECT Deploy → k3s"
echo " Registry:   $REGISTRY"
echo " Tag:        $TAG"
echo " Namespace:  $PROJECT"
echo " Subdomain:  $SUBDOMAIN.shopping-now.net"
echo "════════════════════════════════════════════════════════════"

# ── Verify cluster connectivity ───────────────────────────────────────────
echo ""
echo "▶ Verifying cluster connection..."
kubectl cluster-info

# ── Build & push ──────────────────────────────────────────────────────────
echo ""
echo "▶ Building & pushing $REGISTRY/$PROJECT:$TAG..."
docker buildx build \
  --platform linux/amd64 \
  --tag "$REGISTRY/$PROJECT:$TAG" \
  --push \
  "$REPO_ROOT"
echo "  ✓ Pushed"

# ── Create namespace & pull secret ────────────────────────────────────────
echo ""
echo "▶ Ensuring namespace '$PROJECT'..."
kubectl create namespace "$PROJECT" --dry-run=client -o yaml | kubectl apply -f -

echo "▶ Creating/updating GHCR pull secret..."
kubectl create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username="$YOURUSER" \
  --docker-password="$GHCR_TOKEN" \
  --namespace="$PROJECT" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  ✓ Pull secret ready"

# ── Apply Kubernetes manifests ────────────────────────────────────────────
echo ""
echo "▶ Applying manifests..."
kubectl apply -f "$REPO_ROOT/k8s/"

# ── Wait for rollout ─────────────────────────────────────────────────────
echo ""
echo "▶ Waiting for deployment..."
kubectl rollout status deployment/"$PROJECT" -n "$PROJECT" --timeout=120s

# ── Show status ───────────────────────────────────────────────────────────
echo ""
echo "▶ Pod status:"
kubectl get pods -n "$PROJECT" -o wide

echo ""
echo "▶ Ingress:"
kubectl get ingress -n "$PROJECT"

echo ""
echo "▶ Services:"
kubectl get services -n "$PROJECT"

INGRESS_IP=$(kubectl get service -n kube-system traefik \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "${K3S_SERVER#*@}")

echo ""
echo "════════════════════════════════════════════════════════════"
echo " ✅  Deployment complete!"
echo ""
echo "  URL: https://${SUBDOMAIN}.shopping-now.net"
echo "  (TLS certificate may take 2-5 minutes on first deploy)"
echo ""
echo "  Check cert: KUBECONFIG=~/.kube/k3s-erp.yaml kubectl get certificate -n $PROJECT"
echo "════════════════════════════════════════════════════════════"
```

> Make the script executable: `chmod +x scripts/deploy.sh`

### 6. `.vscode/tasks.json`

Create or merge these tasks into the project's `.vscode/tasks.json`:

```jsonc
{
  "version": "2.0.0",
  "inputs": [
    {
      "id": "k3sTag",
      "type": "promptString",
      "description": "Image tag",
      "default": "latest"
    }
  ],
  "tasks": [
    {
      // Build & push the Docker image for linux/amd64.
      "label": "k3s: build-push",
      "type": "shell",
      "command": "docker buildx build --platform linux/amd64 --tag ghcr.io/YOURUSER/PROJECT_NAME:${input:k3sTag} --push .",
      "options": { "cwd": "${workspaceFolder}" },
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "dedicated", "group": "k3s" }
    },
    {
      // Deploy: create namespace + pull secret + apply manifests + wait for rollout.
      "label": "k3s: deploy",
      "type": "shell",
      "command": "bash scripts/deploy.sh",
      "options": {
        "cwd": "${workspaceFolder}",
        "env": {
          "TAG": "${input:k3sTag}"
        }
      },
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "dedicated", "group": "k3s" }
    },
    {
      // Build, push, and deploy in one step.
      "label": "k3s: build-push-deploy",
      "dependsOn": ["k3s: build-push", "k3s: deploy"],
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "dedicated", "group": "k3s" }
    },
    {
      // Show pod, ingress, service, and certificate status.
      "label": "k3s: status",
      "type": "shell",
      "command": "KUBECONFIG=~/.kube/k3s-erp.yaml kubectl get pods,ingress,svc,certificate -n PROJECT_NAME -o wide",
      "options": { "cwd": "${workspaceFolder}" },
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "shared", "group": "k3s" }
    },
    {
      // Stream logs from the deployment.
      "label": "k3s: logs",
      "type": "shell",
      "command": "KUBECONFIG=~/.kube/k3s-erp.yaml kubectl logs -n PROJECT_NAME -f deploy/PROJECT_NAME",
      "options": { "cwd": "${workspaceFolder}" },
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "dedicated", "group": "k3s" }
    }
  ]
}
```

> Replace `PROJECT_NAME` and `YOURUSER` in the tasks. If a `.vscode/tasks.json`
> already exists in the project, merge these tasks into it — keep existing
> tasks and inputs intact.

---

## Project Detection (for the AI)

When generating the files above, detect these values from the project:

| Value | How to detect |
|-------|--------------|
| `PROJECT_NAME` | From the subdomain the user specifies, or the repo folder name (lowercase, hyphens) |
| `SUBDOMAIN` | From the user's prompt (e.g. "towerdefense" from "towerdefense.shopping-now.net") |
| `YOURUSER` | From `../ERPDemo/.env.deploy` → `YOURUSER=...` |
| `containerPort` | From `EXPOSE` in the Dockerfile, or framework default (nginx:80, node:3000, go:8080) |
| `targetPort` in service | Same as `containerPort` |

---

## Template Dockerfiles (for the AI)

If the project has no Dockerfile, generate one based on the project type:

### Static site (HTML / JS / built SPA)

```dockerfile
FROM nginx:alpine
COPY dist/ /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### Node.js backend

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

### Go binary

```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /server .

FROM alpine:3.20
COPY --from=build /server /server
EXPOSE 8080
CMD ["/server"]
```

---

## Troubleshooting

### Certificate stuck in `Pending` / `False`

```bash
kubectl describe certificaterequest -n PROJECT_NAME
kubectl logs -n cert-manager deployment/cert-manager --tail=50

# Common causes:
# - DNS A record doesn't point to the k3s server IP
# - Traefik is not reachable on port 80 from the internet
# - Let's Encrypt rate limit (5 certs/domain/week) — use staging first
```

> For testing, temporarily change `letsencrypt-prod` to `letsencrypt-staging`
> in the Ingress annotation. Staging has no rate limits.

### `ImagePullBackOff` or `ErrImagePull`

```bash
kubectl describe pod -n PROJECT_NAME | tail -20
kubectl get secret ghcr-secret -n PROJECT_NAME

# Common causes:
# - ghcr-secret not created in the namespace (run deploy.sh)
# - GHCR_TOKEN doesn't have read:packages scope
# - Image name doesn't match (case-sensitive)
```

### `CrashLoopBackOff`

```bash
kubectl logs -n PROJECT_NAME deployment/PROJECT_NAME

# Common causes:
# - Wrong containerPort in the Deployment
# - App crashes on startup
```

### 404 or "no routes" from Traefik

```bash
kubectl describe ingress PROJECT_NAME-ingress -n PROJECT_NAME
kubectl get endpoints -n PROJECT_NAME

# Common causes:
# - Service selector doesn't match pod labels
# - Service targetPort doesn't match containerPort
# - ingressClassName is not 'traefik'
```

### Cannot connect to cluster

```bash
KUBECONFIG=~/.kube/k3s-erp.yaml kubectl cluster-info
# If stale, re-run from ERPDemo: ./scripts/k3s-setup-server.sh
```

---

## Reference

These files in the ERPDemo repo show the patterns in action:

| File | What it shows |
|------|--------------|
| `infrastructure/k8s/production/ingress.yaml` | Ingress with host-based routing, TLS, cert-manager |
| `infrastructure/cert-manager/install.sh` | cert-manager + ClusterIssuer installation |
| `scripts/k3s-deploy.sh` | GHCR pull secret creation, namespace setup, deploy flow |
| `scripts/k3s-build-push.sh` | buildx cross-compilation for linux/amd64 |
| `scripts/k3s-setup-server.sh` | kubeconfig setup, Traefik verification |
| `.vscode/tasks.json` | VS Code task format (inputs, shell tasks, dependsOn) |
