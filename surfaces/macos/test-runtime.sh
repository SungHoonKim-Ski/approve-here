#!/bin/sh
set -eu
cd "$(dirname "$0")"
TASK_TEST_DIR=$(mktemp -d /private/tmp/approve-here-runtime-test.XXXXXX)
trap 'rm -rf "$TASK_TEST_DIR"' EXIT
swiftc Sources/ApproveHere/Runtime.swift Tests/RuntimeSmoke.swift -o "$TASK_TEST_DIR/runtime-test"
APPROVE_HERE_HOME="$TASK_TEST_DIR/inbox" TMPDIR="$TASK_TEST_DIR" "$TASK_TEST_DIR/runtime-test"
