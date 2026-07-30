# Dimensionamento de Splitters Ópticos

Aplicação web em Python para desenhar e analisar rotas com splitters ópticos desbalanceados, com futura integração ao sistema de solicitação de materiais.

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
- consulta rápida de atenuação;
- resumo inicial de materiais;
- recomendações explicadas para pontos críticos, potência de origem e alternativas de splitter;
- motor óptico, recomendações e materiais processados em Python;
- JavaScript restrito à interface e à ponte com o motor Python;
- funcionamento sem banco de dados e sem autenticação.

## Executar

Requer apenas Python 3.10 ou superior, sem pacotes externos:

```bash
python server.py
```

Depois, abra `http://127.0.0.1:8000` no navegador. O acesso local também precisa de internet na primeira execução para carregar o ambiente Python usado pelo navegador.

## Testes do motor óptico

```bash
python -m unittest discover -s tests -v
```

> Os valores ópticos cadastrados são referências iniciais e devem ser validados conforme os fabricantes e materiais homologados pela empresa antes do uso em produção.
