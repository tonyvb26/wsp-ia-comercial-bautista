/**
 * Webhook para WhatsApp Cloud API (Meta).
 * - GET: verificación al pulsar "Verificar y guardar"
 * - POST: eventos entrantes (mensajes, estados, etc.)
 *
 * Variables de entorno:
 *   WHATSAPP_VERIFY_TOKEN  (obligatorio) mismo valor que "Token de verificación" en Meta
 *   PORT                   (opcional, Render/Railway lo suelen inyectar)
 */
const express = require("express");

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const PORT = Number(process.env.PORT) || 3000;

if (!VERIFY_TOKEN) {
  console.error("Falta WHATSAPP_VERIFY_TOKEN en el entorno.");
  process.exit(1);
}

const app = express();

// Meta envía JSON en POST; límite razonable para payloads de webhook
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

/**
 * Ruta que debes pegar en Meta como URL de devolución de llamada:
 *   https://TU-DOMINIO-PUBLICO/webhook/whatsapp
 */
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }

  console.warn("Verificación fallida:", { mode, tokenMatch: token === VERIFY_TOKEN });
  return res.sendStatus(403);
});

app.post("/webhook/whatsapp", (req, res) => {
  // Responder rápido; el procesamiento pesado debe ir en cola/async más adelante
  res.sendStatus(200);

  const body = req.body;
  if (body?.object !== "whatsapp_business_account") {
    return;
  }

  // Aquí llegarán mensajes entrantes; por ahora solo registro en consola
  try {
    console.log("Webhook POST:", JSON.stringify(body, null, 2));
  } catch {
    console.log("Webhook POST (no serializable)");
  }
});

app.use((_req, res) => res.sendStatus(404));

app.listen(PORT, () => {
  console.log(`Webhook escuchando en puerto ${PORT}`);
  console.log(`Verificación GET: /webhook/whatsapp`);
});
