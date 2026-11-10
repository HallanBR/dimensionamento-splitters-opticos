import unittest

from optical import (
    OpticalInputError,
    analyze_route,
    build_recommendations,
    calculate_quick,
    calculate_route,
    optimize_splitters,
)


SETTINGS = {
    "sourcePower": 3,
    "fiberLoss": 0.35,
    "spliceLoss": 0.1,
    "minimumPower": -27,
    "safetyMargin": 3,
}


class OpticalCalculatorTests(unittest.TestCase):
    def test_calcula_as_duas_saidas_de_um_splitter(self) -> None:
        result = calculate_quick(-8, "10/90")
        self.assertAlmostEqual(result["local"], -18.7)
        self.assertAlmostEqual(result["pass"], -9.0)

    def test_propaga_a_saida_passante_para_o_ponto_seguinte(self) -> None:
        points = [
            {"name": "CTO 01", "distance": 1, "splices": 2, "splitter": "10/90", "balanced": "1x8"},
            {"name": "CTO 02", "distance": 2, "splices": 1, "splitter": "20/80", "balanced": "1x8"},
        ]
        results = calculate_route(points, SETTINGS)
        self.assertAlmostEqual(results[0]["input"], 2.45)
        self.assertAlmostEqual(results[0]["pass"], 1.45)
        self.assertAlmostEqual(results[1]["input"], 0.65)
        self.assertAlmostEqual(results[1]["local"], -17.55)

    def test_desconta_a_margem_de_seguranca(self) -> None:
        results = calculate_route(
            [{"name": "CTO", "distance": 0, "splices": 0, "splitter": "05/95", "balanced": "1x16"}],
            SETTINGS,
        )
        self.assertAlmostEqual(results[0]["margin"], 2.4)
        self.assertAlmostEqual(results[0]["effectiveMargin"], -0.6)

    def test_gera_recomendacao_para_rota_critica(self) -> None:
        points = [{"name": "CTO crítica", "distance": 0, "splices": 0, "splitter": "05/95", "balanced": "1x16"}]
        results = calculate_route(points, SETTINGS)
        recommendations = build_recommendations(points, SETTINGS, results)
        self.assertEqual(recommendations[0]["level"], "required")
        self.assertIn("CTO crítica", recommendations[0]["title"])

    def test_sugere_avaliar_a_origem_quando_ha_folga(self) -> None:
        points = [{"name": "CTO próxima", "distance": 0, "splices": 0, "splitter": "50/50", "balanced": "1x2"}]
        results = calculate_route(points, SETTINGS)
        recommendations = build_recommendations(points, SETTINGS, results)
        self.assertTrue(any("potência menor" in item["title"] for item in recommendations))

    def test_analise_retorna_resultado_resumo_e_materiais(self) -> None:
        points = [{"name": "CTO", "distance": 1, "splices": 2, "splitter": "10/90", "balanced": "1x8"}]
        analysis = analyze_route(points, SETTINGS)
        self.assertEqual(analysis["summary"]["criticalPoint"], "CTO")
        self.assertEqual(analysis["materials"][0]["code"], 1843)
        self.assertEqual(len(analysis["results"]), 1)

    def test_ultima_caixa_pode_ter_apenas_splitter_local(self) -> None:
        points = [
            {"name": "CTO final", "distance": 1, "splices": 2, "splitter": "", "balanced": "1x8"}
        ]
        analysis = analyze_route(points, SETTINGS)
        result = analysis["results"][0]
        self.assertAlmostEqual(result["input"], 2.45)
        self.assertAlmostEqual(result["local"], -8.05)
        self.assertIsNone(result["pass"])
        self.assertIsNone(result["splitterData"])
        self.assertEqual(analysis["materials"], [
            {"type": "balanceado", "name": "1x8", "quantity": 1, "code": None}
        ])

    def test_caixa_sem_desbalanceado_deve_ser_a_ultima(self) -> None:
        points = [
            {"name": "CTO 01", "distance": 0, "splices": 0, "splitter": "", "balanced": "1x8"},
            {"name": "CTO 02", "distance": 0, "splices": 0, "splitter": "10/90", "balanced": "1x8"},
        ]
        with self.assertRaises(OpticalInputError):
            calculate_route(points, SETTINGS)

    def test_saida_passante_alimenta_caixa_final_sem_desbalanceado(self) -> None:
        points = [
            {"name": "CTO 01", "distance": 1, "splices": 2, "splitter": "10/90", "balanced": "1x8"},
            {"name": "CTO final", "distance": 2, "splices": 1, "splitter": "", "balanced": "1x8"},
        ]
        analysis = analyze_route(points, SETTINGS)
        results = analysis["results"]
        self.assertAlmostEqual(results[0]["pass"], 1.45)
        self.assertAlmostEqual(results[1]["input"], 0.65)
        self.assertAlmostEqual(results[1]["local"], -9.85)
        self.assertEqual(analysis["materials"], [
            {"type": "desbalanceado", "name": "10/90", "quantity": 1, "code": 1843},
            {"type": "balanceado", "name": "1x8", "quantity": 2, "code": None},
        ])

    def test_soma_capacidade_dos_splitters_de_clientes(self) -> None:
        points = [
            {"name": "CTO 01", "distance": 0, "splices": 0, "splitter": "10/90", "balanced": "1x8"},
            {"name": "CTO final", "distance": 0, "splices": 0, "splitter": "", "balanced": "1x16"},
        ]
        analysis = analyze_route(points, SETTINGS)
        self.assertEqual(analysis["summary"]["totalClients"], 24)

    def test_ignora_caixa_sem_splitter_de_clientes_na_capacidade(self) -> None:
        points = [
            {"name": "CTO", "distance": 0, "splices": 0, "splitter": "10/90", "balanced": "Sem splitter"}
        ]
        analysis = analyze_route(points, SETTINGS)
        self.assertEqual(analysis["summary"]["totalClients"], 0)

    def test_rejeita_splitter_desconhecido(self) -> None:
        with self.assertRaises(OpticalInputError):
            calculate_quick(-8, "12/88")


