import unittest

from optical import (
    OpticalInputError,
    analyze_route,
    build_recommendations,
    calculate_quick,
    calculate_route,
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

    def test_rejeita_splitter_desconhecido(self) -> None:
        with self.assertRaises(OpticalInputError):
            calculate_quick(-8, "12/88")


if __name__ == "__main__":
    unittest.main()
