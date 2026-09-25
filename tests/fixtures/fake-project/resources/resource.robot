*** Settings ***
Documentation    Recursos comuns do projeto de exemplo (dados fictícios).

*** Variables ***
${USUARIO_BS}       usuario-exemplo
${ACCESS_KEY}       FAKE_BS_KEY_123456
${TIMEOUT}          5s

*** Keywords ***
Abrir App De Exemplo
    Log    ${ACCESS_KEY}
