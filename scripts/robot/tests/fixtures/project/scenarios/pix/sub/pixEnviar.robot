*** Test Cases ***
CT_PIX_01-Enviar
    [Tags]    regressivo_pix_hml
    Dado que ao acessar o aplicativo com usuario_pix_saldo
    FOR    ${i}    IN RANGE    2
        Log    usuario_pix_extra
    END

CT_PIX_01-Enviar
    Log    duplicado

*** Keywords ***
Dado que ao acessar o aplicativo com ${conta}
    Log    ${conta}
