/**
 * Webhook serverless para Vercel — WhatsApp Cloud API (Meta).
 * URL pública (con rewrite): /webhook/whatsapp
 *
 * Variable en Vercel: WHATSAPP_VERIFY_TOKEN (misma que "Token de verificación" en Meta)
 *
 * Nota: en /api/* Vercel usa res de Node (writeHead/end), no el res de Express.
 */
module.exports = function handler(req, res) {
  const token = process.env.WHATSAPP_VERIFY_TOKEN;

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const verifyToken = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!token) {
      console.error("Falta WHATSAPP_VERIFY_TOKEN en Vercel");
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server misconfigured");
      return;
    }

    if (mode === "subscribe" && verifyToken === token) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(challenge));
      return;
    }

    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (req.method === "POST") {
    res.writeHead(200);
    res.end();

    try {
      if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
        console.log("WhatsApp webhook:", JSON.stringify(req.body));
      }
    } catch {
      console.log("WhatsApp webhook (body no serializable)");
    }
    return;
  }

  res.writeHead(405, { Allow: "GET, POST" });
  res.end();
};
