#!/bin/zsh
# Bazaar Companion: one file that starts everything. Double-click it (the Desktop icon points here).
# Starts the game if it is not open, the local server, the screen reader and the always-on-top panel.
# Everything stays on this Mac. Close this window or press Ctrl+C to stop the companion.
cd "$HOME/github_repositories/bazaar-companion" || { echo "Klasör bulunamadı: ~/github_repositories/bazaar-companion"; read; exit 1; }
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
URL="http://localhost:4747"

# The game (Steam). Skipped if it is already running.
pgrep -f "TheBazaar.app" >/dev/null || open "steam://run/1617400"

# The panel over the game; built on first use. Falls back to the browser if it cannot be built.
[ -x overlay/bazaar-overlay ] || clang -O2 -fobjc-arc -framework Cocoa -framework WebKit overlay/overlay.m -o overlay/bazaar-overlay 2>/dev/null
show_panel() {
  if [ -x overlay/bazaar-overlay ]; then
    pgrep -f "overlay/bazaar-overlay" >/dev/null || overlay/bazaar-overlay "$URL/?overlay=1" &
  else
    ( sleep 1.5; open "$URL" ) &
  fi
}

# Already running: just bring the panel back.
if lsof -nP -iTCP:4747 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Bazaar Companion zaten çalışıyor."
  show_panel; sleep 1; exit 0
fi

[ -f data/cards.json ] || npm run --silent setup
show_panel
trap 'pkill -f "overlay/bazaar-overlay" 2>/dev/null' EXIT INT TERM
# sync: re-imports item data after a game patch. --record: keeps a screenshot of the game every
# ~20 s in data/captures (newest 200) so recognition can be tuned.
node --no-warnings scripts/sync.mjs && node --no-warnings src/server.mjs --record
echo; echo "Kapandı. Pencereyi kapatabilirsin."; read
