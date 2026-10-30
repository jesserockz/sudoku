package update

import (
	"regexp"
	"strconv"
	"strings"
)

// tagPattern is what a release tag must look like to be installed.
var tagPattern = regexp.MustCompile(`^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)

// ValidTag reports whether tag is a semver release tag, with an optional
// leading "v".
func ValidTag(tag string) bool { return tagPattern.MatchString(tag) }

type semver struct {
	major, minor, patch int
	pre                 []string
}

// parseSemver parses "1.2.3", "v1.2.3" and "1.2.3-rc.1" (build metadata is
// ignored, as precedence ignores it).
func parseSemver(s string) (semver, bool) {
	s = strings.TrimPrefix(s, "v")
	if !tagPattern.MatchString(s) {
		return semver{}, false
	}
	s, _, _ = strings.Cut(s, "+")
	core, pre, hasPre := strings.Cut(s, "-")
	var v semver
	nums := strings.Split(core, ".")
	// The pattern guarantees three numeric parts; an overflowing one is not a
	// usable version.
	var err error
	for i, dst := range []*int{&v.major, &v.minor, &v.patch} {
		if *dst, err = strconv.Atoi(nums[i]); err != nil {
			return semver{}, false
		}
	}
	if hasPre {
		v.pre = strings.Split(pre, ".")
	}
	return v, true
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func isNumeric(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// cmpIdent compares two prerelease identifiers: numeric ones numerically and
// below alphanumeric ones, alphanumeric ones in ASCII order.
func cmpIdent(a, b string) int {
	an, bn := isNumeric(a), isNumeric(b)
	switch {
	case an && bn:
		if c := cmpInt(len(a), len(b)); c != 0 {
			return c
		}
		return strings.Compare(a, b)
	case an:
		return -1
	case bn:
		return 1
	}
	return strings.Compare(a, b)
}

// compare orders two versions by semver 2 precedence.
func (a semver) compare(b semver) int {
	if c := cmpInt(a.major, b.major); c != 0 {
		return c
	}
	if c := cmpInt(a.minor, b.minor); c != 0 {
		return c
	}
	if c := cmpInt(a.patch, b.patch); c != 0 {
		return c
	}
	// A release outranks any of its prereleases.
	switch {
	case len(a.pre) == 0 && len(b.pre) == 0:
		return 0
	case len(a.pre) == 0:
		return 1
	case len(b.pre) == 0:
		return -1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		if c := cmpIdent(a.pre[i], b.pre[i]); c != 0 {
			return c
		}
	}
	return cmpInt(len(a.pre), len(b.pre))
}

// Comparison of a release against the running version.
const (
	Newer   = "newer"
	Same    = "same"
	Older   = "older"
	Unknown = "unknown"
)

// Compare says how version v relates to the running version cur.
func Compare(v, cur string) string {
	a, ok1 := parseSemver(v)
	b, ok2 := parseSemver(cur)
	if !ok1 || !ok2 {
		return Unknown
	}
	switch a.compare(b) {
	case 1:
		return Newer
	case -1:
		return Older
	}
	return Same
}
