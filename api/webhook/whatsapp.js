/**
 * Webhook serverless para Vercel — WhatsApp Cloud API (Meta).
 * URL pública (con rewrite): /webhook/whatsapp
 *
 * Variable en Vercel: WHATSAPP_VERIFY_TOKEN (misma que "Token de verificación" en Meta)
 */
module.exports = function handler(req, res) {
  const token = process.env.WHATSAPP_VERIFY_TOKEN;

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const verifyToken = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!token) {
      console.error("Falta WHATSAPP_VERIFY_TOKEN en Vercel");
      return res.status(500).send("Server misconfigured");
    }

    if (mode === "subscribe" && verifyToken === token) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    res.status(200).end();

    try {
      if (req.body && Object.keys(req.body).length > 0) {
        console.log("WhatsApp webhook:", JSON.stringify(req.body));
      }
    } catch {
      console.log("WhatsApp webhook (body no serializable)");
    }
    return;
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end();
};
