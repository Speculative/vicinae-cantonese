#!/usr/bin/env bash
# Download the source dictionaries into a data directory (default: ./data).
set -euo pipefail

dir="${1:-data}"
mkdir -p "$dir"
cd "$dir"

curl -fsSLO https://cantonese.org/cccanto-170202.zip
curl -fsSLO https://cantonese.org/cccedict-canto-readings-150923.zip
curl -fsSLO https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz

unzip -oq cccanto-170202.zip
unzip -oq cccedict-canto-readings-150923.zip
gunzip -kf cedict_1_0_ts_utf-8_mdbg.txt.gz
