# Static, CGO-free builds of sudoku-server.
#   make build      host OS/arch, ./sudoku-server
#   make dist       linux/amd64 and linux/arm64 into dist/
#   make test-arm64 run the tests as arm64 binaries under qemu-aarch64-static

PLATFORMS ?= linux/amd64 linux/arm64
GOFLAGS_BUILD := -trimpath -ldflags="-s -w"

export CGO_ENABLED := 0

.PHONY: build dist test test-arm64 clean

build:
	go build $(GOFLAGS_BUILD) -o sudoku-server ./cmd/sudoku-server

dist:
	@mkdir -p dist
	@for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; \
		echo "building $$os/$$arch"; \
		GOOS=$$os GOARCH=$$arch go build $(GOFLAGS_BUILD) -o dist/sudoku-server-$$os-$$arch ./cmd/sudoku-server || exit 1; \
	done

test:
	CGO_ENABLED=1 go test -race ./...

test-arm64:
	GOARCH=arm64 go test -exec qemu-aarch64-static ./...

clean:
	rm -rf dist sudoku-server
