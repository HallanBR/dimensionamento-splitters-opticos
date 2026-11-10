"""Motor de cálculo óptico do projeto.

Este módulo não depende da camada web. Ele pode ser testado, reutilizado por outras
interfaces e futuramente integrado ao sistema de solicitação de materiais.
"""

from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from statistics import median
from typing import Any


@dataclass(frozen=True)
class Splitter:
    code: int
    ratio: str
    local_loss: float
    pass_loss: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "ratio": self.ratio,
            "localLoss": self.local_loss,
            "passLoss": self.pass_loss,
        }


SPLITTERS = (
    Splitter(1842, "05/95", 13.8, 0.7),
    Splitter(1843, "10/90", 10.7, 1.0),
    Splitter(1844, "15/85", 8.9, 1.2),
    Splitter(1845, "20/80", 7.7, 1.7),
    Splitter(1846, "30/70", 5.9, 2.3),
    Splitter(1847, "40/60", 4.6, 3.1),
    Splitter(1848, "50/50", 3.7, 3.7),
)

BALANCED_LOSSES = {
    "Sem splitter": 0.0,
    "1x2": 4.0,
    "1x4": 7.4,
    "1x8": 10.5,
    "1x16": 13.8,
    "1x32": 17.1,
}

BALANCED_CAPACITIES = {
    "Sem splitter": 0,
    "1x2": 2,
    "1x4": 4,
    "1x8": 8,
    "1x16": 16,
    "1x32": 32,
}

DEFAULT_SETTINGS = {
    "sourcePower": 3.0,
    "fiberLoss": 0.35,
    "spliceLoss": 0.10,
    "minimumPower": -27.0,
    "safetyMargin": 3.0,
}


class OpticalInputError(ValueError):
    """Erro de validação que pode ser apresentado diretamente ao usuário."""


def catalog() -> dict[str, Any]:
    return {
        "splitters": [splitter.as_dict() for splitter in SPLITTERS],
        "balancedLosses": BALANCED_LOSSES,
        "defaults": DEFAULT_SETTINGS,
    }


def normalize_settings(raw: dict[str, Any] | None) -> dict[str, float]:
    raw = raw or {}
    settings: dict[str, float] = {}
    for key, default in DEFAULT_SETTINGS.items():
        try:
            settings[key] = float(raw.get(key, default))
        except (TypeError, ValueError) as exc:
            raise OpticalInputError(f"O valor de {key} é inválido.") from exc

    if settings["fiberLoss"] < 0 or settings["spliceLoss"] < 0:
        raise OpticalInputError("As perdas da fibra e das fusões não podem ser negativas.")
    if settings["safetyMargin"] < 0:
        raise OpticalInputError("A margem de segurança não pode ser negativa.")
    return settings


def get_splitter(ratio: str) -> Splitter:
    splitter = next((item for item in SPLITTERS if item.ratio == ratio), None)
    if splitter is None:
        raise OpticalInputError(f"Splitter {ratio!r} não cadastrado.")
    return splitter


def parse_measured(value: Any, name: str) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise OpticalInputError(f"Sinal real do melhor cliente inválido em {name}.") from exc