FIELD_SETTINGS = {**SETTINGS, "sourcePower": 4}


def field_route(**measured: float) -> list[dict]:
    names = ["SJL-CTO0425", "SJL-CTO0424", "SJL-CTO0423", "SJL-CTO0422", "SJL-CTO0421"]
    ratios = ["15/85", "15/85", "20/80", "30/70", ""]
    distances = [0, 0.91, 0, 0, 0]
    return [
        {
            "name": name,
            "distance": distance,
            "splices": 0,
            "splitter": ratio,
            "balanced": "1x16",
            "measured": measured.get(name.replace("-", "_")),
        }
        for name, ratio, distance in zip(names, ratios, distances)
    ]


class FieldMeasurementTests(unittest.TestCase):
    def test_calcula_a_diferenca_entre_sinal_real_e_projetado(self) -> None:
        results = calculate_route(field_route(SJL_CTO0425=-19.5), FIELD_SETTINGS)
        self.assertAlmostEqual(results[0]["measuredDelta"], -0.8)
        self.assertIsNone(results[1]["measured"])

    def test_identifica_saidas_invertidas_em_duas_caixas(self) -> None:
        analysis = analyze_route(field_route(SJL_CTO0423=-15, SJL_CTO0421=-26), FIELD_SETTINGS)
        self.assertEqual(analysis["diagnosis"]["inversions"], [2, 3])
        self.assertTrue(analysis["results"][3]["suspectedInversion"])
        self.assertIn("inversão", analysis["recommendations"][0]["title"])

    def test_sinal_real_proximo_do_projeto_nao_gera_alerta(self) -> None:
        analysis = analyze_route(field_route(SJL_CTO0423=-20.5), FIELD_SETTINGS)
        self.assertEqual(analysis["diagnosis"]["divergent"], [])
        self.assertNotIn("divergente", analysis["recommendations"][0]["title"])

    def test_divergencia_sem_explicacao_aponta_o_ponto(self) -> None:
        analysis = analyze_route(field_route(SJL_CTO0425=-25), FIELD_SETTINGS)
        self.assertEqual(analysis["diagnosis"]["inversions"], [])
        self.assertIn("SJL-CTO0425", analysis["recommendations"][0]["title"])

    def test_rejeita_sinal_real_invalido(self) -> None:
        route = field_route()
        route[0]["measured"] = "abc"
        with self.assertRaises(OpticalInputError):
            calculate_route(route, FIELD_SETTINGS)


CASCADE_SETTINGS = {**SETTINGS, "sourcePower": 2}


