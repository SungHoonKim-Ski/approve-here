#!/bin/sh
set -eu
cd "$(dirname "$0")"
TASK_TEST_DIR=$(mktemp -d /private/tmp/approve-here-swift-tests.XXXXXX)
trap 'rm -rf "$TASK_TEST_DIR"' EXIT
swiftc Sources/ApproveHere/Runtime.swift Sources/ApproveHere/Connections.swift Tests/ConnectionsSmoke.swift -o "$TASK_TEST_DIR/settings-test"
APPROVE_HERE_HOME="$TASK_TEST_DIR/inbox" "$TASK_TEST_DIR/settings-test"