def calculate_route(
    points: list[dict[str, Any]],
    raw_settings: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    settings = normalize_settings(raw_settings)
    current_power = settings["sourcePower"]
    results: list[dict[str, Any]] = []

    for index, point in enumerate(points):
        name = str(point.get("name") or f"Ponto {index + 1}").strip()
        ratio = str(point.get("splitter") or "")
        balanced = str(point.get("balanced") or "Sem splitter")
        if not ratio and index < len(points) - 1:
            raise OpticalInputError(
                f"Somente a última caixa pode ficar sem splitter desbalanceado. Revise {name}."
            )
        splitter = get_splitter(ratio) if ratio else None
        if balanced not in BALANCED_LOSSES:
            raise OpticalInputError(f"Splitter local inválido em {name}.")

        try:
            distance = max(0.0, float(point.get("distance", 0) or 0))
            splices = max(0, int(float(point.get("splices", 0) or 0)))
        except (TypeError, ValueError) as exc:
            raise OpticalInputError(f"Distância ou fusões inválidas em {name}.") from exc
        measured = parse_measured(point.get("measured"), name)

        segment_loss = distance * settings["fiberLoss"] + splices * settings["spliceLoss"]
        # "extraLoss" simula uma atenuação desconhecida no trecho que chega à caixa
        input_power = current_power - segment_loss - float(point.get("extraLoss", 0) or 0)
        # "inverted" simula as saídas do desbalanceado ligadas trocadas em campo
        inverted = bool(point.get("inverted")) and splitter is not None
        local_loss = (splitter.pass_loss if inverted else splitter.local_loss) if splitter else 0.0
        local_power = input_power - local_loss - BALANCED_LOSSES[balanced]
        if splitter:
            pass_power = input_power - (splitter.local_loss if inverted else splitter.pass_loss)
        else:
            pass_power = None
        margin = local_power - settings["minimumPower"]
        effective_margin = margin - settings["safetyMargin"]

        results.append(
            {
                "name": name,
                "distance": distance,
                "splices": splices,
                "splitter": ratio,
                "balanced": balanced,
                "splitterData": splitter.as_dict() if splitter else None,
                "segmentLoss": segment_loss,
                "input": input_power,
                "local": local_power,
                "pass": pass_power,
                "margin": margin,
                "effectiveMargin": effective_margin,
                "measured": measured,
                "measuredDelta": measured - local_power if measured is not None else None,
            }
        )
        if pass_power is not None:
            current_power = pass_power

    return results


def route_score(results: list[dict[str, Any]]) -> dict[str, float]:
    if not results:
        return {"minimum": 0.0, "spread": 0.0}
    margins = [float(item["effectiveMargin"]) for item in results]
    return {"minimum": min(margins), "spread": max(margins) - min(margins)}


def find_best_single_change(
    points: list[dict[str, Any]],
    settings: dict[str, Any],
    current_results: list[dict[str, Any]],
) -> dict[str, Any] | None:
    current_score = route_score(current_results)
    best: dict[str, Any] | None = None

    for point_index, point in enumerate(points):
        if not point.get("splitter"):
            continue
        for candidate in SPLITTERS:
            if candidate.ratio == point.get("splitter"):
                continue
            scenario = deepcopy(points)
            scenario[point_index]["splitter"] = candidate.ratio
            results = calculate_route(scenario, settings)
            score = route_score(results)
            improvement = score["minimum"] - current_score["minimum"]
            if improvement < 0.5:
                continue

            local_delta = results[point_index]["local"] - current_results[point_index]["local"]
            if point_index < len(results) - 1:
                next_delta = results[point_index + 1]["input"] - current_results[point_index + 1]["input"]
            else:
                next_delta = results[point_index]["pass"] - current_results[point_index]["pass"]

            candidate_change = {
                "pointIndex": point_index,
                "from": point.get("splitter"),
                "to": candidate.ratio,
                "score": score,
                "improvement": improvement,
                "localDelta": local_delta,
                "nextDelta": next_delta,
            }
            if best is None or score["minimum"] > best["score"]["minimum"] or (
                score["minimum"] == best["score"]["minimum"]
                and score["spread"] < best["score"]["spread"]
            ):
                best = candidate_change
    return best


MEASUREMENT_DIVERGENCE = 3.0
HYPOTHESIS_MIN_GAIN = 2.0
HYPOTHESIS_MAX_RESIDUAL = 2.5
ATTENUATION_MIN = 2.0
MAX_HYPOTHESES = 4


def _residuals(points: list[dict[str, Any]], settings: dict[str, Any]) -> list[float | None]:
    return [item["measuredDelta"] for item in calculate_route(points, settings)]


def _error(residuals: list[float | None]) -> float:
    return sum(abs(value) for value in residuals if value is not None)


def _fit_attenuations(scenario: list[dict[str, Any]], settings: dict[str, Any], indexes: list[int]) -> None:
    """Ajusta o valor de cada atenuação suspeita pela mediana dos desvios das caixas seguintes."""
    for _ in range(3):
        for index in indexes:
            scenario[index]["extraLoss"] = 0.0
            downstream = [-value for value in _residuals(scenario, settings)[index:] if value is not None]
            scenario[index]["extraLoss"] = max(0.0, median(downstream))


def diagnose_measurements(
    points: list[dict[str, Any]],
    settings: dict[str, Any],
    results: list[dict[str, Any]],
) -> dict[str, Any]:
    """Compara o sinal real do melhor cliente de cada caixa com o projeto e procura a causa.

    Duas hipóteses de falha são combinadas: atenuação no trecho que chega a uma caixa
    (afeta ela e todas as seguintes) e saídas do desbalanceado ligadas trocadas. A busca
    é gulosa: a cada rodada testa cada hipótese em cada caixa, reajusta o valor das
    atenuações e mantém a que mais aproxima o projeto dos sinais reais. Em empate vence
    a caixa mais próxima da origem, porque o tratamento em campo segue do início ao fim.
    O conjunto só é aceito se explicar os sinais reais com no máximo
    HYPOTHESIS_MAX_RESIDUAL dB, tolerando uma caixa com problema local.
    """
    divergent = [
        index
        for index, item in enumerate(results)
        if item["measuredDelta"] is not None and abs(item["measuredDelta"]) >= MEASUREMENT_DIVERGENCE
    ]
    diagnosis: dict[str, Any] = {
        "divergent": divergent,
        "attenuations": [],
        "inversions": [],
        "localIssues": [],
        "residual": None,
    }
    if not divergent:
        return diagnosis

    measured = [item["measuredDelta"] is not None for item in results]
    scenario = deepcopy(points)
    current_error = _error(_residuals(scenario, settings))
    attenuations: list[int] = []
    inversions: list[int] = []
    for _ in range(MAX_HYPOTHESES):
        best: tuple[float, str, int, list[dict[str, Any]]] | None = None
        for index, point in enumerate(scenario):
            for kind in ("attenuation", "inversion"):
                if kind == "attenuation":
                    # Com um só sinal real depois do trecho não dá para separar atenuação de problema local
                    if index in attenuations or sum(measured[index:]) < 2:
                        continue
                elif index in inversions or not point.get("splitter"):
                    continue
                trial = deepcopy(scenario)
                trial_attenuations = attenuations + [index] if kind == "attenuation" else attenuations
                if kind == "inversion":
                    trial[index]["inverted"] = True
                _fit_attenuations(trial, settings, trial_attenuations)
                if any(trial[item]["extraLoss"] < ATTENUATION_MIN for item in trial_attenuations):
                    continue
                error = _error(_residuals(trial, settings))
                if best is None or error < best[0] - 1e-9:
                    best = (error, kind, index, trial)
        if best is None or best[0] > current_error - HYPOTHESIS_MIN_GAIN:
            break
        current_error, kind, index, scenario = best
        (attenuations if kind == "attenuation" else inversions).append(index)

    if not attenuations and not inversions:
        return diagnosis
    residuals = _residuals(scenario, settings)
    unexplained = [
        index for index, value in enumerate(residuals) if value is not None and abs(value) > HYPOTHESIS_MAX_RESIDUAL
    ]
    if len(unexplained) > 1:
        return diagnosis

    explained = [abs(value) for index, value in enumerate(residuals) if value is not None and index not in unexplained]
    diagnosis["attenuations"] = [
        {"index": index, "loss": scenario[index]["extraLoss"]} for index in sorted(attenuations)
    ]
    diagnosis["inversions"] = sorted(inversions)
    diagnosis["localIssues"] = [
        {"index": index, "delta": residuals[index]}
        for index in unexplained
        if abs(residuals[index]) >= MEASUREMENT_DIVERGENCE
    ]
    diagnosis["residual"] = max(explained, default=0.0)
    diagnosis["scenario"] = scenario
    return diagnosis


def _place(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + f" e {names[-1]}"


def measurement_recommendations(
    points: list[dict[str, Any]],
    settings: dict[str, Any],
    results: list[dict[str, Any]],
    diagnosis: dict[str, Any],
) -> list[dict[str, str]]:
    """Monta os passos de tratamento em campo, sempre na ordem da rota (da origem ao fim)."""
    faults = (
        [("attenuation", item["index"], item) for item in diagnosis["attenuations"]]
        + [("inversion", index, None) for index in diagnosis["inversions"]]
        + [("local", item["index"], item) for item in diagnosis["localIssues"]]
    )
    if faults:
        faults.sort(key=lambda fault: (fault[1], ["attenuation", "inversion", "local"].index(fault[0])))
        scenario = diagnosis["scenario"]
        fitted = calculate_route(scenario, settings)
        recommendations = []
        for step, (kind, index, data) in enumerate(faults, start=1):
            name = results[index]["name"]
            prefix = f"{step}º passo: " if len(faults) > 1 else ""
            if kind == "attenuation":
                previous = results[index - 1]["name"] if index else "a origem"
                downstream = [item["name"] for item in results[index:] if item["measured"] is not None]
                expected = (
                    f"Meça a continuidade de {previous} (esperado {results[index - 1]['pass']:.1f} dBm) "
                    if index
                    else "Meça a saída da origem "
                )
                unmeasured = (
                    f" Como {previous} não tem sinal real, a perda também pode estar antes dela."
                    if index and results[index - 1]["measured"] is None
                    else ""
                )
                recommendations.append(
                    {
                        "level": "required",
                        "title": f"{prefix}Atenuação de cerca de {data['loss']:.1f} dB entre {previous} e {name}",
                        "body": (
                            f"Os sinais reais de {_place(downstream)} estão todos cerca de {data['loss']:.1f} dB "
                            f"abaixo do projeto. A perda está no trecho que chega a {name}: saída de "
                            f"continuidade, cabo ou fusões. {expected}e a entrada de {name} "
                            f"(esperado {results[index]['input']:.1f} dBm; com a falha deve dar perto de "
                            f"{fitted[index]['input']:.1f} dBm).{unmeasured} Trate este trecho antes das "
                            "caixas seguintes, que só herdam a perda."
                        ),
                    }
                )
            elif kind == "inversion":
                item = fitted[index]
                splitter = get_splitter(item["splitter"])
                local_share, pass_share = item["splitter"].split("/")
                body = (
                    "Os sinais reais batem com a porta de clientes ligada na continuidade e vice-versa. "
                    f"Com cerca de {item['input']:.1f} dBm na entrada, ligado certo a porta de "
                    f"{int(local_share)}% (clientes) dá {item['input'] - splitter.local_loss:.1f} dBm e a de "
                    f"{int(pass_share)}% (continuidade) dá {item['input'] - splitter.pass_loss:.1f} dBm; "
                    "invertido, dá o contrário."
                )
                upstream = [att for att in diagnosis["attenuations"] if att["index"] < index]
                if upstream:
                    trial = deepcopy(scenario)
                    trial[index]["inverted"] = False
                    after = calculate_route(trial, settings)[index]
                    if after["effectiveMargin"] < 0:
                        origin = results[upstream[0]["index"]]["name"]
                        body += (
                            f" Só desfaça a inversão depois de corrigir a atenuação antes de {origin}: "
                            f"antes disso os clientes de {name} cairiam para cerca de {after['local']:.1f} dBm."
                        )
                recommendations.append(
                    {
                        "level": "required",
                        "title": f"{prefix}Possível inversão das saídas do {item['splitter']} em {name}",
                        "body": body,
                    }
                )
            else:
                recommendations.append(
                    {
                        "level": "required",
                        "title": f"{prefix}Problema local em {name}",
                        "body": (
                            f"Mesmo considerando as outras falhas, o melhor cliente está {_signed(data['delta'])} dB "
                            "fora do esperado e as caixas seguintes não acompanham. Revise o splitter de "
                            "clientes, os conectores e o drop desta caixa."
                        ),
                    }
                )
        return recommendations
    if diagnosis["divergent"]:
        first = results[diagnosis["divergent"][0]]
        others = [results[index]["name"] for index in diagnosis["divergent"][1:]]
        extra = (
            f" {_place(others)} também {'divergem' if len(others) > 1 else 'diverge'}; trate {first['name']} "
            "primeiro, porque um problema no início da rota se repete nas caixas seguintes."
            if others
            else ""
        )
        return [
            {
                "level": "required",
                "title": f"Sinal real divergente a partir de {first['name']}",
                "body": (
                    f"Melhor cliente com {first['measured']:.2f} dBm, projetado {first['local']:.2f} dBm "
                    f"({_signed(first['measuredDelta'])} dB). Revise conectores, fusões, distância "
                    f"levantada e a ligação dos splitters.{extra}"
                ),
            }
        ]
    return []


def optimize_splitters(points: list[dict[str, Any]], raw_settings: dict[str, Any] | None) -> dict[str, Any]:
    """Escolhe os desbalanceados que maximizam a menor margem da rota.

    Mantém os splitters de clientes e o splitter da última caixa. Para uma margem-alvo,
    percorre a rota escolhendo em cada caixa o desbalanceado com maior continuidade que
    ainda atende o alvo localmente; uma busca binária encontra o maior alvo viável.
    """
    if not isinstance(points, list):
        raise OpticalInputError("A estrutura da rota deve ser uma lista de pontos.")
    settings = normalize_settings(raw_settings)
    current = calculate_route(points, settings)
    if len(points) < 2:
        return {"changed": False, "message": "Adicione ao menos duas caixas para comparar combinações.", "changes": []}

    required = settings["minimumPower"] + settings["safetyMargin"]

    def plan(target: float) -> list[str] | None:
        power = settings["sourcePower"]
        choices: list[str] = []
        for index, item in enumerate(current):
            input_power = power - item["segmentLoss"]
            available = input_power - BALANCED_LOSSES[item["balanced"]] - required
            if index == len(current) - 1:
                local_loss = get_splitter(item["splitter"]).local_loss if item["splitter"] else 0.0
                if available - local_loss < target:
                    return None
                choices.append(item["splitter"])
                continue
            feasible = [splitter for splitter in SPLITTERS if available - splitter.local_loss >= target]
            if not feasible:
                return None
            chosen = min(feasible, key=lambda splitter: splitter.pass_loss)
            choices.append(chosen.ratio)
            power = input_power - chosen.pass_loss
        return choices

    low, high = -80.0, 80.0
    best = plan(low)
    if best is None:
        return {"changed": False, "message": "Não foi possível encontrar uma combinação viável.", "changes": []}
    for _ in range(60):
        middle = (low + high) / 2
        candidate = plan(middle)
        if candidate is None:
            high = middle
        else:
            low, best = middle, candidate

    proposal = deepcopy(points)
    for point, ratio in zip(proposal, best):
        point["splitter"] = ratio
    proposed = calculate_route(proposal, settings)
    current_score, proposed_score = route_score(current), route_score(proposed)
    improvement = proposed_score["minimum"] - current_score["minimum"]
    changes = [
        {"index": index, "name": before["name"], "from": before["splitter"], "to": after["splitter"]}
        for index, (before, after) in enumerate(zip(current, proposed))
        if before["splitter"] != after["splitter"]
    ]
    changed = bool(changes) and improvement >= 0.3
    return {
        "changed": changed,
        "message": (
            f"A nova combinação melhora a menor margem da rota em {improvement:.2f} dB."
            if changed
            else "A combinação atual já distribui bem o sinal. Não há troca que melhore a rota de forma relevante."
        ),
        "changes": changes if changed else [],
        "splitters": best if changed else [item["splitter"] for item in current],
        "currentMinimum": current_score["minimum"],
        "proposedMinimum": proposed_score["minimum"] if changed else current_score["minimum"],
        "points": [
            {"name": before["name"], "before": before["local"], "after": after["local"]}
            for before, after in zip(current, proposed if changed else current)
        ],
    }


def _signed(value: float) -> str:
    return f"{value:+.2f}"


def build_recommendations(
    points: list[dict[str, Any]],
    settings: dict[str, Any],
    results: list[dict[str, Any]],
    field_fault: bool = False,
) -> list[dict[str, str]]:
    """Recomendações do projeto. Com falha em campo, só o que não mascara o defeito."""
    if not results:
        return []

    score = route_score(results)
    critical = min(results, key=lambda item: item["effectiveMargin"])
    recommendations: list[dict[str, str]] = []

    if field_fault and score["minimum"] >= 0:
        recommendations.append(
            {
                "level": "informative",
                "title": "No projeto a rota fecha: a divergência é de campo",
                "body": (
                    f"Pelo cálculo, o ponto mais restritivo teria {score['minimum']:.2f} dB além da margem "
                    "de segurança. Os sinais reais abaixo disso vêm de falha na rede, não do dimensionamento. "
                    "Trate as falhas antes de trocar splitters ou mexer na potência."
                ),
            }
        )
    elif score["minimum"] < 0:
        recommendations.append(
            {
                "level": "required",
                "title": f"Revisar o atendimento em {critical['name']}",
                "body": (
                    f"A margem de segurança está {abs(score['minimum']):.2f} dB abaixo do configurado. "
                    "Confira as perdas do trecho, a potência de origem e os componentes locais."
                ),
            }
        )
    elif score["minimum"] < 2:
        recommendations.append(
            {
                "level": "recommended",
                "title": f"{critical['name']} está próximo da reserva",
                "body": (
                    f"Restam {score['minimum']:.2f} dB além da margem de segurança. "
                    "Pequenas perdas adicionais em campo podem tornar este ponto crítico."
                ),
            }
        )
    else:
        recommendations.append(
            {
                "level": "informative",
                "title": "Estrutura dentro da margem configurada",
                "body": f"O ponto mais restritivo ainda possui {score['minimum']:.2f} dB além da margem de segurança.",
            }
        )

    # Com falha em campo, reduzir potência ou trocar splitter só mascararia o defeito
    if field_fault:
        return recommendations

    if score["minimum"] >= 5:
        suggested_reduction = int((score["minimum"] - 3) * 10) / 10
        if suggested_reduction >= 0.5:
            recommendations.append(
                {
                    "level": "opportunity",
                    "title": "Avaliar uma potência menor na origem",
                    "body": (
                        f"Toda a rota possui folga elevada. Uma redução de até {suggested_reduction:.1f} dB "
                        "manteria aproximadamente 3 dB de reserva adicional no ponto mais crítico. "
                        "Confirme a disponibilidade e a regra operacional do DIO."
                    ),
                }
            )

    best_change = find_best_single_change(points, settings, results)
    if best_change and (score["minimum"] < 2 or best_change["improvement"] >= 1):
        point = points[best_change["pointIndex"]]
        downstream = (
            f"A entrada do ponto seguinte varia {_signed(best_change['nextDelta'])} dB."
            if best_change["pointIndex"] < len(points) - 1
            else f"A saída passante varia {_signed(best_change['nextDelta'])} dB."
        )
        recommendations.append(
            {
                "level": "recommended",
                "title": f"Comparar {point['splitter']} com {best_change['to']} em {point['name']}",
                "body": (
                    f"A alternativa melhora a menor margem da rota em {best_change['improvement']:.2f} dB "
                    f"e altera o atendimento local em {_signed(best_change['localDelta'])} dB. {downstream}"
                ),
            }
        )

    long_segment = next((item for item in results if item["segmentLoss"] >= 2), None)
    if long_segment:
        recommendations.append(
            {
                "level": "informative",
                "title": f"Conferir o trecho anterior a {long_segment['name']}",
                "body": (
                    f"Distância e fusões somam {long_segment['segmentLoss']:.2f} dB de perda antes do ponto. "
                    "Vale validar os dados levantados no OZmap."
                ),
            }
        )
    return recommendations


def analyze_route(points: list[dict[str, Any]], raw_settings: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(points, list):
        raise OpticalInputError("A estrutura da rota deve ser uma lista de pontos.")
    settings = normalize_settings(raw_settings)
    results = calculate_route(points, settings)
    total_clients = sum(
        BALANCED_CAPACITIES.get(str(point.get("balanced") or "Sem splitter"), 0)
        for point in points
    )

    if results:
        critical = min(results, key=lambda item: item["margin"])
        has_critical = any(item["effectiveMargin"] < 0 for item in results)
        has_warning = any(0 <= item["effectiveMargin"] < 2 for item in results)
        status = "Revisão necessária" if has_critical else "Dentro do limite" if has_warning else "Rota saudável"
        status_copy = (
            f"Há ponto abaixo dos {settings['safetyMargin']:.1f} dB de reserva"
            if has_critical
            else "Existe ponto próximo da reserva"
            if has_warning
            else "Todos os pontos têm reserva"
        )
        summary = {
            "criticalPoint": critical["name"],
            "criticalValue": critical["local"],
            "minimumMargin": critical["margin"],
            "status": status,
            "statusCopy": status_copy,
            "totalClients": total_clients,
        }
    else:
        summary = {
            "criticalPoint": None,
            "criticalValue": None,
            "minimumMargin": None,
            "status": "Não calculada",
            "statusCopy": "Preencha a estrutura",
            "totalClients": 0,
        }

    diagnosis = diagnose_measurements(points, settings, results)
    attenuations = {item["index"]: item["loss"] for item in diagnosis["attenuations"]}
    for index, item in enumerate(results):
        item["suspectedInversion"] = index in diagnosis["inversions"]
        item["suspectedAttenuation"] = attenuations.get(index)
    if diagnosis["divergent"]:
        causes = []
        if diagnosis["attenuations"]:
            causes.append("atenuação no trecho")
        if diagnosis["inversions"]:
            causes.append("saídas invertidas")
        summary["status"] = "Sinal real divergente"
        summary["statusCopy"] = (
            f"Os sinais reais indicam {' e '.join(causes)}"
            if causes
            else "Os sinais reais não batem com o projeto"
        )
    field_steps = measurement_recommendations(points, settings, results, diagnosis)
    recommendations = field_steps + build_recommendations(
        points, settings, results, field_fault=bool(diagnosis["divergent"])
    )
    diagnosis.pop("scenario", None)
    return {
        "settings": settings,
        "results": results,
        "summary": summary,
        "diagnosis": diagnosis,
        "fieldSteps": field_steps,
        "recommendations": recommendations,
    }


def build_field_report(
    points: list[dict[str, Any]],
    raw_settings: dict[str, Any] | None,
    name: str = "",
    date: str = "",
) -> dict[str, str]:
    """Monta o relatório da rota para a equipe de campo, pronto para colar no WhatsApp."""
    analysis = analyze_route(points, raw_settings)
    settings, summary, results = analysis["settings"], analysis["summary"], analysis["results"]
    lines = [f"*Relatório de campo · {name.strip() or 'Cenário sem nome'}*"]
    if date:
        lines.append(f"Data: {date}")
    lines += [f"Situação: {summary['status']} ({summary['statusCopy']})", ""]

    if analysis["fieldSteps"]:
        lines.append("*O que fazer, nesta ordem:*")
        for number, step in enumerate(analysis["fieldSteps"], start=1):
            lines.append(f"{number}. {re.sub(r'^[0-9]+º passo: ', '', step['title'])}")
            lines.append(f"   {step['body']}")
    elif any(item["measured"] is not None for item in results):
        lines.append("Os sinais reais batem com o projeto. Nenhuma falha de campo identificada.")
    else:
        lines.append("Nenhum sinal real informado. Meça o melhor cliente de cada caixa para o diagnóstico.")

    lines += ["", "*Sinais por caixa* (projetado · real)"]
    for number, item in enumerate(results, start=1):
        parts = [item["splitter"], item["balanced"] if item["balanced"] != "Sem splitter" else ""]
        real = (
            f"{item['measured']:.2f} dBm (Δ {_signed(item['measuredDelta'])} dB)"
            if item["measured"] is not None
            else "não medido"
        )
        flags = ""
        if item.get("suspectedAttenuation") is not None:
            flags += f" ⚠ atenuação antes (~{item['suspectedAttenuation']:.1f} dB)"
        if item.get("suspectedInversion"):
            flags += " ⚠ saídas invertidas?"
        lines.append(
            f"{number}. {item['name']} ({' + '.join(part for part in parts if part)}): "
            f"{item['local']:.2f} dBm · {real}{flags}"
        )

    lines += [
        "",
        f"Origem {settings['sourcePower']:.1f} dBm · limite {settings['minimumPower']:.1f} dBm · "
        f"margem {settings['safetyMargin']:.1f} dB",
    ]
    return {"text": "\n".join(lines)}


def calculate_quick(input_power: Any, ratio: str) -> dict[str, float]:
    try:
        power = float(input_power)
    except (TypeError, ValueError) as exc:
        raise OpticalInputError("A potência de entrada é inválida.") from exc
    splitter = get_splitter(ratio)
    return {
        "local": power - splitter.local_loss,
        "pass": power - splitter.pass_loss,
        "localLoss": splitter.local_loss,
        "passLoss": splitter.pass_loss,
    }
