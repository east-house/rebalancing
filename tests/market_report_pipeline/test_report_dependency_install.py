import os
from pathlib import Path
import subprocess

import pytest


@pytest.mark.parametrize("failures,success,updates,sleeps", [(0, True, 1, 0), (1, True, 2, 1), (9, False, 3, 2)])
def test_dependency_install_isolated_and_bounded(tmp_path, failures, success, updates, sleeps):
    source = tmp_path / "ubuntu.sources"
    source.write_text("Types: deb\n")
    log = tmp_path / "calls"
    counter = tmp_path / "counter"
    sudo = tmp_path / "sudo"
    sudo.write_text('''#!/bin/bash
echo "sudo $*" >> "$CALL_LOG"
if [[ "$*" == *" update" ]]; then
  n=0
  if [[ -f "$COUNTER" ]]; then read -r n < "$COUNTER"; fi
  n=$((n + 1))
  echo "$n" > "$COUNTER"
  if [[ "$n" -le "$FAILURES" ]]; then exit 100; fi
fi
''')
    sudo.chmod(0o755)
    for command in ["python", "sleep"]:
        path = tmp_path / command
        path.write_text(f'#!/bin/bash\necho "{command} $*" >> "$CALL_LOG"\n')
        path.chmod(0o755)
    env = dict(os.environ, PATH=f"{tmp_path}:{os.environ['PATH']}", REPORT_APT_SOURCE_LIST=str(source),
               CALL_LOG=str(log), COUNTER=str(counter), FAILURES=str(failures))
    script = Path(__file__).resolve().parents[2] / "scripts/install-report-dependencies.sh"
    result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)
    assert (result.returncode == 0) is success
    calls = log.read_text().splitlines()
    assert sum(line.endswith(" update") for line in calls) == updates
    assert sum(line.startswith("sleep ") for line in calls) == sleeps
    assert any(line.startswith("python ") for line in calls) is success
    for line in calls:
        if line.startswith("sudo "):
            assert f"Dir::Etc::sourcelist={source}" in line
            assert "Dir::Etc::sourceparts=-" in line
            assert "Acquire::Retries=3" in line
            assert "allow-unauthenticated" not in line
