#!/usr/bin/env bash
set -euo pipefail

# Unrelated third-party runner repositories must not block report fonts.
source_list="${REPORT_APT_SOURCE_LIST:-/etc/apt/sources.list.d/ubuntu.sources}"
if [[ ! -s "$source_list" ]]; then
  source_list=/etc/apt/sources.list
fi
if [[ ! -s "$source_list" ]]; then
  printf 'Ubuntu package source list is missing\n' >&2
  exit 1
fi
apt_options=(-o "Dir::Etc::sourcelist=$source_list" -o 'Dir::Etc::sourceparts=-' -o 'Acquire::Retries=3')
installed=false
for attempt in 1 2 3; do
  if sudo apt-get "${apt_options[@]}" update && sudo apt-get "${apt_options[@]}" install --yes fonts-noto-cjk; then
    installed=true
    break
  fi
  if [[ "$attempt" -lt 3 ]]; then sleep 10; fi
done
if [[ "$installed" != true ]]; then
  printf 'Report font installation failed after three attempts\n' >&2
  exit 1
fi
python -m pip install --retries 5 --timeout 30 --requirement requirements-market-report.txt
