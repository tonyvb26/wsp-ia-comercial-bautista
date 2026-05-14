const express = require("express");

const whatsappHandler = require("./api/webhook/whatsapp");
const healthHandler = require("./api/health");
const whatsappSubscribeHandler = require("./api/admin/whatsapp-subscribe");

const app = express();

app.use(express.json({ limit: "10mb" }));

app.all("/health", healthHandler);
app.all("/api/health", healthHandler);

app.all("/webhook/whatsapp", whatsappHandler);
app.all("/api/webhook/whatsapp", whatsappHandler);

app.all("/api/admin/whatsapp-subscribe", whatsappSubscribeHandler);

app.get("/", (_req, res) => {
  res.status(200).type("text/plain").send("COMERCIAL BAUTISTA API activa");
});

app.use((_req, res) => {
  res.status(404).type("text/plain").send("Not found");
});

module.exports = app;
