"""Servidor local sem dependências externas para testar o app.

Os cálculos rodam no navegador (Pyodide); este servidor só entrega os arquivos do app,
sem cache, para que cada alteração apareça ao recarregar a página.
"""

from __future__ import annotations

import argparse
import mimetypes
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_FILES = {
    "/",
    "/index.html",
    "/styles.css",
    "/app.js",
    "/optical.py",
    "/sw.js",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-512.png",
}
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")


class AppRequestHandler(SimpleHTTPRequestHandler):
    server_version = "OpticalPlanner/2.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def do_GET(self) -> None:  # noqa: N802 - assinatura definida pela biblioteca padrão
        # Só os arquivos do app: nada de listar pastas ou expor testes e configurações
        if urlsplit(self.path).path not in STATIC_FILES:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802 - assinatura definida pela biblioteca padrão
        if urlsplit(self.path).path not in STATIC_FILES:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_HEAD()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def create_server(host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), AppRequestHandler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Servidor local da calculadora de splitters ópticos.")
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
