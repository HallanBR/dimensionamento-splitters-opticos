(function attachOpticalCalculator(globalScope) {
  "use strict";

  const DEFAULT_SPLITTERS = [
    { code: 1842, ratio: "05/95", localLoss: 13.8, passLoss: 0.7 },
    { code: 1843, ratio: "10/90", localLoss: 10.7, passLoss: 1.0 },
    { code: 1844, ratio: "15/85", localLoss: 8.9, passLoss: 1.2 },
    { code: 1845, ratio: "20/80", localLoss: 7.7, passLoss: 1.7 },
    { code: 1846, ratio: "30/70", localLoss: 5.9, passLoss: 2.3 },
    { code: 1847, ratio: "40/60", localLoss: 4.6, passLoss: 3.1 },
    { code: 1848, ratio: "50/50", localLoss: 3.7, passLoss: 3.7 },
  ];

  const DEFAULT_BALANCED_LOSSES = {
    "Sem splitter": 0,
    "1x2": 4.0,
    "1x4": 7.4,
    "1x8": 10.5,
    "1x16": 13.8,
    "1x32": 17.1,
  };

  function calculateRoute(points, settings, splitters = DEFAULT_SPLITTERS, balancedLosses = DEFAULT_BALANCED_LOSSES) {
    let currentPower = Number(settings.sourcePower);

    return points.map((point, index) => {
      const splitter = splitters.find((item) => item.ratio === point.splitter);
      if (!splitter) throw new Error(`Splitter inválido no ponto ${index + 1}.`);

      const distance = Math.max(0, Number(point.distance) || 0);
      const splices = Math.max(0, Number(point.splices) || 0);
      const segmentLoss = distance * settings.fiberLoss + splices * settings.spliceLoss;
      const input = currentPower - segmentLoss;
      const balancedLoss = balancedLosses[point.balanced];
      if (balancedLoss === undefined) throw new Error(`Splitter local inválido no ponto ${index + 1}.`);

      const local = input - splitter.localLoss - balancedLoss;
      const pass = input - splitter.passLoss;
      const margin = local - settings.minimumPower;
      const effectiveMargin = margin - settings.safetyMargin;
      currentPower = pass;

      return {
        ...point,
        splitterData: splitter,
        segmentLoss,
        input,
        local,
        pass,
        margin,
        effectiveMargin,
      };
    });
  }

  function routeScore(results) {
    if (!results.length) return { minimum: 0, spread: 0 };
    const margins = results.map((item) => item.effectiveMargin);
    return {
      minimum: Math.min(...margins),
      spread: Math.max(...margins) - Math.min(...margins),
    };
  }

  function findBestSingleChange(points, settings, currentResults, splitters = DEFAULT_SPLITTERS) {
    const currentScore = routeScore(currentResults);
    let best = null;

    points.forEach((point, pointIndex) => {
      splitters.forEach((candidate) => {
        if (candidate.ratio === point.splitter) return;
        const scenario = points.map((item, index) => index === pointIndex ? { ...item, splitter: candidate.ratio } : { ...item });
        const results = calculateRoute(scenario, settings, splitters);
        const score = routeScore(results);
        const improvement = score.minimum - currentScore.minimum;
        const localDelta = results[pointIndex].local - currentResults[pointIndex].local;
        const nextDelta = pointIndex < results.length - 1
          ? results[pointIndex + 1].input - currentResults[pointIndex + 1].input
          : results[pointIndex].pass - currentResults[pointIndex].pass;

        if (improvement < 0.5) return;
        if (!best || score.minimum > best.score.minimum || (score.minimum === best.score.minimum && score.spread < best.score.spread)) {
          best = {
            pointIndex,
            from: point.splitter,
            to: candidate.ratio,
            results,
            score,
            improvement,
            localDelta,
            nextDelta,
          };
        }
      });
    });

    return best;
  }

  function buildRecommendations(points, settings, results, splitters = DEFAULT_SPLITTERS) {
    if (!results.length) return [];
    const recommendations = [];
    const score = routeScore(results);
    const criticalIndex = results.findIndex((item) => item.effectiveMargin === score.minimum);
    const critical = results[criticalIndex];

    if (score.minimum < 0) {
      recommendations.push({
        level: "required",
        title: `Revisar o atendimento em ${critical.name}`,
        body: `A margem de segurança está ${Math.abs(score.minimum).toFixed(2)} dB abaixo do configurado. Confira as perdas do trecho, a potência de origem e os componentes locais.`,
      });
    } else if (score.minimum < 2) {
      recommendations.push({
        level: "recommended",
        title: `${critical.name} está próximo da reserva`,
        body: `Restam ${score.minimum.toFixed(2)} dB além da margem de segurança. Pequenas perdas adicionais em campo podem tornar este ponto crítico.`,
      });
    } else {
      recommendations.push({
        level: "informative",
        title: "Estrutura dentro da margem configurada",
        body: `O ponto mais restritivo ainda possui ${score.minimum.toFixed(2)} dB além da margem de segurança.`,
      });
    }

    if (score.minimum >= 5) {
      const suggestedReduction = Math.floor((score.minimum - 3) * 10) / 10;
      if (suggestedReduction >= 0.5) {
        recommendations.push({
          level: "opportunity",
          title: "Avaliar uma potência menor na origem",
          body: `Toda a rota possui folga elevada. Uma redução de até ${suggestedReduction.toFixed(1)} dB manteria aproximadamente 3 dB de reserva adicional no ponto mais crítico. Confirme a disponibilidade e a regra operacional do DIO.`,
        });
      }
    }

    const bestChange = findBestSingleChange(points, settings, results, splitters);
    if (bestChange && (score.minimum < 2 || bestChange.improvement >= 1)) {
      const point = points[bestChange.pointIndex];
      const downstreamText = bestChange.pointIndex < points.length - 1
        ? `A entrada do ponto seguinte varia ${signed(bestChange.nextDelta)} dB.`
        : `A saída passante varia ${signed(bestChange.nextDelta)} dB.`;
      recommendations.push({
        level: "recommended",
        title: `Comparar ${point.splitter} com ${bestChange.to} em ${point.name}`,
        body: `A alternativa melhora a menor margem da rota em ${bestChange.improvement.toFixed(2)} dB e altera o atendimento local em ${signed(bestChange.localDelta)} dB. ${downstreamText}`,
      });
    }

    const longSegment = results.find((item) => item.segmentLoss >= 2);
    if (longSegment) {
      recommendations.push({
        level: "informative",
        title: `Conferir o trecho anterior a ${longSegment.name}`,
        body: `Distância e fusões somam ${longSegment.segmentLoss.toFixed(2)} dB de perda antes do splitter. Vale validar os dados levantados no OZmap.`,
      });
    }

    return recommendations;
  }

  function signed(value) {
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  }

  function calculateQuick(inputPower, ratio, splitters = DEFAULT_SPLITTERS) {
    const splitter = splitters.find((item) => item.ratio === ratio);
    if (!splitter) throw new Error("Splitter inválido.");
    return {
      local: Number(inputPower) - splitter.localLoss,
      pass: Number(inputPower) - splitter.passLoss,
    };
  }

  const api = {
    DEFAULT_SPLITTERS,
    DEFAULT_BALANCED_LOSSES,
    calculateRoute,
    routeScore,
    findBestSingleChange,
    buildRecommendations,
    calculateQuick,
  };

  globalScope.OpticalCalculator = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
