# Dimensionamento de Splitters Ópticos

Aplicação web em Python para desenhar e analisar rotas com splitters ópticos desbalanceados.

## Acessar online

**[Abrir o Óptica Planner](https://hallanbr.github.io/dimensionamento-splitters-opticos/)**

A versão hospedada executa o motor Python diretamente no navegador por WebAssembly. Na primeira abertura, aguarde alguns segundos para o ambiente Python ser carregado.

## Primeira versão

- cadastro da origem do sinal;
- montagem visual e sequencial da rota, do DIO às CTOs;
- interface limpa com a identidade visual do sistema de solicitações;
- distâncias e fusões por trecho;
- splitters desbalanceados de 05/95 a 50/50;
- splitters locais de 1x2 a 1x32;
- última caixa apenas com splitter local, sem desbalanceado;
- soma automática da capacidade total dos splitters de clientes;
- cálculo da potência estimada por ponto;
- compartilhamento do cenário completo por link comprimido, sem banco de dados (links antigos continuam abrindo);
- edição direta na linha de cada caixa, inserção de caixas no meio da rota e exclusão com opção de desfazer;
- sinal real do melhor cliente de cada caixa, com diferença para o projetado e diagnóstico de atenuação em trecho e de saídas de desbalanceado invertidas, em passos na ordem da rota;
- relatório de campo pronto para copiar ou enviar pelo WhatsApp, com os passos, os sinais por caixa e os parâmetros usados;
- gráfico da potência projetada e do sinal real ao longo da rota;
- ferramentas de projeto em um menu à parte: otimizador de desbalanceados (só altera a rota quando a sugestão é aplicada) e consulta rápida de atenuação;
- modo noturno;
- instalação como aplicativo no celular, com cache do motor Python para abrir mais rápido e funcionar sem internet;
- recomendações explicadas para pontos críticos, potência de origem e alternativas de splitter (ocultas quando há falha em campo, para não mascarar o defeito);
- motor óptico e recomendações processados em Python;
- JavaScript restrito à interface e à ponte com o motor Python;
- funcionamento sem banco de dados e sem autenticação.

## Executar

Requer apenas Python 3.10 ou superior, sem pacotes externos:

```bash
python server.py
```

O servidor só entrega os arquivos do app; os cálculos rodam no navegador. Depois, abra `http://127.0.0.1:8000` no navegador. O acesso local também precisa de internet na primeira execução para carregar o ambiente Python usado pelo navegador.

## Testes do motor óptico

```bash
python -m unittest discover -s tests -v
```

## Teste do compartilhamento por link

```bash
node tests/test_share_link.js
```

> Os valores ópticos cadastrados são referências iniciais e devem ser validados conforme os fabricantes e materiais homologados pela empresa antes do uso em produção.
