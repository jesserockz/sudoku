#!/usr/bin/env bash
# Prints the URL a Cloudflare Pages deployment of a branch is served at.
#
# Usage: preview-url.sh BRANCH < project.json
#
# project.json is the response of the Cloudflare API's
# GET /accounts/{account}/pages/projects/{project}. The production branch is
# served at the project's own subdomain, every other branch at
# https://<branch>.<subdomain>.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 BRANCH < project.json" >&2
  exit 2
fi
branch=$1

project=$(cat)
if ! jq -e '.success == true' <<< "$project" > /dev/null; then
  echo "::error::Cloudflare did not return the Pages project" >&2
  exit 1
fi
subdomain=$(jq -r '.result.subdomain // ""' <<< "$project")
if [ -z "$subdomain" ]; then
  echo "::error::The Pages project has no subdomain" >&2
  exit 1
fi
production=$(jq -r '.result.production_branch // ""' <<< "$project")
if [ "$branch" = "$production" ]; then
  echo "https://$subdomain"
else
  echo "https://$branch.$subdomain"
fi
