import sys
from pathlib import Path

import pytest

ROBOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROBOT_DIR))


def pytest_configure(config):
    config.addinivalue_line("markers", "server: roda só no server01 (projeto Robot real)")


@pytest.fixture
def robot_dir() -> Path:
    return ROBOT_DIR
