# Dimensionamento de Splitters Ópticos

Aplicação web em Python para estruturar e analisar rotas com splitters ópticos desbalanceados, com futura integração ao sistema de solicitação de materiais.

## Primeira versão

- cadastro da origem do sinal;
- montagem sequencial da rota;
- distâncias e fusões por trecho;
- splitters desbalanceados de 05/95 a 50/50;
- splitters locais de 1x2 a 1x32;
- cálculo da potência estimada por ponto;
- consulta rápida de atenuação;
- resumo inicial de materiais.
- recomendações explicadas para pontos críticos, potência de origem e alternativas de splitter;
- motor óptico, recomendações e materiais processados em Python;
- JavaScript restrito à interação da página com a API;
- funcionamento sem banco de dados e sem autenticação.

## Executar

Requer apenas Python 3.10 ou superior, sem pacotes externos:

```bash
python server.py
```

Depois, abra `http://127.0.0.1:8000` no navegador.

## Testes do motor óptico

```bash
python -m unittest discover -s tests -v
```

> Os valores ópticos cadastrados são referências iniciais e devem ser validados conforme os fabricantes e materiais homologados pela empresa antes do uso em produção.
