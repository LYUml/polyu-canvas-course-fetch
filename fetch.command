#!/bin/bash

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required: https://nodejs.org/"
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund || {
    echo
    read -r -p "Installation failed. Press Enter to close..."
    exit 1
  }
fi

node src/index.js
status=$?

echo
read -r -p "Press Enter to close..."
exit "$status"
