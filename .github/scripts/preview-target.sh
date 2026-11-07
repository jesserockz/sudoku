#!/usr/bin/env bash
# Decides what a finished "Web" workflow run should deploy as a preview.
#
# Usage: preview-target.sh   (configured through the environment)
#
# Environment:
#   REPO       owner/name of this repository
#   EVENT      the event that triggered the Web run (push or pull_request)
#   HEAD_SHA   the commit the Web run built
#   HEAD_BRANCH, HEAD_REPO   the run's head branch and head repository
#   LABEL      label a fork PR needs before it is deployed (default: preview)
#   GH_TOKEN   token for `gh`
#
# Prints `deploy=true|false`, and for deploys `branch=` (the Cloudflare Pages
# branch alias, `main` or `pr-N`) and `pr=` (the PR number, empty for main), in
# a form that can be appended to $GITHUB_OUTPUT. Prints a `::notice::` to
# stderr when there is nothing to deploy.
set -euo pipefail

label=${LABEL:-preview}

skip() {
  echo "::notice::$1" >&2
  echo "deploy=false"
  exit 0
}

fail() {
  echo "::error::$1" >&2
  exit 1
}

case $EVENT in
  push)
    if [ "$HEAD_BRANCH" != "main" ] || [ "$HEAD_REPO" != "$REPO" ]; then
      skip "Only pushes to main of $REPO are deployed, not $HEAD_REPO:$HEAD_BRANCH"
    fi
    if ! current=$(gh api "repos/$REPO/commits/main" --jq .sha); then
      fail "Could not look up the current commit of main"
    fi
    if [ "$current" != "$HEAD_SHA" ]; then
      skip "main has moved on from $HEAD_SHA; a newer Web run will deploy"
    fi
    echo "deploy=true"
    echo "branch=main"
    echo "pr="
    ;;
  pull_request)
    if ! prs=$(gh pr list --repo "$REPO" --state open --search "$HEAD_SHA" \
      --json number,headRefOid,isCrossRepository,labels); then
      fail "Could not list pull requests"
    fi
    pr=$(jq -c --arg sha "$HEAD_SHA" 'map(select(.headRefOid == $sha)) | first // empty' <<< "$prs")
    if [ -z "$pr" ]; then
      skip "No open pull request has $HEAD_SHA as its head (it moved on or closed)"
    fi
    cross=$(jq -r '.isCrossRepository' <<< "$pr")
    labelled=$(jq -r --arg l "$label" '[.labels[].name] | index($l) != null' <<< "$pr")
    if [ "$cross" = "true" ] && [ "$labelled" != "true" ]; then
      skip "Fork pull requests need the \`$label\` label; add it, then re-run the PR's Web workflow"
    fi
    number=$(jq -r '.number' <<< "$pr")
    echo "deploy=true"
    echo "branch=pr-$number"
    echo "pr=$number"
    ;;
  *)
    skip "Nothing to deploy for the $EVENT event"
    ;;
esac
