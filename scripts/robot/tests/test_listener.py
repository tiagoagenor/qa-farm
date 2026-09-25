import json
import os

import pytest
import robot

import qafarm_listener
from qafarm_listener import QaFarmConfigError, build_caps

ENV = {
    "QAFARM_SERIAL": "emulator-5558",
    "QAFARM_INDEX": "3",
    "QAFARM_APPIUM_URL": "http://127.0.0.1:4803/wd/hub",
    "QAFARM_APP_PACKAGE": "com.exemplo.App.hml",
    "QAFARM_APP_ACTIVITY": "com.exemplo.versao3.MainActivity",
}

PROJECT_CAPS = {
    "automationName": "UIAutomator2",
    "app": "/proj/app/app.apk",
    "platformName": "Android",
    "udid": "emulator-5554",
    "newCommandTimeout": "999999",
    "dontStopAppOnReset": "true",
}


def test_build_caps_forca_celular_e_portas_do_indice():
    # Arrange
    env = dict(ENV)

    # Act
    caps = build_caps(PROJECT_CAPS, env)

    # Assert
    assert (caps["udid"], caps["deviceName"], caps["systemPort"], caps["mjpegServerPort"], caps["chromedriverPort"]) == (
        "emulator-5558",
        "emulator-5558",
        8203,
        9203,
        9603,
    )


def test_build_caps_troca_app_por_pacote_pre_instalado():
    # Arrange
    env = dict(ENV)

    # Act
    caps = build_caps(PROJECT_CAPS, env)

    # Assert
    assert ("app" not in caps, caps["appPackage"], caps["appActivity"], caps["appWaitActivity"]) == (
        True,
        "com.exemplo.App.hml",
        "com.exemplo.versao3.MainActivity",
        "*",
    )


def test_build_caps_mantem_caps_do_projeto_que_nao_sao_substituidas():
    # Arrange
    env = dict(ENV)

    # Act
    caps = build_caps(PROJECT_CAPS, env)

    # Assert
    assert (caps["automationName"], caps["dontStopAppOnReset"], caps["newCommandTimeout"], caps["suppressKillServer"]) == (
        "UIAutomator2",
        "true",
        300,
        True,
    )


def test_build_caps_remove_udid_com_prefixo_appium():
    # Arrange
    project = {"appium:udid": "emulator-5554", "appium:platformVersion": "15"}

    # Act
    caps = build_caps(project, dict(ENV))

    # Assert
    assert ("appium:udid" in caps, "appium:platformVersion" in caps, caps["udid"]) == (False, False, "emulator-5558")


def test_build_caps_sem_serial_recusa_execucao():
    # Arrange
    env = {k: v for k, v in ENV.items() if k != "QAFARM_SERIAL"}

    # Act & Assert
    with pytest.raises(QaFarmConfigError, match="QAFARM_SERIAL"):
        build_caps(PROJECT_CAPS, env)


class _FakeRemote:
    created = []

    def __init__(self, url, options=None, strict_ssl=True, **_):
        self.url = url
        self.caps = options.to_capabilities() if options is not None else {}
        self.session_id = "sess-123"
        _FakeRemote.created.append(self)

    def quit(self):
        pass


SUITE = """*** Settings ***
Library    AppiumLibrary

*** Test Cases ***
Abre App
    Open Application    http://127.0.0.1:4723/wd/hub    automationName=UIAutomator2    app=/proj/app/app.apk
    ...    platformName=Android    udid=emulator-5554    newCommandTimeout=999999    dontStopAppOnReset=true
    Close Application
"""


def _run_suite(tmp_path, monkeypatch, env):
    import AppiumLibrary.keywords._applicationmanagement as am

    _FakeRemote.created.clear()
    monkeypatch.setattr(am.webdriver, "Remote", _FakeRemote)
    for key in ENV:
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    suite = tmp_path / "abre.robot"
    suite.write_text(SUITE, encoding="utf-8")
    out = tmp_path / "out"
    rc = robot.run(
        str(suite),
        listener=qafarm_listener.__file__,
        outputdir=str(out),
        stdout=open(os.devnull, "w"),
        stderr=open(os.devnull, "w"),
    )
    return rc, out


def test_robot_real_envia_sessao_para_o_appium_do_celular(tmp_path, monkeypatch):
    # Arrange
    env = dict(ENV)

    # Act
    rc, _ = _run_suite(tmp_path, monkeypatch, env)

    # Assert
    created = _FakeRemote.created[0]
    assert (rc, created.url, created.caps["appium:udid"], created.caps["appium:systemPort"]) == (
        0,
        "http://127.0.0.1:4803/wd/hub",
        "emulator-5558",
        8203,
    )


def test_robot_real_grava_session_json_na_pasta_de_saida(tmp_path, monkeypatch):
    # Arrange
    env = dict(ENV)

    # Act
    _, out = _run_suite(tmp_path, monkeypatch, env)

    # Assert
    data = json.loads((out / "session.json").read_text(encoding="utf-8"))
    assert (data["serial"], data["sessionId"], data["url"]) == (
        "emulator-5558",
        "sess-123",
        "http://127.0.0.1:4803/wd/hub",
    )


def test_robot_real_sem_serial_falha_o_caso_sem_abrir_sessao(tmp_path, monkeypatch):
    # Arrange
    env = {k: v for k, v in ENV.items() if k != "QAFARM_SERIAL"}

    # Act
    rc, _ = _run_suite(tmp_path, monkeypatch, env)

    # Assert
    assert (rc, _FakeRemote.created) == (1, [])


def test_patch_e_aplicado_uma_unica_vez():
    # Arrange
    qafarm_listener.install_patch()

    # Act
    applied_again = qafarm_listener.install_patch()

    # Assert
    assert applied_again is False


BS_ENV = {
    **ENV,
    "QAFARM_BS_APP": "bs://abc123",
    "QAFARM_BS_DEVICE": "Samsung Galaxy S22",
    "QAFARM_BS_OS": "12.0",
    "QAFARM_BS_USER": "usuario-bs",
    "QAFARM_BS_KEY": "chave-secreta-bs",
    "QAFARM_BS_BUILD": "QA Farm · fila",
    "QAFARM_BS_SESSION": "CT_X",
}


def test_browserstack_monta_caps_da_vaga_com_credenciais_em_bstack_options():
    # Arrange
    env = dict(BS_ENV)

    # Act
    caps = qafarm_listener.build_bs_caps(PROJECT_CAPS, env)

    # Assert
    opts = caps["bstack:options"]
    assert (caps["appium:app"], opts["deviceName"], opts["platformVersion"], opts["userName"], "udid" in caps) == (
        "bs://abc123",
        "Samsung Galaxy S22",
        "12.0",
        "usuario-bs",
        False,
    )


def test_browserstack_session_json_nao_grava_a_chave():
    # Arrange
    caps = qafarm_listener.build_bs_caps(PROJECT_CAPS, dict(BS_ENV))

    # Act
    safe = qafarm_listener.redact(caps)

    # Assert
    assert ("chave-secreta-bs" in json.dumps(safe), caps["bstack:options"]["accessKey"]) == (False, "chave-secreta-bs")
