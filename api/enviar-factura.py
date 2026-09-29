import json
import os
from http.server import BaseHTTPRequestHandler
import requests

# Variables de entorno de Supabase
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY")

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        # Manejo de CORS (preflight)
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_POST(self):
        try:
            # 1. Leer el cuerpo de la petición HTTP
            content_length = int(self.headers.get("Content-Length", 0))
            body_raw = self.rfile.read(content_length)
            payload = json.loads(body_raw)

            # 2. Construir 'p_factura' filtrando campos de descuentos y créditos
            p_factura = {
                "id_factura": payload.get("id_factura"),
                "nombre": payload.get("nombre"),
                "apellido": payload.get("apellido", ""),
                "cedula": payload.get("cedula", ""),
                "telefono": payload.get("telefono"),
                "vendedor": payload.get("vendedor", "Cajero General"),
                "subtotal_usd": payload.get("subtotal_usd"),
                "total_usd": payload.get("total_usd"),
                "subtotal_bs": payload.get("subtotal_bs"),
                "total_bs": payload.get("total_bs"),
                "tasa_cambio": payload.get("tasa_cambio", 1.0),
                "metodo_pago": payload.get("metodo_pago"),
                "referencia": payload.get("referencia"),
                "banco": payload.get("banco"),
                "comprobante_path": payload.get("comprobante_path"),
                "observaciones": payload.get("observaciones", ""),
                "pagos_combinados": payload.get("pagos_combinados")
            }

            # 3. Transformar 'productos' a 'p_detalles' ajustando nombres de propiedades
            productos_raw = payload.get("productos", [])
            p_detalles = []

            for item in productos_raw:
                p_detalles.append({
                    "nombre_producto": item.get("nombre"),
                    "cantidad": item.get("cantidad"),
                    "precio_unitario": item.get("precioUnitario"),
                    "precio_total": item.get("precioTotal")
                })

            # 4. Enviar a Supabase mediante API REST / RPC
            rpc_url = f"{SUPABASE_URL}/rest/v1/rpc/guardar_factura_completa"
            headers = {
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json"
            }

            rpc_payload = {
                "p_factura": p_factura,
                "p_detalles": p_detalles
            }

            response = requests.post(rpc_url, json=rpc_payload, headers=headers)

            if response.status_code in (200, 204):
                self._responder(200, {"success": True, "message": "Factura guardada exitosamente"})
            else:
                self._responder(
                    response.status_code, 
                    {"error": f"Error en Supabase: {response.text}"}
                )

        except Exception as e:
            self._responder(500, {"error": str(e)})

    def _responder(self, status_code, body):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))