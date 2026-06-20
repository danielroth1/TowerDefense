#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────
PROJECT="towerdefense"
SUBDOMAIN="towerdefense"
REGISTRY="${REGISTRY:-ghcr.io/danielroth1}"
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
