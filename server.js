import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Ruta raíz para probar conexión
app.get("/", (req, res) => {
  res.send("✅ LeadBot ACV activo y esperando mensajes desde Twilio");
});

// Webhook de Twilio
app.post("/webhook", (req, res) => {
  console.log("📩 POST recibido desde Twilio:", req.body);

  const twiml = `
    <Response>
      <Message>✅ Hola, soy el bot de prueba de ACV. Conectividad OK 🚀</Message>
    </Response>
  `;

  res
    .type("text/xml")
    .status(200)
    .send(twiml);

  console.log("✅ Respondido a Twilio correctamente");
});

// Render usa PORT o 10000 por defecto
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en el puerto ${PORT}`);
});
