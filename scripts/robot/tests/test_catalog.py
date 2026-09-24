import json
from pathlib import Path

import catalog

FIXTURE = Path(__file__).parent / "fixtures" / "project"


def _entries():
    return {e["id"]: e for e in catalog.build_catalog(FIXTURE, "h1")["entries"]}


def test_lista_todos_os_casos_de_todos_os_arquivos():
    # Arrange
    project = FIXTURE

    # Act
    data = catalog.build_catalog(project, "h1")

    # Assert
    assert (data["total"], data["snapshotHash"]) == (5, "h1")


def test_file_long_name_usa_a_suite_do_proprio_arquivo():
    # Arrange
    entries = _entries()

    # Act
    entry = entries["scenarios/login/login.robot::CT_LOGIN_09-Abrir-conta (ç+$)"]

    # Assert
    assert (entry["fileLongName"], entry["suite"], entry["folder"]) == (
        "Login.CT_LOGIN_09-Abrir-conta (ç+$)",
        "Login",
        "scenarios/login",
    )


def test_extrai_conta_do_texto_do_passo():
    # Arrange
    entries = _entries()

    # Act
    entry = entries["scenarios/login/login.robot::CT_LOGIN_01-Login-valido"]

    # Assert
    assert entry["accounts"] == ["usuario_conta_digital_pix"]


def test_extrai_conta_de_variavel_do_arquivo():
    # Arrange
    entries = _entries()

    # Act
    entry = entries["scenarios/login/login.robot::CT_LOGIN_10-Conta-por-variavel"]

    # Assert
    assert entry["accounts"] == ["usuario_padrao_var"]


def test_extrai_contas_dentro_de_for():
    # Arrange
    data = catalog.build_catalog(FIXTURE, "h1")

    # Act
    pix = [e for e in data["entries"] if e["file"].endswith("pixEnviar.robot")][0]

    # Assert
    assert pix["accounts"] == ["usuario_pix_extra", "usuario_pix_saldo"]


def test_caso_sem_conta_tem_lista_vazia_e_tags():
    # Arrange
    entries = _entries()

    # Act
    entry = entries["scenarios/login/login.robot::CT_LOGIN_09-Abrir-conta (ç+$)"]

    # Assert
    assert (entry["accounts"], entry["tags"]) == ([], ["regressivo_login_hml", "smoke_login_preprod"])


def test_marca_nomes_duplicados_no_mesmo_arquivo():
    # Arrange
    data = catalog.build_catalog(FIXTURE, "h1")

    # Act
    dups = [e["duplicate"] for e in data["entries"] if e["file"].endswith("pixEnviar.robot")]

    # Assert
    assert dups == [True, True]


def test_main_grava_json(tmp_path):
    # Arrange
    out = tmp_path / "c" / "catalog.json"

    # Act
    rc = catalog.main(["catalog.py", str(FIXTURE), str(out), "h2"])

    # Assert
    assert (rc, json.loads(out.read_text(encoding="utf-8"))["total"]) == (0, 5)
