#!/bin/zsh
cd -- "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  print "Install Node.js 22.13 or newer from https://nodejs.org/en/download, then reopen this app."
  read "?Press Enter to close."
  exit 1
fi
node server/start.js --open
