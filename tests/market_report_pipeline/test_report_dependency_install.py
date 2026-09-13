import os
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.mark.parametrize("failures,success,updates,sleeps", [(0, True, 1, 0), (1, True, 2, 1), (9, False, 3, 2)])
def test_dependency_install_isolated_and_bounded(tmp_path, failures, success, updates, sleeps):
    bash = shutil.which("bash")
    if os.name == "nt":
        # Windows' bash launcher targets WSL; these fixtures use local paths.
        git = shutil.which("git")
        git_bash = Path(git).resolve().parents[1] / "bin/bash.exe" if git else None
        if git_bash is None or not git_bash.is_file():
            pytest.skip("Git Bash is required to test the Ubuntu installer on Windows")
        bash = str(git_bash)
    if not bash:
        pytest.skip("Bash is required to test the Ubuntu installer")
    source = tmp_path / "ubuntu.sources"
    source.write_text("Types: deb\n")
    log = tmp_path / "calls"
    counter = tmp_path / "counter"
    sudo = tmp_path / "sudo"
    sudo.write_bytes(b'''#!/bin/bash
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
        path.write_bytes(f'#!/bin/bash\necho "{command} $*" >> "$CALL_LOG"\n'.encode("utf-8"))
        path.chmod(0o755)
    env = dict(os.environ, FIXTURE_BIN=tmp_path.as_posix(), REPORT_APT_SOURCE_LIST=source.as_posix(),
               CALL_LOG=log.as_posix(), COUNTER=counter.as_posix(), FAILURES=str(failures))
    script = Path(__file__).resolve().parents[2] / "scripts/install-report-dependencies.sh"
    # Match Linux checkout line endings even when Git uses CRLF on Windows.
    executable = tmp_path / script.name
    executable.write_bytes(script.read_text(encoding="utf-8").encode("utf-8"))
    # Explicit functions prevent Windows executable lookup from bypassing stubs.
    runner = '\n'.join(
        f'{command}() {{ "$FIXTURE_BIN/{command}" "$@"; }}'
        for command in ["sudo", "python", "sleep"]
    ) + '\nsource "$1"'
    result = subprocess.run([bash, "-c", runner, "--", executable.as_posix()], env=env,
                            capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode in (0, 1), result.stderr
    assert (result.returncode == 0) is success
    calls = log.read_text().splitlines()
    assert sum(line.endswith(" update") for line in calls) == updates
    assert sum(line.startswith("sleep ") for line in calls) == sleeps
    assert any(line.startswith("python ") for line in calls) is success
    for line in calls:
        if line.startswith("sudo "):
            assert f"Dir::Etc::sourcelist={source.as_posix()}" in line
            assert "Dir::Etc::sourceparts=-" in line
            assert "Acquire::Retries=3" in line
            assert "allow-unauthenticated" not in line
