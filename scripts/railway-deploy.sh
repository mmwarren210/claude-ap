#!/usr/bin/env bash
# Deploys a commit (default: origin/claude/crowniq-redesign) to Railway production, waits for it, then checks the live
# server. Railway does not deploy pushes on its own for this service, so Claude sessions run this after every push.
# Auth: the session's proxy adds the Railway project token; elsewhere set RAILWAY_TOKEN.
set -euo pipefail

API=https://backboard.railway.app/graphql/v2
SERVICE_ID=6e3355d4-5663-4ac1-920d-e4b5020756b2
ENVIRONMENT_ID=dd8a8b68-9cdf-4c08-9b53-40a782d3bd47
APP_URL=https://claude-ap-production.up.railway.app

if [[ $# -gt 0 ]]; then
  sha=$(git rev-parse "$1")
else
  git fetch -q origin claude/crowniq-redesign
  sha=$(git rev-parse origin/claude/crowniq-redesign)
fi

railway() {
  local auth=()
  [[ -n "${RAILWAY_TOKEN:-}" ]] && auth=(-H "Project-Access-Token: $RAILWAY_TOKEN")
  curl -sS --fail-with-body "$API" -H 'Content-Type: application/json' "${auth[@]}" -d "$1"
}

id=$(railway "$(jq -nc --arg s "$SERVICE_ID" --arg e "$ENVIRONMENT_ID" --arg c "$sha" \
  '{query: "mutation($s:String!,$e:String!,$c:String){serviceInstanceDeployV2(serviceId:$s,environmentId:$e,commitSha:$c)}",
    variables: {s: $s, e: $e, c: $c}}')" | jq -er '.data.serviceInstanceDeployV2')
echo "Deploying ${sha:0:7} (deployment $id)"

for _ in $(seq 1 80); do
  sleep 15
  status=$(railway "$(jq -nc --arg id "$id" '{query: "query($id:String!){deployment(id:$id){status}}", variables: {id: $id}}')" \
    | jq -r '.data.deployment.status')
  echo "  $status"
  case "$status" in
    SUCCESS) break ;;
    FAILED|CRASHED|REMOVED|SKIPPED) echo "Deployment $id ended $status"; exit 1 ;;
  esac
done
[[ "$status" == SUCCESS ]] || { echo 'Timed out waiting for the deployment'; exit 1; }

curl -sS --fail --retry 5 --retry-delay 5 --retry-all-errors "$APP_URL/health" | jq -e '.status == "ok"'
curl -sS --fail -o /dev/null -w 'Web app: %{http_code}\n' "$APP_URL/"
