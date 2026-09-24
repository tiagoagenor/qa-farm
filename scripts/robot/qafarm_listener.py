"""QA Farm listener: direciona cada execução do Robot para o celular certo, sem alterar o projeto.

Uso: robot --listener /caminho/absoluto/qafarm_listener.py ...

Ao ser importado, envolve `AppiumLibrary ... open_application` e força, a partir das variáveis de
ambiente do processo, o celular (udid), as portas exclusivas daquele celular e o app pré-instalado.
O Robot Framework 6.1 resolve o método da keyword a cada chamada (getattr), então o patch na classe vale
mesmo que a biblioteca já tenha sido importada.

Variáveis de ambiente:
  QAFARM_SERIAL        obrigatória. ex.: emulator-5556
  QAFARM_INDEX         obrigatória. índice do emulador (1..18)
  QAFARM_APPIUM_URL    obrigatória. ex.: http://127.0.0.1:4802/wd/hub
  QAFARM_APP_PACKAGE   opcional. pacote do app pré-instalado
  QAFARM_APP_ACTIVITY  opcional. activity inicial do app
"""

from __future__ import annotations

import functools
import json
import os
import time
from typing import Any, Mapping

ROBOT_LISTENER_API_VERSION = 3

# capabilities que o projeto envia e que a fazenda sempre substitui
REPLACED_KEYS = (
    "udid",
    "deviceName",
    "platformVersion",
    "app",
    "newCommandTimeout",
    "systemPort",
    "mjpegServerPort",
    "chromedriverPort",
    "appPackage",
    "appActivity",
    "appWaitActivity",
    "suppressKillServer",
)


class QaFarmConfigError(RuntimeError):
    pass


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        raise QaFarmConfigError(
            f"QA Farm: variável {name} ausente — execução recusada para não usar um celular errado"
        )
    return value


def build_caps(project_caps: Mapping[str, Any], env: Mapping[str, str]) -> dict[str, Any]:
    """Capabilities finais: as do projeto, menos as substituídas, mais as do celular da fazenda."""
    serial = _required(env, "QAFARM_SERIAL")
    index = int(_required(env, "QAFARM_INDEX"))
    caps: dict[str, Any] = {}
    for key, value in project_caps.items():
        bare = key.split(":", 1)[1] if key.startswith("appium:") else key
        if bare in REPLACED_KEYS:
            continue
        caps[key] = value
    caps.update(
        {
            "udid": serial,
            "deviceName": serial,
            "systemPort": 8200 + index,
            "mjpegServerPort": 9200 + index,
            "chromedriverPort": 9600 + index,
            "newCommandTimeout": 300,
            "androidInstallTimeout": 600000,
            "uiautomator2ServerInstallTimeout": 120000,
            "adbExecTimeout": 60000,
            "suppressKillServer": True,
        }
    )
    package = env.get("QAFARM_APP_PACKAGE", "").strip()
    activity = env.get("QAFARM_APP_ACTIVITY", "").strip()
    if package and activity:
        caps["appPackage"] = package
        caps["appActivity"] = activity
        caps["appWaitActivity"] = "*"
    elif "app" in project_caps or "appium:app" in project_caps:
        caps["app"] = project_caps.get("app", project_caps.get("appium:app"))
    return caps


def appium_url(env: Mapping[str, str]) -> str:
    return _required(env, "QAFARM_APPIUM_URL")


def _output_dir() -> str | None:
    try:
        from robot.libraries.BuiltIn import BuiltIn

        return BuiltIn().get_variable_value("${OUTPUT DIR}")
    except Exception:  # fora de uma execução do Robot
        return None


def _write_session(url: str, caps: dict[str, Any], session_id: str | None) -> None:
    out = _output_dir()
    if not out:
        return
    data = {
        "serial": caps.get("udid"),
        "url": url,
        "sessionId": session_id,
        "caps": caps,
        "openedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(os.path.join(out, "session.json"), "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)


def install_patch() -> bool:
    """Aplica o patch uma única vez. Retorna True se aplicou agora."""
    from AppiumLibrary.keywords._applicationmanagement import _ApplicationManagementKeywords as K

    original = K.open_application
    if getattr(original, "_qafarm_patched", False):
        return False

    @functools.wraps(original)
    def open_application(self, remote_url, alias=None, **kwargs):  # noqa: ARG001 (remote_url é substituída)
        env = os.environ
        url = appium_url(env)
        caps = build_caps(kwargs, env)
        result = original(self, url, alias, **caps)
        session_id = None
        try:
            session_id = self._cache.current.session_id
        except Exception:
            pass
        _write_session(url, caps, session_id)
        return result

    open_application._qafarm_patched = True  # type: ignore[attr-defined]
    K.open_application = open_application
    return True


install_patch()
