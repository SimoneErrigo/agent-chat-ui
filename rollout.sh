#!/usr/bin/env bash
#
# Usage:
#   ./rollout.sh            # use the moving dev tag
#   ./rollout.sh <sha|tag>  # use an explicit tag, e.g. sha-1a2b3c4 or dev
#   PULL_POLICY=IfNotPresent ./rollout.sh  # reuse a local image intentionally
set -euo pipefail

NS=ctf-ad-agents
OWNER=ghcr.io/simoneerrigo
APP=agent-chat-ui

image_exists() {
  docker manifest inspect "$1" >/dev/null 2>&1
}

# Tag to roll to: explicit arg, or the moving dev tag.
if [[ $# -ge 1 ]]; then
  TAG="$1"
else
  TAG="dev"
fi

PULL_POLICY="${PULL_POLICY:-Always}"

IMAGE="$OWNER/$APP:$TAG"

if ! image_exists "$IMAGE"; then
  echo "!! Image not found or registry not accessible: $IMAGE" >&2
  echo "!! Wait for CI to finish, pass an existing tag, or use 'dev'." >&2
  exit 1
fi

echo ">> Rolling $APP in namespace '$NS' onto tag: $TAG"
echo ">> kubectl set image deploy/$APP -> $IMAGE"
kubectl -n "$NS" set image "deploy/$APP" "$APP=$IMAGE"
kubectl -n "$NS" patch "deploy/$APP" --type=strategic \
  -p "{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"$APP\",\"imagePullPolicy\":\"$PULL_POLICY\"}]}}}}"
kubectl -n "$NS" rollout restart "deploy/$APP"
kubectl -n "$NS" rollout status "deploy/$APP" --timeout=180s

echo ">> Done. $APP is on tag: $TAG"
