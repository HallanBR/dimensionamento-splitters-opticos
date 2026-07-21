# Dimensionamento de Splitters Ópticos

Aplicação web para estruturar e analisar rotas com splitters ópticos desbalanceados, com futura integração ao sistema de solicitação de materiais.

## Primeira versão

- cadastro da origem do sinal;
- montagem sequencial da rota;
- distâncias e fusões por trecho;
- splitters desbalanceados de 05/95 a 50/50;
- splitters locais de 1x2 a 1x32;
- cálculo da potência estimada por ponto;
- consulta rápida de atenuação;
- resumo inicial de materiais;
- recomendações explicadas para pontos críticos, potência de origem e alternativas de splitter;
- funcionamento integral no navegador, sem banco de dados e sem autenticação.

## Executar

Abra o arquivo `index.html` em um navegador moderno. Esta primeira versão não possui dependências externas nem servidor obrigatório.

## Testes do motor óptico

Com Node.js disponível, execute `node --test tests/calculator.test.js`.

> Os valores ópticos cadastrados são referências iniciais e devem ser validados conforme os fabricantes e materiais homologados pela empresa antes do uso em produção.
