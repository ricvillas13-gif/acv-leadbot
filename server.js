import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import he from "he";
import * as chrono from "chrono-node";

const app = express(); // ✅ primero inicializas Express

// ✅ Servir la carpeta "public" con MIME forzado correcto
app.use(
  express.static("public", {
    setHeaders: (res, path) => {
      if (path.endsWith(".png")) {
        res.setHeader("Content-Type", "image/png");
      } else if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
        res.setHeader("Content-Type", "image/jpeg");
      }
    },
  })
);

// ✅ Luego el resto de middlewares
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());


const PORT = process.env.PORT || 10000;
const SHEET_ID = "1OGtZIFiEZWI8Tws1X_tZyEfgiEnVNlGcJay-Dg6-N_o";
const LEADS_SHEET = "Leads";
const CONFIG_SHEET = "Configuración";
const LOBO_IMG = "https://leadbot-acv.onrender.com/Logo-ACV-Transparente.png";

// === GOOGLE AUTH ===
let creds;
try {
  console.log("🔍 Verificando GOOGLE_SERVICE_ACCOUNT...");
  creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  console.log("✅ Credenciales parseadas correctamente.");
} catch (err) {
  console.error("❌ ERROR al parsear GOOGLE_SERVICE_ACCOUNT:", err);
}

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// === SESIONES EN MEMORIA ===
const sessionState = {}; // clave: celular