def cascade_route(*measured: float | None) -> list[dict]:
    """Rota real da SJL: 0382 → 0378, sinais do melhor cliente medidos em campo."""
    boxes = [
        ("SJL-CTO0382", "10/90", "1x8"),
        ("SJL-CTO0381", "15/85", "1x8"),
        ("SJL-CTO0380", "20/80", "1x8"),
        ("SJL-CTO0379", "30/70", "1x16"),
        ("SJL-CTO0378", "", "1x8"),
    ]
    return [
        {"name": name, "distance": 0, "splices": 0, "splitter": ratio, "balanced": balanced, "measured": value}
        for (name, ratio, balanced), value in zip(boxes, measured)
    ]


class CascadeDiagnosisTests(unittest.TestCase):
    def test_atenuacao_no_inicio_e_inversao_depois_em_ordem_de_tratamento(self) -> None:
        analysis = analyze_route(cascade_route(-19.73, -24, -23, -23, -21), CASCADE_SETTINGS)
        diagnosis = analysis["diagnosis"]
        self.assertEqual([item["index"] for item in diagnosis["attenuations"]], [1])
        self.assertAlmostEqual(diagnosis["attenuations"][0]["loss"], 4.8, delta=0.5)
        self.assertEqual(diagnosis["inversions"], [3])
        first, second = analysis["recommendations"][:2]
        self.assertIn("1º passo: Atenuação", first["title"])
        self.assertIn("entre SJL-CTO0382 e SJL-CTO0381", first["title"])
        self.assertIn("2º passo: Possível inversão", second["title"])
        self.assertIn("SJL-CTO0379", second["title"])
        # Desfazer a inversão antes de tratar a atenuação derrubaria os clientes da 0379
        self.assertIn("Só desfaça a inversão depois", second["body"])
        self.assertEqual(analysis["results"][1]["suspectedAttenuation"], diagnosis["attenuations"][0]["loss"])
        self.assertTrue(all(not item["title"].startswith("Comparar") for item in analysis["recommendations"]))

    def test_so_atenuacao_aponta_o_trecho_e_nao_inversao(self) -> None:
        analysis = analyze_route(cascade_route(-19.7, -23.4, -23.4, -26.6, -19.7), CASCADE_SETTINGS)
        self.assertEqual([item["index"] for item in analysis["diagnosis"]["attenuations"]], [1])
        self.assertEqual(analysis["diagnosis"]["inversions"], [])
        self.assertIn("entre SJL-CTO0382 e SJL-CTO0381", analysis["recommendations"][0]["title"])

    def test_atenuacao_tambem_explica_problema_local_isolado(self) -> None:
        analysis = analyze_route(cascade_route(-19.7, -23.4, -23.4, -26.6, -25.7), CASCADE_SETTINGS)
        self.assertEqual([item["index"] for item in analysis["diagnosis"]["localIssues"]], [4])
        titles = [item["title"] for item in analysis["recommendations"][:2]]
        self.assertIn("1º passo: Atenuação", titles[0])
        self.assertIn("2º passo: Problema local em SJL-CTO0378", titles[1])

    def test_sem_explicacao_aponta_a_primeira_caixa_divergente(self) -> None:
        analysis = analyze_route(cascade_route(-19.7, -26, -18.4, -15, -22), CASCADE_SETTINGS)
        self.assertEqual(analysis["diagnosis"]["attenuations"], [])
        self.assertIn("a partir de SJL-CTO0381", analysis["recommendations"][0]["title"])


class OptimizerTests(unittest.TestCase):
    def test_otimizador_melhora_a_menor_margem(self) -> None:
        result = optimize_splitters(field_route(), FIELD_SETTINGS)
        self.assertTrue(result["changed"])
        self.assertGreater(result["proposedMinimum"], result["currentMinimum"])
        self.assertEqual(result["splitters"][-1], "")

    def test_otimizador_mantem_rota_ja_otimizada(self) -> None:
        first = optimize_splitters(field_route(), FIELD_SETTINGS)
        route = field_route()
        for point, ratio in zip(route, first["splitters"]):
            point["splitter"] = ratio
        second = optimize_splitters(route, FIELD_SETTINGS)
        self.assertFalse(second["changed"])
        self.assertEqual(second["changes"], [])



if __name__ == "__main__":
    unittest.main()
