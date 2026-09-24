import json
import os

import robot

import qafarm_massa
from qafarm_massa import classify, entry_from_message

GENERATOR = """
def gerar_cpf():
    return "12345678909"
"""

SUITE = """
*** Settings ***
Library    Collections
Library    dataGenerator.py

*** Variables ***
&{U1}           username=ana@teste.com    password=111111
&{U2}           username=bia@teste.com    password=222222
&{DATA_MASSA}   usuario_ana=&{U1}    usuario_bia=&{U2}

*** Test Cases ***
Caso Com Massa
    Entrar Com    usuario_ana
    Entrar Com    usuario_ana
    ${cpf}=    Gerar Cpf
    ${outro}=    Set Variable    nada

*** Keywords ***
Entrar Com
    [Arguments]    ${user}
    ${usuario_data}=    Get From Dictionary    ${DATA_MASSA}    ${user}
    ${login}=    Get From Dictionary    ${usuario_data}    username
"""


def _run(tmp_path):
    (tmp_path / "dataGenerator.py").write_text(GENERATOR, encoding="utf-8")
    suite = tmp_path / "massa.robot"
    suite.write_text(SUITE, encoding="utf-8")
    out = tmp_path / "out"
    rc = robot.run(
        str(suite),
        listener=qafarm_massa.__file__,
        outputdir=str(out),
        stdout=open(os.devnull, "w"),
        stderr=open(os.devnull, "w"),
    )
    return rc, json.loads((out / "massa.json").read_text(encoding="utf-8"))["entries"]


def test_robot_real_grava_conta_usada_com_usuario_e_senha(tmp_path):
    # Arrange
    expected = {
        "kind": "conta",
        "account": "usuario_ana",
        "var": "${usuario_data}",
        "fields": {"username": "ana@teste.com", "password": "111111"},
    }

    # Act
    rc, entries = _run(tmp_path)

    # Assert
    assert (rc, entries[0]) == (0, expected)


def test_robot_real_grava_dado_gerado_e_ignora_o_resto(tmp_path):
    # Arrange
    generated = {"kind": "gerado", "source": "dataGenerator.Gerar Cpf", "var": "${cpf}", "value": "12345678909"}

    # Act
    _, entries = _run(tmp_path)

    # Assert
    assert entries[1:] == [generated]


def test_conta_lida_duas_vezes_aparece_uma_vez(tmp_path):
    # Arrange
    account = "usuario_ana"

    # Act
    _, entries = _run(tmp_path)

    # Assert
    assert [e.get("account") for e in entries].count(account) == 1


def test_classify_ignora_dicionario_que_nao_e_massa():
    # Arrange
    args = ["${usuario_data}", "username"]

    # Act
    ctx = classify("Collections", "Get From Dictionary", args)

    # Assert
    assert ctx is None


def test_mensagem_que_nao_e_atribuicao_e_ignorada():
    # Arrange
    ctx = {"kind": "gerado", "source": "FakerLibrary.Name"}

    # Act
    entry = entry_from_message(ctx, "Qualquer outra mensagem")

    # Assert
    assert entry is None