// === LUGARES CONFIG DINÁMICA ===
let lugaresDisponibles = [];
async function cargarLugares() {
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${CONFIG_SHEET}!A2:C`,
    });
    const rows = resp.data.values || [];
    lugaresDisponibles = rows
      .filter(r => (r[0] || "").trim())
      .map(r => ({
        nombre: (r[0] || "").trim(),
        direccion: (r[1] || "").trim(),
        maps: (r[2] || "").trim(),
      }));
    console.log("📍 Lugares cargados:", lugaresDisponibles.map(l => l.nombre));
  } catch (err) {
    console.error("❌ Error cargando lugares:", err);
  }
}
await cargarLugares();

// === UTILS ===
function xmlEscape(str) {
  const safe = he.encode(str || "", { useNamedReferences: false, decimal: true });
  return safe.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
function replyXml(res, message, mediaUrl = null) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>';
  xml += `<Body>${xmlEscape(message)}</Body>`;
  if (mediaUrl) xml += `<Media>${xmlEscape(mediaUrl)}</Media>`;
  xml += "</Message></Response>";
  res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
  res.end(xml);
}
function currencyMXN(n) {
  const num = Number(String(n).replace(/[^0-9.]/g, ""));
  if (Number.isNaN(num)) return null;
  return num.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}
function normalizePhone(from) {
  return (from || "").replace("whatsapp:", "");
}
function nowMX() {
  return new Date().toLocaleString("es-MX");
}
function isAffirmative(msg) {
  return /^(si|sí|s|yes|claro|ok|de acuerdo)$/i.test(msg);
}
function isNegative(msg) {
  return /^(no|nop|nel|ne)$/i.test(msg);
}
function parseCitaES(texto) {
  try {
    return chrono.es.parseDate(texto) || null;
  } catch {
    return null;
  }
}
function renderLugaresMsg() {
  if (!lugaresDisponibles.length) return "Por el momento no hay lugares configurados.";
  let txt = "¿Dónde prefieres que se lleve a cabo la revisión y cierre del crédito?\n\n";
  lugaresDisponibles.forEach((l, i) => {
    txt += `${i + 1}️⃣ ${l.nombre}\n📍 ${l.direccion}\n🌐 ${l.maps}\n\n`;
  });
  return txt.trim();
}
function fotoTipoLabel(n) {
  switch (String(n)) {
    case "1": return "exterior";
    case "2": return "interior";
    case "3": return "tablero (km)";
    case "4": return "placa";
    default: return null;
  }
}

// === GOOGLE SHEETS HELPERS ===
async function getAllLeads() {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${LEADS_SHEET}!A2:N`,
  });
  return resp.data.values || [];
}
async function findLeadByCelular(celular) {
  const rows = await getAllLeads();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if ((row[2] || "").trim() === celular) {
      return { rowIndex: i + 2, rowValues: row };
    }
  }
  return null;
}
async function appendLeadRow(values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${LEADS_SHEET}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}
async function updateLeadRow(rowIndex, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${LEADS_SHEET}!A${rowIndex}:N${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

// === FLUJO PRINCIPAL ===
const FOTO_REQUERIDAS = 4;

app.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const from = normalizePhone(body.From || "");
    const msgRaw = (body.Body || "").trim();
    const msg = msgRaw.toLowerCase();
    const mediaCount = parseInt(body.NumMedia || "0");

    if (!sessionState[from]) sessionState[from] = { step: 0, data: {}, completed: false, fotosMap: {} };
    const state = sessionState[from];

    // Comandos globales
    if (["menu","inicio","hola"].includes(msg)) {
      sessionState[from] = { step: 0, data: {}, completed: false, fotosMap: {} };
      const saludo =
        "👋 ¡Hola! Soy el asistente virtual de ACV.\n" +
        "Estoy aquí para ayudarte a solicitar tu crédito o resolver tus dudas.\n\n" +
        "¿Qué te gustaría hacer?\n" +
        "1️⃣ Iniciar solicitud\n" +
        "2️⃣ Conocer requisitos y tasas";
      return replyXml(res, saludo, LOBO_IMG);
    }
    if (["lugares","domicilios","dirección","direccion","ubicación","ubicacion"].includes(msg)) {
      return replyXml(res, renderLugaresMsg());
    }

    // === Manejo de imágenes ===
    if (mediaCount > 0) {
      if (state.step === 5) {
        const urls = [];
        for (let i = 0; i < mediaCount; i++) urls.push(body[`MediaUrl${i}`]);

        // Asignar etiquetas
        let i = 1;
        for (const url of urls) {
          if (!state.fotosMap[i]) {
            const label = fotoTipoLabel(i);
            state.fotosMap[i] = `${label} - ${url}`;
            i++;
          }
        }

        if (Object.keys(state.fotosMap).length >= FOTO_REQUERIDAS) {
          state.data["Fotos"] = Object.keys(state.fotosMap)
            .sort((a,b) => Number(a)-Number(b))
            .map(k => state.fotosMap[k]);
          state.step = 6;
          return replyXml(res, "📸 ¡Perfecto! Hemos recibido las 4 fotos de tu garantía.\n\n" +
            "Ahora cuéntame, ¿cómo te enteraste de nosotros?\n1️⃣ Facebook\n2️⃣ Instagram\n3️⃣ Referido\n4️⃣ Búsqueda orgánica\n5️⃣ Otro");
        }
        return replyXml(res, `Gracias, llevamos ${Object.keys(state.fotosMap).length}/${FOTO_REQUERIDAS} fotos.`);
      }
      return replyXml(res, "He recibido la imagen, pero aún no estamos en la etapa de fotos 😊");
    }

    // === Paso 0: Inicio ===
    if (state.step === 0) {
      const existing = await findLeadByCelular(from);
      if (existing && (existing.rowValues[8] || "").toLowerCase() !== "completado") {
        state.existingRowIndex = existing.rowIndex;
        state.step = -1;
        return replyXml(res, "Veo que ya tienes una solicitud pendiente 👀\n¿Deseas continuar donde la dejaste o empezar una nueva?\n1️⃣ Continuar\n2️⃣ Nueva solicitud");
      }
      state.step = 1;
      const saludo =
        "👋 ¡Hola! Soy el asistente virtual de ACV.\n" +
        "Estoy aquí para ayudarte a solicitar tu crédito o resolver tus dudas.\n\n" +
        "¿Qué te gustaría hacer?\n" +
        "1️⃣ Iniciar solicitud\n" +
        "2️⃣ Conocer requisitos y tasas";
      return replyXml(res, saludo, LOBO_IMG);
    }

    if (state.step === -1) {
      if (msg.startsWith("1")) {
        state.step = 2;
        return replyXml(res, "Perfecto. ¿Cuál es tu nombre completo?");
      }
      if (msg.startsWith("2")) {
        sessionState[from] = { step: 1, data: {}, completed: false, fotosMap: {} };
        return replyXml(res, "Comencemos una nueva solicitud:\n1️⃣ Iniciar solicitud\n2️⃣ Información general");
      }
      return replyXml(res, "Responde 1 para continuar o 2 para nueva solicitud.");
    }

    // === Paso 1: menú ===
    if (state.step === 1) {
      if (msg === "1") { state.step = 2; return replyXml(res, "¿Cuál es tu nombre completo?"); }
      if (msg === "2") {
        return replyXml(res,
          "💰 Tasa: 3.99% mensual sin comisión.\n📅 Plazo: Desde 3 meses, sin penalización.\n📋 Requisitos: Documentación básica y avalúo físico.\n\n¿Deseas iniciar tu solicitud? (Sí o No)");
      }
      return replyXml(res, "Elige una opción:\n1️⃣ Iniciar solicitud\n2️⃣ Conocer requisitos y tasas");
    }

    // === Paso 2: nombre ===
    if (state.step === 2) {
      state.data["Cliente"] = msgRaw;
      state.step = 3;
      return replyXml(res, `Gracias ${msgRaw} 👋 ¿Cuál es el monto que deseas solicitar?\n(Ejemplo: 250000 o $250,000)`);
    }

    // === Paso 3: monto ===
    if (state.step === 3) {
      const fmt = currencyMXN(msgRaw);
      if (!fmt) return replyXml(res, "Por favor indica el monto en pesos 💰 (Ejemplo: 250000 o $250,000)");
      state.data["Monto solicitado"] = fmt;
      state.step = 4;
      return replyXml(res, `Monto registrado: ${fmt}\n\n¿Qué tienes para dejar en garantía?\n1️⃣ Auto / Camión\n2️⃣ Maquinaria pesada\n3️⃣ Reloj de alta gama`);
    }

    // === Paso 4: garantía ===
    if (state.step === 4) {
      state.data["Garantía"] =
        msg.startsWith("1") ? "Auto" :
        msg.startsWith("2") ? "Maquinaria" :
        msg.startsWith("3") ? "Reloj" : msgRaw;
      state.step = 5;
      return replyXml(res, "Por favor envía las siguientes 4 fotos de tu garantía:\n1️⃣ Exterior\n2️⃣ Interior\n3️⃣ Tablero (km)\n4️⃣ Placa\n\nPuedes enviarlas todas juntas o una por una.");
    }

    // === Paso 6: procedencia ===
    if (state.step === 6) {
      const map = { "1": "Facebook", "2": "Instagram", "3": "Referido", "4": "Búsqueda orgánica", "5": "Otro" };
      state.data["Procedencia del lead"] = map[msg] || msgRaw;
      state.step = 7;
      return replyXml(res, "¿En qué estado de la República te encuentras?");
    }

    // === Paso 7: estado ===
    if (state.step === 7) {
      state.data["Ubicación"] = msgRaw;
      state.step = 8;
      return replyXml(res, "¿Cuándo te gustaría agendar tu cita? (Ejemplo: lunes 10am o 3 noviembre 3:30pm)");
    }

    // === Paso 8: cita ===
    if (state.step === 8) {
      const fecha = parseCitaES(msgRaw);
      if (!fecha) return replyXml(res, "No entendí la fecha 😅 Ejemplo: lunes 10am o 3 noviembre 3:30pm");
      state.data["Cita"] = fecha.toLocaleString("es-MX");
      state.step = 9;
      return replyXml(res, `✅ Cita registrada: ${state.data["Cita"]}\n\n${renderLugaresMsg()}`);
    }

    // === Paso 9: lugar ===
    if (state.step === 9) {
      let elegido = null;
      if (/^\d+$/.test(msg)) elegido = lugaresDisponibles[Number(msg) - 1];
      if (!elegido) elegido = lugaresDisponibles.find(l => l.nombre.toLowerCase().includes(msg));
      if (!elegido) return replyXml(res, "No identifiqué ese lugar 😅, responde con el número o parte del nombre.");
      state.data["Lugar"] = elegido.nombre;
      state.step = 10;
      const fotosCount = (state.data["Fotos"] || []).length;
      const resumen =
        "✅ Resumen de tu solicitud:\n\n" +
        `👤 ${state.data["Cliente"]}\n💰 ${state.data["Monto solicitado"]}\n🔒 ${state.data["Garantía"]}\n📍 ${state.data["Ubicación"]}\n🌐 ${state.data["Procedencia del lead"]}\n📸 Fotos: ${fotosCount}\n📅 Cita: ${state.data["Cita"]}\n🏢 Lugar: ${state.data["Lugar"]}\n\n¿Todo correcto? (Sí / No)`;
      return replyXml(res, resumen);
    }

    // === Paso 10: confirmación y guardado ===
    if (state.step === 10 && isAffirmative(msg)) {
      state.data["Fecha contacto"] = nowMX();
      state.data["Responsable"] = "Bot ACV";
      state.data["Etapa del cliente"] = "Completado";

      // --- CORRECCIÓN: Guardar fotos como HIPERVÍNCULOS ---
      const fotosFormateadas = (state.data["Fotos"] || [])
        .map(f => {
          const [label, url] = f.split(" - ");
          if (!url) return f;
          return `=HYPERLINK("${url}","${label}")`;
        })
        .join("\n");

      const fila = [
        state.data["Fecha contacto"],
        state.data["Cliente"],
        from,
        state.data["Monto solicitado"],
        state.data["Garantía"],
        state.data["Procedencia del lead"],
        state.data["Ubicación"],
        state.data["Lugar"],
        state.data["Etapa del cliente"],
        state.data["Cita"],
        state.data["Responsable"],
        fotosFormateadas,
        "Pendiente",
        ""
      ];

      const existing = await findLeadByCelular(from);
      if (existing && (existing.rowValues[8] || "").toLowerCase() !== "completado") {
        await updateLeadRow(existing.rowIndex, fila);
      } else if (!existing) {
        await appendLeadRow(fila);
      }

      state.completed = true;
      return replyXml(res, "✅ Tu solicitud ha sido registrada correctamente. Un asesor te contactará pronto. ¡Gracias por confiar en ACV!");
    }

    if (state.step === 10 && isNegative(msg)) {
      return replyXml(res, "Entendido 👍 Puedes escribir *menu* para empezar de nuevo o decirme qué deseas corregir.");
    }

    return replyXml(res, "Perdón, no entendí eso 😅. Escribe *menu* o *ayuda* si lo necesitas.");
  } catch (err) {
    console.error("❌ Error en webhook:", err);
    return replyXml(res, "Ocurrió un error temporal. Por favor intenta nuevamente 🙏");
  }
});

// === HEALTH CHECK ===
app.get("/", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("✅ LeadBot ACV operativo.");
});

app.listen(PORT, () => {
  console.log(`🚀 LeadBot ACV ejecutándose en el puerto ${PORT}`);
});
