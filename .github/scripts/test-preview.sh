#!/usr/bin/env bash
# Tests for preview-target.sh, preview-url.sh and preview-cleanup.sh.
#
# Usage: test-preview.sh
#
# Needs only bash, jq and coreutils. `gh` and `curl` are replaced by stubs that
# come first on PATH. A stub looks up its answer in the fixture directory by a
# key derived from its arguments: `<key>.out` is printed (with --jq applied for
# `gh`) and `<key>.rc` is the exit status (default 0). Every call is appended to
# a log so tests can assert on what was done. Prints `ok - ...` per case and
# exits non-zero if any case failed.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fx="$work/fx"
log="$work/log"
mkdir -p "$work/bin"

# Stub gh: answers from fixtures and logs the call.
cat > "$work/bin/gh" << 'STUB'
#!/usr/bin/env bash
args="$*"
echo "gh $args" >> "$LOG"
case $args in
  "pr list"*--search*) key=pr_search ;;
  "pr list"*) key=pr_open ;;
  "api repos/"*"/commits/main"*) key=commit_main ;;
  "api repos/"*"/deployments?environment=preview"*) key=gh_deployments ;;
  "api repos/"*"/deployments/"*"/statuses?per_page=1"*)
    id=${args#*deployments/}
    key=status_${id%%/*}
    ;;
  "api -X POST repos/"*"/statuses"*) key=post_status ;;
  "api repos/"*"/issues/"*"/comments"*)
    n=${args#*issues/}
    key=comments_${n%%/*}
    ;;
  "api -X PATCH"*) key=patch ;;
  *) echo "unexpected gh call: $args" >&2; exit 99 ;;
esac
jq_expr=""
prev=""
for a in "$@"; do
  [ "$prev" = "--jq" ] && jq_expr=$a
  prev=$a
done
rc=0
[ -f "$FX/$key.rc" ] && rc=$(cat "$FX/$key.rc")
if [ "$rc" -eq 0 ] && [ -f "$FX/$key.out" ]; then
  if [ -n "$jq_expr" ]; then
    jq -r "$jq_expr" < "$FX/$key.out"
  else
    cat "$FX/$key.out"
  fi
fi
exit "$rc"
STUB

# Stub curl: key is cf_page<N> for deployment listings, cf_delete_<id> for deletes.
cat > "$work/bin/curl" << 'STUB'
#!/usr/bin/env bash
method=GET
prev=""
for a in "$@"; do
  [ "$prev" = "-X" ] && method=$a
  prev=$a
  url=$a
done
echo "curl $method $url" >> "$LOG"
if [ "$method" = DELETE ]; then
  id=${url#*deployments/}
  key=cf_delete_${id%%\?*}
else
  page=${url#*page=}
  key=cf_page${page%%&*}
fi
rc=0
[ -f "$FX/$key.rc" ] && rc=$(cat "$FX/$key.rc")
[ "$rc" -eq 0 ] && [ -f "$FX/$key.out" ] && cat "$FX/$key.out"
exit "$rc"
STUB
chmod +x "$work/bin/gh" "$work/bin/curl"

failures=0

# check DESCRIPTION CONDITION-STATUS
check() {
  if [ "$2" -eq 0 ]; then
    echo "ok - $1"
  else
    echo "not ok - $1"
    failures=$((failures + 1))
  fi
}

# eq DESCRIPTION ACTUAL EXPECTED
eq() {
  if [ "$2" = "$3" ]; then
    echo "ok - $1"
  else
    echo "not ok - $1"
    printf '  expected: %s\n  actual:   %s\n' "$3" "$2"
    failures=$((failures + 1))
  fi
}

# has DESCRIPTION TEXT PATTERN: TEXT contains the fixed string PATTERN
has() {
  case $2 in
    *"$3"*) echo "ok - $1" ;;
    *)
      echo "not ok - $1"
      printf '  missing: %s\n  in: %s\n' "$3" "$2"
      failures=$((failures + 1))
      ;;
  esac
}

# lacks DESCRIPTION TEXT PATTERN
lacks() {
  case $2 in
    *"$3"*)
      echo "not ok - $1"
      printf '  unexpected: %s\n' "$3"
      failures=$((failures + 1))
      ;;
    *) echo "ok - $1" ;;
  esac
}

reset() {
  rm -rf "$fx"
  mkdir -p "$fx"
  : > "$log"
}

# put KEY JSON: set a fixture's output
put() { printf '%s\n' "$2" > "$fx/$1.out"; }
# fail_with KEY: make a stub call exit 1
fail_with() { echo 1 > "$fx/$1.rc"; }

# run SCRIPT [VAR=value...]: sets $out, $err and $rc
run() {
  local script=$1
  shift
  out=$(env PATH="$work/bin:$PATH" LOG="$log" FX="$fx" "$@" "$here/$script" 2> "$work/err")
  rc=$?
  err=$(cat "$work/err")
}

calls() { cat "$log"; }

# ---------------------------------------------------------------- target

target() {
  run preview-target.sh REPO=o/r EVENT=push HEAD_SHA=abc HEAD_BRANCH=main HEAD_REPO=o/r GH_TOKEN=x "$@"
}

pr_json() {
  # pr_json NUMBER SHA CROSS LABELS-JSON
  jq -nc --argjson n "$1" --arg sha "$2" --argjson cross "$3" --argjson labels "$4" \
    '{number: $n, headRefOid: $sha, isCrossRepository: $cross, labels: $labels}'
}

reset
put commit_main '{"sha":"abc"}'
target
eq "target: push to current main deploys" "$out" $'deploy=true\nbranch=main\npr='

reset
put commit_main '{"sha":"def"}'
target
eq "target: push to main that moved on is skipped" "$out" "deploy=false"
has "target: main moved on is explained" "$err" "main has moved on"

reset
target HEAD_BRANCH=feature
eq "target: push to another branch is skipped" "$out" "deploy=false"
has "target: other branch is explained" "$err" "Only pushes to main"
eq "target: other branch makes no gh calls" "$(calls)" ""

reset
target HEAD_REPO=fork/r
eq "target: push to main of another repository is skipped" "$out" "deploy=false"

reset
fail_with commit_main
target
eq "target: failing main lookup fails" "$rc" "1"
has "target: failing main lookup is an error" "$err" "::error::Could not look up"

reset
put pr_search "[$(pr_json 12 abc false '[]')]"
target EVENT=pull_request
eq "target: same-repo PR deploys without a label" "$out" $'deploy=true\nbranch=pr-12\npr=12'
has "target: PR search uses the head sha" "$(calls)" "--search abc"

reset
put pr_search "[$(pr_json 13 abc true '[{"name":"bug"}]')]"
target EVENT=pull_request
eq "target: fork PR without the label is skipped" "$out" "deploy=false"
has "target: fork PR skip mentions the label" "$err" "need the \`preview\` label"

reset
put pr_search "[$(pr_json 13 abc true '[{"name":"bug"},{"name":"preview"}]')]"
target EVENT=pull_request
eq "target: fork PR with the label deploys" "$out" $'deploy=true\nbranch=pr-13\npr=13'

reset
put pr_search "[$(pr_json 14 abc true '[{"name":"deploy-me"}]')]"
target EVENT=pull_request LABEL=deploy-me
eq "target: LABEL overrides the label name" "$out" $'deploy=true\nbranch=pr-14\npr=14'

reset
put pr_search "[]"
target EVENT=pull_request
eq "target: no matching PR is skipped" "$out" "deploy=false"
has "target: no matching PR is explained" "$err" "No open pull request has abc"

reset
put pr_search "[$(pr_json 15 other false '[]')]"
target EVENT=pull_request
eq "target: PR whose head is another commit is skipped" "$out" "deploy=false"

reset
put pr_search "[$(pr_json 16 other false '[]'),$(pr_json 17 abc false '[]'),$(pr_json 18 abc false '[]')]"
target EVENT=pull_request
eq "target: first PR with the matching head wins" "$out" $'deploy=true\nbranch=pr-17\npr=17'

reset
fail_with pr_search
target EVENT=pull_request
eq "target: failing PR search fails" "$rc" "1"
has "target: failing PR search is an error" "$err" "::error::Could not list pull requests"

reset
target EVENT=schedule
eq "target: unknown event is skipped" "$out" "deploy=false"
has "target: unknown event is explained" "$err" "schedule"

# ------------------------------------------------------------------- url

project='{"success":true,"result":{"subdomain":"sudoku-time.pages.dev","production_branch":"main"}}'

url() {
  # url JSON [args...]
  local json=$1
  shift
  out=$(printf '%s' "$json" | "$here/preview-url.sh" "$@" 2> "$work/err")
  rc=$?
  err=$(cat "$work/err")
}

url "$project" main
eq "url: production branch is the bare subdomain" "$out" "https://sudoku-time.pages.dev"
url "$project" pr-7
eq "url: other branches get a subdomain prefix" "$out" "https://pr-7.sudoku-time.pages.dev"
url '{"success":false,"result":null}' pr-7
eq "url: unsuccessful response fails" "$rc" "1"
has "url: unsuccessful response is an error" "$err" "::error::"
url '{"success":true,"result":{"subdomain":"","production_branch":"main"}}' main
eq "url: empty subdomain fails" "$rc" "1"
url '{"success":true,"result":{"production_branch":"main"}}' main
eq "url: missing subdomain fails" "$rc" "1"
url '{"success":true,"result":{"subdomain":"x.pages.dev"}}' main
eq "url: missing production branch is treated as a non-production branch" "$out" "https://main.x.pages.dev"
url "$project"
eq "url: wrong argument count is a usage error" "$rc" "2"

# --------------------------------------------------------------- cleanup

cleanup() {
  run preview-cleanup.sh REPO=o/r PROJECT=proj CLOUDFLARE_API_TOKEN=tok CLOUDFLARE_ACCOUNT_ID=acct GH_TOKEN=x
}

cf_ok() { jq -nc --argjson r "$1" '{success: true, result: $r}'; }
dep() {
  # dep ID BRANCH (empty BRANCH: no metadata)
  if [ -n "$2" ]; then
    jq -nc --arg id "$1" --arg b "$2" '{id: $id, deployment_trigger: {metadata: {branch: $b}}}'
  else
    jq -nc --arg id "$1" '{id: $id, deployment_trigger: {}}'
  fi
}

# A repository with open PR 5 and closed PRs 3, 7 and 8.
base_fixtures() {
  reset
  put pr_open '[{"number":5}]'
  put cf_page1 "$(cf_ok "[$(dep d1 pr-3),$(dep d2 pr-5),$(dep dmain main)]")"
  put cf_page2 "$(cf_ok "[$(dep d4 pr-3),$(dep d5 pr-7),$(dep dnone ''),$(dep dx pr-9x)]")"
  put cf_page3 "$(cf_ok '[]')"
  for d in d1 d4 d5; do put "cf_delete_$d" "$(cf_ok '{}')"; done
  put gh_deployments '[
    {"id":11,"payload":{"pr":3}},
    {"id":12,"payload":{"pr":7}},
    {"id":13,"payload":{"pr":5}},
    {"id":14,"payload":{"pr":null}},
    {"id":15,"payload":{}},
    {"id":16,"payload":{"pr":8}}
  ]'
  put status_11 '[{"state":"inactive"}]'
  put status_12 '[{"state":"success"}]'
  put status_16 '[]'
  put comments_3 '[
    {"id":899,"user":{"login":"github-actions[bot]"},"body":"unrelated"},
    {"id":901,"user":{"login":"someone"},"body":"<!-- sudoku-preview --> quoted"},
    {"id":900,"user":{"login":"github-actions[bot]"},"body":"<!-- sudoku-preview -->\nPreview"}
  ]'
  put comments_7 '[]'
}

base_fixtures
cleanup
c=$(calls)
eq "cleanup: succeeds" "$rc" "0"
has "cleanup: reads page 1" "$c" "page=1&per_page=25"
has "cleanup: reads page 2" "$c" "page=2&per_page=25"
has "cleanup: reads page 3, which is empty" "$c" "page=3&per_page=25"
lacks "cleanup: stops after the empty page" "$c" "page=4"
has "cleanup: deletes a closed PR's deployment (page 1)" "$c" "curl DELETE https://api.cloudflare.com/client/v4/accounts/acct/pages/projects/proj/deployments/d1?force=true"
has "cleanup: deletes a closed PR's deployment (page 2)" "$c" "deployments/d4?force=true"
has "cleanup: deletes another closed PR's deployment" "$c" "deployments/d5?force=true"
lacks "cleanup: keeps the open PR's deployment" "$c" "deployments/d2"
lacks "cleanup: keeps main's deployment" "$c" "deployments/dmain"
lacks "cleanup: keeps a deployment with no branch" "$c" "deployments/dnone"
lacks "cleanup: keeps a branch that only looks like a PR" "$c" "deployments/dx"
has "cleanup: marks an active GitHub deployment inactive" "$c" "gh api -X POST repos/o/r/deployments/12/statuses -f state=inactive"
has "cleanup: marks a GitHub deployment with no status inactive" "$c" "gh api -X POST repos/o/r/deployments/16/statuses -f state=inactive"
lacks "cleanup: leaves an already inactive GitHub deployment" "$c" "deployments/11/statuses -f"
lacks "cleanup: leaves the open PR's GitHub deployment" "$c" "deployments/13"
lacks "cleanup: ignores GitHub deployments without a PR number" "$c" "deployments/14"
lacks "cleanup: ignores GitHub deployments without a payload PR" "$c" "deployments/15"
has "cleanup: replaces the sticky comment" "$c" "gh api -X PATCH repos/o/r/issues/comments/900 -f body=<!-- sudoku-preview -->"
has "cleanup: comment says the preview was removed" "$c" "The preview was removed when this pull request closed."
lacks "cleanup: does not touch other comments" "$c" "comments/899"
lacks "cleanup: does not touch a human's comment" "$c" "comments/901"
lacks "cleanup: does not look for comments on PRs not removed from Cloudflare" "$c" "issues/8/comments"
eq "cleanup: summary" "$out" "Deleted 3 Cloudflare deployment(s), marked 2 GitHub deployment(s) inactive, updated 1 comment(s)"

base_fixtures
put pr_open '[{"number":3},{"number":5},{"number":7},{"number":8}]'
put cf_page1 "$(cf_ok "[$(dep d2 pr-5),$(dep dmain main)]")"
put cf_page2 "$(cf_ok '[]')"
put gh_deployments '[{"id":13,"payload":{"pr":5}}]'
cleanup
c=$(calls)
eq "cleanup: nothing to remove succeeds" "$rc" "0"
lacks "cleanup: nothing to remove deletes nothing" "$c" "DELETE"
lacks "cleanup: nothing to remove posts nothing" "$c" "-X POST"
lacks "cleanup: nothing to remove patches nothing" "$c" "-X PATCH"
eq "cleanup: nothing to remove summary" "$out" "Deleted 0 Cloudflare deployment(s), marked 0 GitHub deployment(s) inactive, updated 0 comment(s)"

base_fixtures
put pr_open "[]"
put cf_page1 "$(cf_ok '[]')"
put gh_deployments ""
cleanup
eq "cleanup: no open PRs and no deployments succeeds" "$rc" "0"

base_fixtures
fail_with pr_open
cleanup
eq "cleanup: failing PR list fails" "$rc" "1"
has "cleanup: failing PR list is an error" "$err" "::error::Could not list open pull requests"
lacks "cleanup: failing PR list deletes nothing" "$(calls)" "DELETE"

base_fixtures
fail_with cf_page2
cleanup
eq "cleanup: failing Cloudflare listing fails" "$rc" "1"
has "cleanup: failing Cloudflare listing is an error" "$err" "::error::Cloudflare API request failed"
lacks "cleanup: failing Cloudflare listing deletes nothing" "$(calls)" "DELETE"

base_fixtures
put cf_page1 '{"success":false,"result":[]}'
cleanup
eq "cleanup: unsuccessful Cloudflare listing fails" "$rc" "1"
has "cleanup: unsuccessful Cloudflare listing is an error" "$err" "::error::Cloudflare API did not report success"

base_fixtures
fail_with cf_delete_d4
cleanup
eq "cleanup: failing delete fails" "$rc" "1"
has "cleanup: failing delete is an error" "$err" "::error::Cloudflare API request failed"

base_fixtures
fail_with gh_deployments
cleanup
eq "cleanup: failing GitHub deployment listing fails" "$rc" "1"
has "cleanup: failing GitHub deployment listing is an error" "$err" "::error::Could not list GitHub deployments"

base_fixtures
fail_with status_12
cleanup
eq "cleanup: failing status read fails" "$rc" "1"
has "cleanup: failing status read is an error" "$err" "::error::Could not read the status of deployment 12"

base_fixtures
fail_with post_status
cleanup
eq "cleanup: failing status update fails" "$rc" "1"
has "cleanup: failing status update is an error" "$err" "::error::Could not mark deployment 12 inactive"

base_fixtures
fail_with comments_3
cleanup
eq "cleanup: failing comment listing fails" "$rc" "1"
has "cleanup: failing comment listing is an error" "$err" "::error::Could not list the comments of #3"

base_fixtures
fail_with patch
cleanup
eq "cleanup: failing comment update fails" "$rc" "1"
has "cleanup: failing comment update is an error" "$err" "::error::Could not update the preview comment on #3"

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
