"""Motor de cálculo óptico do projeto.

Este módulo não depende da camada web. Ele pode ser testado, reutilizado por outras
interfaces e futuramente integrado ao sistema de solicitação de materiais.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
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

        segment_loss = distance * settings["fiberLoss"] + splices * settings["spliceLoss"]
        input_power = current_power - segment_loss
        local_loss = splitter.local_loss if splitter else 0.0
        local_power = input_power - local_loss - BALANCED_LOSSES[balanced]
        pass_power = input_power - splitter.pass_loss if splitter else None
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


def _signed(value: float) -> str:
    return f"{value:+.2f}"


def build_recommendations(
    points: list[dict[str, Any]],
    settings: dict[str, Any],
    results: list[dict[str, Any]],
) -> list[dict[str, str]]:
    if not results:
        return []

    score = route_score(results)
    critical = min(results, key=lambda item: item["effectiveMargin"])
    recommendations: list[dict[str, str]] = []

    if score["minimum"] < 0:
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


def build_materials(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[tuple[str, str], int] = {}
    for point in points:
        ratio = str(point.get("splitter") or "")
        if ratio:
            counts[("desbalanceado", ratio)] = counts.get(("desbalanceado", ratio), 0) + 1
        balanced = str(point.get("balanced") or "Sem splitter")
        if balanced != "Sem splitter":
            counts[("balanceado", balanced)] = counts.get(("balanceado", balanced), 0) + 1

    materials = []
    for (kind, name), quantity in counts.items():
        splitter = next((item for item in SPLITTERS if item.ratio == name), None)
        materials.append(
            {
                "type": kind,
                "name": name,
                "quantity": quantity,
                "code": splitter.code if splitter else None,
            }
        )
    return materials


def analyze_route(points: list[dict[str, Any]], raw_settings: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(points, list):
        raise OpticalInputError("A estrutura da rota deve ser uma lista de pontos.")
    settings = normalize_settings(raw_settings)
    results = calculate_route(points, settings)

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
        }
    else:
        summary = {
            "criticalPoint": None,
            "criticalValue": None,
            "minimumMargin": None,
            "status": "Não calculada",
            "statusCopy": "Preencha a estrutura",
        }

    return {
        "settings": settings,
        "results": results,
        "summary": summary,
        "recommendations": build_recommendations(points, settings, results),
        "materials": build_materials(points),
    }


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
