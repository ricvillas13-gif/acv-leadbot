import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// =================== DEBUG INICIAL ===================
console.log("🔍 Verificando variable GOOGLE_SERVICE_ACCOUNT...");

const svcRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
console.log("🟡 Tipo recibido:", typeof svcRaw);
console.log("🟡 Primeros 100 caracteres:", svcRaw ? svcRaw.substring(0, 100) : "VACÍO");
console.log("🟡 Longitud total:", svcRaw ? svcRaw.length : "undefined");

let creds = null;
try {
  if (!svcRaw) throw new Error("GOOGLE_SERVICE_ACCOUNT está vacío o no definido");
  creds = JSON.parse(svcRaw);
  console.log("✅ JSON parseado correctamente. Cliente de servicio listo.");
} catch (err) {
  console.error("❌ Error al parsear GOOGLE_SERVICE_ACCOUNT:", err.message);
  console.log("🪶 Valor crudo (primeras 300 chars):", svcRaw ? svcRaw.substring(0, 300) : "VACÍO");
}

// ======================================================

const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => {
  res.send("✅ LeadBot ACV debug activo y escuchando conexiones.");
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en el puerto ${PORT}`);
});
