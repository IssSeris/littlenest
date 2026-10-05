#!/usr/bin/env bash
set -euo pipefail

# The upstream downloaded MiniBrowser wrapper replaces LD_LIBRARY_PATH,
# removing the Nix outputs. Launch the unchanged engine binary with the same
# WebKit bundle variables while preserving the resolved host library paths.
case "$*" in
  *--headless*) variant="wpe" ;;
  *) variant="gtk" ;;
esac
bundle="${PASTE_BROWSER_WEBKIT_DIR:?Missing Playwright WebKit directory}/minibrowser-${variant}"
export WEBKIT_EXEC_PATH="${bundle}/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="${bundle}/lib"
export WEBKIT_INSPECTOR_RESOURCES_PATH="${bundle}/share"
export LD_LIBRARY_PATH="${bundle}/lib:${bundle}/sys/lib:${LD_LIBRARY_PATH:?Missing Nix browser libraries}"
export WEBKIT_FORCE_COMPLEX_TEXT="1"
exec "${bundle}/bin/MiniBrowser" "$@"