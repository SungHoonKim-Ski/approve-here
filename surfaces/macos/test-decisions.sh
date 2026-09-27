#!/bin/sh
set -eu
cd "$(dirname "$0")"
TASK_TEST_DIR=$(mktemp -d /private/tmp/approve-here-decisions-swift.XXXXXX)
trap 'rm -rf "$TASK_TEST_DIR"' EXIT
swiftc Sources/ApproveHere/Runtime.swift Sources/ApproveHere/InboxClient.swift Sources/ApproveHere/RulesPanel.swift Tests/DecisionClientSmoke.swift -o "$TASK_TEST_DIR/decisions-test"
node Tests/decision-client-smoke.mjs "$TASK_TEST_DIR/decisions-test"
