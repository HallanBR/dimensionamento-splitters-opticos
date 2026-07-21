"""Servidor web sem dependências externas para a calculadora óptica."""

from __future__ import annotations

import argparse
import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from optical import OpticalInputError, analyze_route, calculate_quick, catalog


PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_FILES = {
    "/": PROJECT_ROOT / "index.html",
    "/index.html": PROJECT_ROOT / "index.html",
    "/styles.css": PROJECT_ROOT / "styles.css",
    "/app.js": PROJECT_ROOT / "app.js",
}
MAX_BODY_SIZE = 1_000_000


class OpticalRequestHandler(BaseHTTPRequestHandler):
    server_version = "OpticalPlanner/1.0"

    def do_GET(self) -> None:  # noqa: N802 - assinatura definida pela biblioteca padrão
        path = urlsplit(self.path).path
        if path == "/api/catalog":
            self.send_json(HTTPStatus.OK, catalog())
            return
        file_path = STATIC_FILES.get(path)
        if file_path is None or not file_path.is_file():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Recurso não encontrado."})
            return
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        body = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - assinatura definida pela biblioteca padrão
        path = urlsplit(self.path).path
        try:
            payload = self.read_json()
            if path == "/api/calculate":
                response = analyze_route(payload.get("points", []), payload.get("settings", {}))
            elif path == "/api/quick":
                response = calculate_quick(payload.get("inputPower"), str(payload.get("splitter", "")))
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Recurso não encontrado."})
                return
            self.send_json(HTTPStatus.OK, response)
        except OpticalInputError as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "O corpo da requisição deve conter JSON válido."})
        except Exception:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Não foi possível concluir o cálculo."})

    def read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise OpticalInputError("Tamanho de requisição inválido.") from exc
        if length <= 0 or length > MAX_BODY_SIZE:
            raise OpticalInputError("A requisição está vazia ou excede o limite permitido.")
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(data, dict):
            raise OpticalInputError("O corpo da requisição deve ser um objeto JSON.")
        return data

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")


def create_server(host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), OpticalRequestHandler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Servidor da calculadora de splitters ópticos.")
    parser.add_argument("--host", default="127.0.0.1", help="Endereço de escuta. Padrão: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8000, help="Porta HTTP. Padrão: 8000")
    args = parser.parse_args()
    server = create_server(args.host, args.port)
    print(f"Calculadora disponível em http://{args.host}:{server.server_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
