#!/usr/bin/env bash
# Removes the previews of pull requests that are no longer open.
#
# Usage: preview-cleanup.sh   (configured through the environment)
#
# Environment: REPO, PROJECT (Cloudflare Pages project), CLOUDFLARE_API_TOKEN,
# CLOUDFLARE_ACCOUNT_ID and GH_TOKEN.
#
# 1. Deletes the Cloudflare Pages deployments whose branch is `pr-N` for a
#    pull request N that is not open. Other branches (main) are never touched.
# 2. Marks the matching GitHub deployments inactive.
# 3. Replaces the sticky preview comment on each PR whose deployments were
#    deleted, so it no longer links to a dead site.
set -euo pipefail

marker="<!-- sudoku-preview -->"
api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJECT"

fail() {
  echo "::error::$1" >&2
  exit 1
}

# Calls the Cloudflare API and prints the response, failing unless it reports
# success. Usage: cf [curl args...] URL
cf() {
  local resp
  if ! resp=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"); then
    fail "Cloudflare API request failed: ${*: -1}"
  fi
  if ! jq -e '.success == true' <<< "$resp" > /dev/null; then
    fail "Cloudflare API did not report success: ${*: -1}"
  fi
  echo "$resp"
}

if ! open=$(gh pr list --repo "$REPO" --state open --limit 1000 --json number --jq '.[].number'); then
  fail "Could not list open pull requests"
fi
# Newline separated, wrapped in newlines so `is_open` can match whole lines.
open=$'\n'$open$'\n'
is_open() {
  case $open in
    *$'\n'"$1"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

# Collect first, delete after: deleting while paging would shift the pages.
victims=""
page=1
while true; do
  resp=$(cf "$api/deployments?env=preview&page=$page&per_page=25")
  if [ "$(jq '.result | length' <<< "$resp")" -eq 0 ]; then
    break
  fi
  rows=$(jq -r '.result[] | [.id, (.deployment_trigger.metadata.branch // "")] | @tsv' <<< "$resp")
  while IFS=$'\t' read -r id branch; do
    if [[ $branch =~ ^pr-([0-9]+)$ ]] && ! is_open "${BASH_REMATCH[1]}"; then
      victims+="$id ${BASH_REMATCH[1]}"$'\n'
    fi
  done <<< "$rows"
  page=$((page + 1))
done

removed=""
deleted=0
while read -r id pr; do
  if [ -z "$id" ]; then
    continue
  fi
  # force is needed for deployments that a branch alias points at
  cf -X DELETE "$api/deployments/$id?force=true" > /dev/null
  removed+="$pr"$'\n'
  deleted=$((deleted + 1))
done <<< "$victims"

if ! rows=$(gh api "repos/$REPO/deployments?environment=preview&per_page=100" --paginate \
  --jq '.[] | select((.payload.pr? | type) == "number") | "\(.id) \(.payload.pr)"'); then
  fail "Could not list GitHub deployments"
fi
inactivated=0
while read -r id pr; do
  if [ -z "$id" ] || is_open "$pr"; then
    continue
  fi
  if ! state=$(gh api "repos/$REPO/deployments/$id/statuses?per_page=1" --jq '.[0].state // ""'); then
    fail "Could not read the status of deployment $id"
  fi
  if [ "$state" != "inactive" ]; then
    if ! gh api -X POST "repos/$REPO/deployments/$id/statuses" -f state=inactive > /dev/null; then
      fail "Could not mark deployment $id inactive"
    fi
    inactivated=$((inactivated + 1))
  fi
done <<< "$rows"

commented=0
for pr in $(printf '%s' "$removed" | sort -un); do
  if ! comment=$(gh api "repos/$REPO/issues/$pr/comments?per_page=100" --paginate \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$marker\"))) | .id"); then
    fail "Could not list the comments of #$pr"
  fi
  comment=${comment%%$'\n'*}
  if [ -z "$comment" ]; then
    continue
  fi
  if ! gh api -X PATCH "repos/$REPO/issues/comments/$comment" \
    -f body="$marker"$'\n'"The preview was removed when this pull request closed." > /dev/null; then
    fail "Could not update the preview comment on #$pr"
  fi
  commented=$((commented + 1))
done

echo "Deleted $deleted Cloudflare deployment(s), marked $inactivated GitHub deployment(s) inactive, updated $commented comment(s)"
