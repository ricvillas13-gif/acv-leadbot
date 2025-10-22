// === TWILIO WHATSAPP WEBHOOK - BOT DE PRUEBA ACV ===
const express = require("express");
const bodyParser = require("body-parser");
const app = express();

// Twilio envía x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

app.post("/", (req, res) => {
  console.log("📩 Mensaje entrante de Twilio:", req.body);

  const respuesta = `
    <Response>
      <Message>✅ Hola, soy el bot de prueba de ACV. Conectividad OK 🚀</Message>
    </Response>
  `;

  res.set("Content-Type", "text/xml");
  res.status(200).send(respuesta);
});

// GET para probar en el navegador
app.get("/", (req, res) => {
  res.send("✅ LeadBot ACV activo y esperando mensajes desde Twilio");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
