/** Comprobación rápida: GET /api/health o /health (API Node de Vercel, sin Express) */
module.exports = function handler(_req, res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("ok");
};
