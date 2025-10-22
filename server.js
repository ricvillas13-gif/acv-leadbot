import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Endpoint de prueba para Twilio
app.post("/", (req, res) => {
  console.log("📩 POST recibido:", req.body);
  res.type("text/xml");
  res.send(`<Response><Message>✅ LeadBot ACV activo y esperando mensajes desde Twilio</Message></Response>`);
});

// Endpoint GET para ver si Render está activo
app.get("/", (req, res) => {
  res.send("✅ LeadBot ACV activo y esperando mensajes desde Twilio");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor activo en el puerto ${PORT}`));
