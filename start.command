#!/bin/zsh
set -e
cd "$(dirname "$0")"

if [[ ! -x ".tools/yt-dlp" ]]; then
  npm run setup
fi

(sleep 1; open "http://127.0.0.1:4173") &
npm start
