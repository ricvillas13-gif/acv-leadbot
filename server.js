import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";

// ===== CONFIGURACIÓN INICIAL =====
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
const SHEET_ID = process.env.GOOGLE_SHEET_ID; // ID real de la hoja "Leads"

// Autenticación con Google
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ===== ESTADOS TEMPORALES DE USUARIO =====
const session = {};

// ===== FLUJO DE PREGUNTAS =====
const steps = [
  "Cliente",
  "Garantía",
  "Monto solicitado",
  "Procedencia de lead",
  "Ubicación",
  "Cita",
  "Lugar",
  "Fotos",
];

// ===== LISTAS =====
const garantias = ["Auto", "Inmueble", "Maquinaria", "Reloj"];
const procedencias = [
  "Referido",
  "Anuncio en línea",
  "Evento",
  "Búsqueda orgánica",
  "Publicidad Facebook",
  "Publicidad Instagram",
  "Campaña WhatsApp",
  "Formulario Facebook",
  "Campaña Messenger",
  "Ninguno",
];
const ubicaciones = [
  "Aguascalientes", "Baja California", "Campeche", "CDMX", "Chiapas",
  "Chihuahua", "Coahuila", "Colima", "Durango", "Estado de México",
  "Guanajuato", "Guerrero", "Hidalgo", "Jalisco", "Michoacán",
  "Morelos", "Nayarit", "Nuevo León", "Oaxaca", "Puebla", "Querétaro",
  "Quintana Roo", "San Luis Potosí", "Sinaloa", "Sonora", "Tabasco",
  "Tamaulipas", "Tlaxcala", "Veracruz", "Yucatán", "Zacatecas"
];
const lugares = ["Corporativo", "Patio de resguardo 1", "Patio de resguardo 2"];

// ===== UTILIDADES =====
function nextStep(phone) {
  const current = session[phone]?.step || 0;
  return steps[current];
}
function advanceStep(phone) {
  session[phone].step++;
}
function resetSession(phone) {
  session[phone] = { step: 0, data: {} };
}

// ===== TWILIO WEBHOOK =====
app.post("/twilio", async (req, res) => {
  try {
    const from = req.body.From || "";
    const body = (req.body.Body || "").trim();
    const mediaCount = Number(req.body.NumMedia || 0);

    if (!from) return res.type("text/xml").send("<Response><Message>Error: sin remitente.</Message></Response>");
    if (!session[from]) resetSession(from);

    const step = nextStep(from);
    const data = session[from].data;

    if (mediaCount > 0) {
      data.Fotos = data.Fotos || [];
      for (let i = 0; i < mediaCount; i++) {
        data.Fotos.push(req.body[`MediaUrl${i}`]);
      }
      advanceStep(from);
    } else {
      switch (step) {
        case "Cliente":
          data.Cliente = body;
          advanceStep(from);
          break;
        case "Garantía":
          if (!garantias.includes(body)) {
            return res
              .type("text/xml")
              .send(`<Response><Message>Selecciona una garantía: ${garantias.join(", ")}</Message></Response>`);
          }
          data.Garantía = body;
          advanceStep(from);
          break;
        case "Monto solicitado":
          data["Monto solicitado"] = body.replace(/[^\d.]/g, "");
          advanceStep(from);
          break;
        case "Procedencia de lead":
          if (!procedencias.includes(body)) {
            return res
              .type("text/xml")
              .send(`<Response><Message>Selecciona una procedencia válida: ${procedencias.join(", ")}</Message></Response>`);
          }
          data["Procedencia de lead"] = body;
          advanceStep(from);
          break;
        case "Ubicación":
          if (!ubicaciones.includes(body)) {
            return res
              .type("text/xml")
              .send(`<Response><Message>Selecciona un estado válido: ${ubicaciones.join(", ")}</Message></Response>`);
          }
          data.Ubicación = body;
          advanceStep(from);
          break;
        case "Cita":
          data.Cita = body;
          advanceStep(from);
          break;
        case "Lugar":
          if (!lugares.includes(body)) {
            return res
              .type("text/xml")
              .send(`<Response><Message>Selecciona un lugar válido: ${lugares.join(", ")}</Message></Response>`);
          }
          data.Lugar = body;
          advanceStep(from);
          break;
      }
    }

    // Si completó el flujo:
    if (session[from].step >= steps.length) {
      data["Fecha de contacto"] = new Date().toLocaleString("es-MX");
      data["Etapa del cliente"] = "contacto inicial";
      data["Responsable"] = "Bot";
      data["Resultado final"] = "Pendiente";
      data["Canal de contacto"] = "WhatsApp"; // 👈 nuevo campo automático

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Leads!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [
            [
              data["Fecha de contacto"],
              data.Cliente,
              data.Garantía,
              data["Monto solicitado"],
              data["Procedencia de lead"],
              data.Ubicación,
              data.Cita,
              data.Lugar,
              data.Responsable,
              data["Etapa del cliente"],
              data["Resultado final"],
              data["Canal de contacto"],
              data.Fotos?.join(", ") || "",
            ],
          ],
        },
      });

      resetSession(from);
      return res
        .type("text/xml")
        .send(`<Response><Message>✅ Gracias ${data.Cliente}, registramos tu información correctamente.</Message></Response>`);
    }

    // Pregunta siguiente paso
    const next = nextStep(from);
    return res.type("text/xml").send(`<Response><Message>${promptFor(next)}</Message></Response>`);
  } catch (err) {
    console.error(err);
    res.type("text/xml").send("<Response><Message>⚠️ Ocurrió un error en el bot.</Message></Response>");
  }
});

// ===== FUNCIONES DE TEXTO =====
function promptFor(step) {
  switch (step) {
    case "Cliente":
      return "👋 Hola, ¿cómo te llamas?";
    case "Garantía":
      return `¿Qué tipo de garantía ofrecerías? (${garantias.join(", ")})`;
    case "Monto solicitado":
      return "¿Cuál es el monto que deseas solicitar?";
    case "Procedencia de lead":
      return `¿Cómo nos encontraste? (${procedencias.join(", ")})`;
    case "Ubicación":
      return `¿En qué estado de la República te encuentras?`;
    case "Cita":
      return "¿Qué día y hora te gustaría agendar una cita?";
    case "Lugar":
      return `¿Dónde prefieres la cita? (${lugares.join(", ")})`;
    case "Fotos":
      return "📸 Por favor, envíame 3 fotos de la garantía.";
    default:
      return "Gracias por tu interés. Te contactaremos pronto.";
  }
}

// ===== INICIO DEL SERVIDOR =====
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => {
  res.send("✅ LeadBot ACV operativo y conectado a Google Sheets.");
});
app.listen(PORT, () => console.log(`🚀 Servidor activo en el puerto ${PORT}`));
