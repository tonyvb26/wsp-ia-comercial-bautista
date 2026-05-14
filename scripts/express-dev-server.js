/**
 * Servidor Express solo para desarrollo local o PaaS tipo Render (npm start).
 * En Vercel NO debe existir server.js en la raíz: Vercel lo detecta como "legacy
 * server" y deja de enrutar /webhook/whatsapp a api/webhook/whatsapp.js (Gladis).
 *
 * Variables: WHATSAPP_VERIFY_TOKEN (obligatorio), PORT (opcional, default 3000).
 */
const express = require("express");

const VERIFY_TOKEN = String(process.env.WHATSAPP_VERIFY_TOKEN || "").trim();
const PORT = Number(process.env.PORT) || 3000;

if (!VERIFY_TOKEN) {
  console.error("Falta WHATSAPP_VERIFY_TOKEN en el entorno.");
  process.exit(1);
}

const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

app.get("/webhook/whatsapp", (req, res) => {
  const mode = String(req.query["hub.mode"] ?? "").trim();
  const token = String(req.query["hub.verify_token"] ?? "").trim();
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");
    return res.status(200).send(challenge !== undefined && challenge !== null ? String(challenge) : "");
  }

  console.warn("Verificación fallida:", { mode, tokenMatch: token === VERIFY_TOKEN });
  return res.sendStatus(403);
});

app.post("/webhook/whatsapp", (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body?.object !== "whatsapp_business_account") {
    return;
  }

  try {
    console.log("Webhook POST:", JSON.stringify(body, null, 2));
  } catch {
    console.log("Webhook POST (no serializable)");
  }
});

app.use((_req, res) => res.sendStatus(404));

app.listen(PORT, () => {
  console.log(`[dev] Webhook escuchando en puerto ${PORT} (solo pruebas; en producción usa Vercel + api/webhook/whatsapp.js)`);
  console.log(`[dev] Verificación GET: /webhook/whatsapp`);
});
