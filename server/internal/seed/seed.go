// Package seed derives the weekly puzzle seed (docs/API.md "Weekly seed").
package seed

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// ForWeek returns HMAC-SHA256(secret, "sudoku-week:"+isoWeek), truncated to
// the first 8 bytes, as 16 lowercase hex characters. The first 8 bytes read
// big-endian are the 64-bit seed, so the hex of those bytes is its encoding.
func ForWeek(secret []byte, isoWeek string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("sudoku-week:" + isoWeek))
	return hex.EncodeToString(mac.Sum(nil)[:8])
}
