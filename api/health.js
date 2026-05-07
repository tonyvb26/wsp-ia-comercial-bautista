/** Comprobación rápida: GET /api/health o /health */
module.exports = function handler(_req, res) {
  res.status(200).type("text/plain").send("ok");
};
