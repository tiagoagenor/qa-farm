*** Settings ***
Test Setup       Log    setup

*** Variables ***
${CONTA_PADRAO}    usuario_padrao_var

*** Test Cases ***
CT_LOGIN_01-Login-valido
    [Tags]    regressivo_login_hml
    Dado que ao acessar o aplicativo com usuario_conta_digital_pix
    Entao valido

CT_LOGIN_09-Abrir-conta (ç+$)
    [Tags]    regressivo_login_hml    smoke_login_preprod
    Dado que toco em quero abrir conta

CT_LOGIN_10-Conta-por-variavel
    Dado que acesso com ${CONTA_PADRAO}

*** Keywords ***
Dado que ao acessar o aplicativo com ${conta}
    Log    ${conta}
Entao valido
    No Operation
Dado que toco em quero abrir conta
    No Operation
Dado que acesso com ${x}
    Log    ${x}
