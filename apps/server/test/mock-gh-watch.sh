#!/bin/bash
# Simulates gh run watch output with ANSI cursor-up redraws.
# Usage: ./test/mock-gh-watch.sh
#
# This outputs 3 refresh cycles similar to what `gh run watch` produces,
# using ESC[<N>A (cursor up) + ESC[J (clear to end) to redraw in-place.

block_lines=9

# --- First render (in_progress) ---
echo "* main Release · 12345"
echo "Triggered via workflow_dispatch"
echo ""
echo "JOBS"
echo "* release (ID 999)"
echo "✓ Set up job"
echo "* Install dependencies"
echo "* Build"
echo "Refreshing run status every 3 seconds. Press Ctrl+C to quit."

sleep 0.3

# --- Second render (more steps complete) ---
printf "\033[${block_lines}A\033[J"
echo "* main Release · 12345"
echo "Triggered via workflow_dispatch"
echo ""
echo "JOBS"
echo "* release (ID 999)"
echo "✓ Set up job"
echo "✓ Install dependencies"
echo "* Build"
echo "Refreshing run status every 3 seconds. Press Ctrl+C to quit."

sleep 0.3

# --- Third render (all complete) ---
printf "\033[${block_lines}A\033[J"
echo "✓ main Release · 12345"
echo "Triggered via workflow_dispatch"
echo ""
echo "JOBS"
echo "✓ release (ID 999)"
echo "✓ Set up job"
echo "✓ Install dependencies"
echo "✓ Build"
echo ""
