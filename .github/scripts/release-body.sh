#!/usr/bin/env bash
# Prints a release's body with its "## Downloads" section rebuilt from the
# assets actually attached, linking each file directly.
#
# Usage: release-body.sh OWNER/REPO TAG < release.json
#
# release.json is the release as returned by the REST API (or
# `gh release view --json body,assets`): `.body` and `.assets[].name/.size`.
# Everything from a "## Downloads" heading to the end of the body is replaced.
# Links are built from TAG, never from the API's asset URLs, which point at
# an `untagged-*` placeholder while the release is a draft.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 OWNER/REPO TAG < release.json" >&2
  exit 2
fi
repo=$1
tag=$2
case $tag in
  "" | untagged-*)
    echo "refusing to build links for tag '$tag'" >&2
    exit 1
    ;;
esac

jq -r --arg base "https://github.com/$repo/releases/download/$tag" '
  def size:
    if . >= 1048576 then "\(. / 1048576 * 10 | round / 10) MiB"
    elif . >= 1024 then "\(. / 1024 * 10 | round / 10) KiB"
    else "\(.) B" end;
  def platform:
    {linux: "Linux", darwin: "macOS", windows: "Windows",
     amd64: "x86-64", arm64: "ARM64"}[.] // .;
  def describe:
    if test("^sudoku-server-[a-z]+-[a-z0-9]+$") then
      (split("-") | "Server for \(.[2] | platform) \(.[3] | platform), static binary (see `deploy/README.md`)")
    elif . == "sudoku-web.zip" then
      "Web client, a static site to serve from any host; this is what is deployed to GitHub Pages when the release is published"
    elif . == "SHA256SUMS" then
      "SHA-256 checksums of the files above"
    else empty end;
  def rank:
    if startswith("sudoku-server-") then 0
    elif . == "SHA256SUMS" then 2
    else 1 end;

  (.body // "" | gsub("\r\n"; "\n") | sub("(^|\n)## Downloads[ \t]*(\n[\\s\\S]*)?$"; "") | sub("\\s+$"; "")) as $changes
  | [ .assets // [] | sort_by((.name | rank), .name)[]
      | "- [`\(.name)`](\($base)/\(.name | @uri)) (\(.size | size))"
        + ((.name | [describe][0]) as $d | if $d then ": \($d)" else "" end)
    ] as $lines
  | if ($lines | length) == 0 then
      "\($changes)\n\n## Downloads\n\nNo files are attached yet.\n"
    else
      "\($changes)\n\n## Downloads\n\n\($lines | join("\n"))\n"
    end
  | ltrimstr("\n\n")
'
