#!/bin/sh
# module-graph-mcp installer — macOS / Linux / WSL
#
#   curl -fsSL https://raw.githubusercontent.com/eren11qq/module-graph-mcp/main/install.sh | sh
#
# Clones (or updates) the repo into ~/.module-graph-mcp, builds it, and puts a
# `module-graph` command on your PATH. No sudo, no npm global writes.
set -eu

REPO_URL="${MODULE_GRAPH_REPO:-https://github.com/eren11qq/module-graph-mcp.git}"
INSTALL_DIR="${MODULE_GRAPH_HOME:-$HOME/.module-graph-mcp}"
BIN_DIR="${MODULE_GRAPH_BIN_DIR:-$HOME/.local/bin}"

say() { printf '[module-graph] %s\n' "$*"; }
die() { printf '[module-graph] error: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required but not found on PATH."
command -v npm >/dev/null 2>&1 || die "npm is required but not found on PATH."
command -v node >/dev/null 2>&1 || die "node >= 20 is required but not found on PATH."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found v$(node -p 'process.versions.node'))."

if [ -d "$INSTALL_DIR/.git" ]; then
  say "updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  say "cloning $REPO_URL -> $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

say "installing dependencies (devDeps included — needed for the build)"
npm install --prefix "$INSTALL_DIR" --no-audit --no-fund

say "building server + dashboard"
npm run build --prefix "$INSTALL_DIR"

mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/dist/server/index.js" "$BIN_DIR/module-graph"
chmod +x "$INSTALL_DIR/dist/server/index.js"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on your PATH — add it:"
     say "  export PATH=\"$BIN_DIR:\$PATH\"   # e.g. append to ~/.bashrc or ~/.zshrc"
     ;;
esac

say "done. try it on the bundled demo app:"
say "  module-graph --root \"$INSTALL_DIR/test-fixtures/sample-app\" --open"
say ""
say "register as an MCP server (absolute paths):"
say "  claude mcp add module-graph -- node $INSTALL_DIR/dist/server/index.js --root /path/to/your-project"
say ""
say "to upgrade later: rerun the same curl one-liner."
say "to uninstall: rm \"$BIN_DIR/module-graph\" && rm -rf \"$INSTALL_DIR\""
