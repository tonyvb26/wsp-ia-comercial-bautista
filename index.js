/**
 * Punto de entrada mínimo que exige el builder de Vercel (CLI 53+).
 * El webhook de WhatsApp (Gladis) está en api/webhook/whatsapp.js.
 */
module.exports = function handler(req, res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("COMERCIAL BAUTISTA — API activa. Webhook: /webhook/whatsapp");
};
