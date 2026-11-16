#!/usr/bin/env bash
# Deletes every asset attached to a draft release.
#
# Usage: clear-draft-assets.sh OWNER/REPO RELEASE_ID
#
# Needs GH_TOKEN for `gh`. Refuses to touch a release that is not a draft, so a
# published release's downloads can never be removed by mistake. Assets are
# deleted by id; each name is printed as it goes. A release with no assets is
# left as it is.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 OWNER/REPO RELEASE_ID" >&2
  exit 2
fi
repo=$1
id=$2

if ! release=$(gh api "repos/$repo/releases/$id"); then
  echo "::error::Could not fetch release $id" >&2
  exit 1
fi
if [ "$(jq -r '.draft' <<< "$release")" != "true" ]; then
  echo "::error::Release $id is not a draft; not touching its assets" >&2
  exit 1
fi

lines=$(jq -r '.assets[] | "\(.id) \(.name)"' <<< "$release")
assets=()
if [ -n "$lines" ]; then
  mapfile -t assets <<< "$lines"
fi
if [ "${#assets[@]}" -eq 0 ]; then
  echo "Release $id has no assets to delete"
  exit 0
fi

for asset in "${assets[@]}"; do
  asset_id=${asset%% *}
  name=${asset#* }
  echo "Deleting $name"
  if ! gh api -X DELETE "repos/$repo/releases/assets/$asset_id" > /dev/null; then
    echo "::error::Could not delete $name (asset $asset_id)" >&2
    exit 1
  fi
done
