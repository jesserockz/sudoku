#!/usr/bin/env bash
# Tests for clear-draft-assets.sh.
#
# Usage: test-release.sh
#
# Needs only bash, jq and coreutils. `gh` is replaced by a stub that comes
# first on PATH. The stub looks up its answer in the fixture directory by a key
# derived from its arguments: `<key>.out` is printed and `<key>.rc` is the exit
# status (default 0). Every call is appended to a log so tests can assert on
# what was done. Prints `ok - ...` per case and exits non-zero if any case
# failed.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fx="$work/fx"
log="$work/log"
mkdir -p "$work/bin"

cat > "$work/bin/gh" << 'STUB'
#!/usr/bin/env bash
args="$*"
echo "gh $args" >> "$LOG"
case $args in
  "api -X DELETE repos/"*"/releases/assets/"*)
    id=${args##*/}
    key=delete_$id
    ;;
  "api repos/"*"/releases/"*) key=release ;;
  *) echo "unexpected gh call: $args" >&2; exit 99 ;;
esac
rc=0
[ -f "$FX/$key.rc" ] && rc=$(cat "$FX/$key.rc")
[ "$rc" -eq 0 ] && [ -f "$FX/$key.out" ] && cat "$FX/$key.out"
exit "$rc"
STUB
chmod +x "$work/bin/gh"

failures=0

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

put() { printf '%s\n' "$2" > "$fx/$1.out"; }
fail_with() { echo 1 > "$fx/$1.rc"; }

# run [ARGS...]: sets $out, $err and $rc
run() {
  out=$(env PATH="$work/bin:$PATH" LOG="$log" FX="$fx" "$here/clear-draft-assets.sh" "$@" 2> "$work/err")
  rc=$?
  err=$(cat "$work/err")
}

calls() { cat "$log"; }

release_json() {
  # release_json DRAFT ASSETS-JSON
  jq -nc --argjson draft "$1" --argjson assets "$2" '{draft: $draft, tag_name: "v1", assets: $assets}'
}

reset
put release "$(release_json true '[{"id":11,"name":"sudoku-web.zip"},{"id":12,"name":"SHA256SUMS"},{"id":13,"name":"a file with spaces.tar.gz"}]')"
run o/r 99
c=$(calls)
eq "draft with assets: succeeds" "$rc" "0"
has "draft with assets: fetches the release by id" "$c" "gh api repos/o/r/releases/99"
has "draft with assets: deletes the first by id" "$c" "gh api -X DELETE repos/o/r/releases/assets/11"
has "draft with assets: deletes the second by id" "$c" "gh api -X DELETE repos/o/r/releases/assets/12"
has "draft with assets: deletes the third by id" "$c" "gh api -X DELETE repos/o/r/releases/assets/13"
eq "draft with assets: makes exactly one fetch and three deletes" "$(wc -l < "$log")" "4"
eq "draft with assets: prints each name" "$out" $'Deleting sudoku-web.zip\nDeleting SHA256SUMS\nDeleting a file with spaces.tar.gz'

reset
put release "$(release_json true '[]')"
run o/r 99
eq "draft with no assets: succeeds" "$rc" "0"
eq "draft with no assets: says so" "$out" "Release 99 has no assets to delete"
lacks "draft with no assets: deletes nothing" "$(calls)" "DELETE"

reset
put release "$(release_json false '[{"id":11,"name":"sudoku-web.zip"}]')"
run o/r 99
eq "published release: refused" "$rc" "1"
has "published release: is an error" "$err" "::error::Release 99 is not a draft"
lacks "published release: deletes nothing" "$(calls)" "DELETE"

reset
fail_with release
run o/r 99
eq "failing fetch: fails" "$rc" "1"
has "failing fetch: is an error" "$err" "::error::Could not fetch release 99"
lacks "failing fetch: deletes nothing" "$(calls)" "DELETE"

reset
put release "$(release_json true '[{"id":11,"name":"a.zip"},{"id":12,"name":"b.zip"}]')"
fail_with delete_11
run o/r 99
eq "failing delete: fails" "$rc" "1"
has "failing delete: is an error" "$err" "::error::Could not delete a.zip (asset 11)"
lacks "failing delete: stops at the first failure" "$(calls)" "assets/12"

reset
run o/r
eq "missing argument: usage error" "$rc" "2"
has "missing argument: prints usage" "$err" "usage:"
eq "missing argument: makes no gh calls" "$(calls)" ""

reset
run
eq "no arguments: usage error" "$rc" "2"

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
