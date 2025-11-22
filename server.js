import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import { create } from "xmlbuilder2";
import * as chrono from "chrono-node";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const SHEET_ID = "1OGtZIFiEZWI8Tws1X_tZyEfgiEnVNlGcJay-Dg6-N_o";

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
const sessionState = {};

// === UTILIDAD XML SEGURA ===
function replyXml(res, message, mediaUrl = null) {
  const xmlObj = {
    Response: {
      Message: {
        Body: message || "",
        ...(mediaUrl ? { Media: mediaUrl } : {}),
      },
    },
  };
  const xml = create(xmlObj).end({ prettyPrint: false });
  console.log("📤 XML a Twilio:", xml);
  res
    .status(200)
    .set("Content-Type", "application/xml; charset=utf-8")
    .send(xml);
}

// === SHEETS HELPERS ===
async function getExistingLeads() {
  try {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Leads!A2:A", // A: Celular
    });
    return result.data.values ? result.data.values.flat() : [];
  } catch (err) {
    console.error("❌ Error obteniendo leads:", err);
    return [];
  }
}

async function appendLeadRow(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Leads!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [data] },
    });
    console.log("✅ Lead guardado:", data[1]);
  } catch (err) {
    console.error("❌ Error guardando Lead:", err);
  }
}

// === AUXILIARES ===
function formatCurrency(value) {
  const num = parseFloat((value || "").toString().replace(/[^0-9.]/g, ""));
  if (isNaN(num)) return value;
  return num.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
  });
}

function parseYear(text) {
  const match = (text || "").match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  return match ? parseInt(match[0], 10) : null;
}

function parseDateTime(text) {
  const result = chrono.parseDate(text, new Date(), { forwardDate: true });
  return result ? result.toLocaleString("es-MX") : null;
}

// Filtros de calificación – reglas simples
function isYearValid(tipo, year) {
  if (!year) return false;
  if (tipo === "Auto" || tipo === "Maquinaria") {
    return year >= 2010;
  }
  if (tipo === "Reloj") {
    return year >= 2000; // un poco más flexible
  }
  return false;
}

function parseAmount(text) {
  const num = parseFloat((text || "").replace(/[^0-9.]/g, ""));
  return isNaN(num) ? null : num;
}

function isAmountValid(tipo, amount) {
  if (!amount) return false;
  if (tipo === "Auto") {
    return amount >= 20000 && amount <= 2000000;
  }
  if (tipo === "Maquinaria") {
    return amount >= 100000 && amount <= 5000000;
  }
  if (tipo === "Reloj") {
    return amount >= 50000 && amount <= 500000;
  }
  return false;
}

function isAffirmative(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("si") ||
    t.includes("sí") ||
    t.includes("claro") ||
    t.includes("ok") ||
    t.includes("de acuerdo")
  );
}

function isNegative(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("no") ||
    t.includes("nel") ||
    t.includes("negativo")
  );
}

// === FLUJO PRINCIPAL ===
app.post("/", async (req, res) => {
  const body = req.body;
  const from = body.From || "";          // número de WhatsApp/SMS
  const msg = (body.Body || "").trim();
  const msgLower = msg.toLowerCase();
  const mediaCount = parseInt(body.NumMedia || "0", 10);

  console.log("📩 Mensaje recibido:", from, msg);

  // Inicializar estado de sesión
  if (!sessionState[from]) {
    sessionState[from] = { step: 0, data: {}, flow: null };
  }
  const state = sessionState[from];

  // === COMANDOS GLOBALES ===
  if (["menu", "inicio"].includes(msgLower)) {
    state.step = 1;
    state.flow = null;
    state.data = {};
    return replyXml(
      res,
      "👋 Hola, soy el asistente virtual de *ACV Financiera*.\n\n" +
        "¿En qué puedo ayudarte hoy?\n" +
        "1️⃣ Solicitar un crédito con garantía\n" +
        "2️⃣ Conocer requisitos\n" +
        "3️⃣ Hablar con un asesor"
    );
  }

  // === MANEJO DE FOTOS (para flujo de garantía) ===
  if (mediaCount > 0) {
    const urls = [];
    for (let i = 0; i < mediaCount; i++) {
      const url = body[`MediaUrl${i}`];
      if (url) urls.push(url);
    }
    state.data.fotos = (state.data.fotos || []).concat(urls);

    const total = state.data.fotos.length;
    if (state.flow === "lead_calificado" && state.step === 8) {
      if (total < 4) {
        return replyXml(
          res,
          `📸 Recibidas ${urls.length} foto(s). Llevo ${total} en total.\n` +
            "Por favor envía las 4 fotos (una por mensaje) como se indicó."
        );
      }
      // Ya tiene 4 o más fotos → cerrar y guardar
      state.data.etapa = "Completado";
      const row = [
        state.data.celular || from,
        state.data.nombre || "",
        state.data.tipoGarantia || "",
        state.data.anioGarantia || "",
        state.data.montoSolicitado || "",
        state.data.ubicacion || "",
        state.data.etapa || "Completado",
        state.data.fechaContacto || new Date().toLocaleString("es-MX"),
        state.data.responsable || "Bot ACV",
        (state.data.fotos || []).join("\n"),
      ];
      await appendLeadRow(row);
      delete sessionState[from];
      return replyXml(
        res,
        "✅ Perfecto, ya recibimos las fotos de tu garantía.\n" +
          "Tu solicitud ha sido registrada con éxito. Un asesor revisará tu información y te contactará muy pronto."
      );
    }

    // Si llega media fuera de contexto
    return replyXml(
      res,
      `📸 Recibidas ${urls.length} foto(s).\n` +
        "Si estás en un proceso de solicitud, por favor sigue las instrucciones anteriores."
    );
  }

  // === ESTADO 0 → Mostrar menú inicial ===
  if (state.step === 0) {
    state.step = 1;
    return replyXml(
      res,
      "👋 Hola, soy el asistente virtual de *ACV Financiera*.\n\n" +
        "¿En qué puedo ayudarte hoy?\n" +
        "1️⃣ Solicitar un crédito con garantía\n" +
        "2️⃣ Conocer requisitos\n" +
        "3️⃣ Hablar con un asesor"
    );
  }

  // === MENÚ PRINCIPAL (step 1) ===
  if (state.step === 1) {
    if (msgLower === "1" || msgLower.includes("crédito") || msgLower.includes("solicitud")) {
      // Anti-duplicado: evitar múltiples solicitudes desde el mismo número
      const existing = await getExistingLeads();
      if (existing.includes(from)) {
        return replyXml(
          res,
          "⚠️ Detectamos que ya tienes una solicitud registrada con este número.\n" +
            "Un asesor se pondrá en contacto contigo. Si necesitas algo más, responde *menu*."
        );
      }
      state.flow = "lead_calificado";
      state.step = 2;
      state.data = { celular: from };
      return replyXml(
        res,
        "Perfecto 👍\n" +
          "Primero, cuéntame qué tipo de bien tienes para dejar como garantía:\n" +
          "1️⃣ Auto o camión\n" +
          "2️⃣ Maquinaria pesada\n" +
          "3️⃣ Reloj de alta gama\n" +
          "4️⃣ Otro"
      );
    }

    if (msgLower === "2" || msgLower.includes("requisito") || msgLower.includes("información")) {
      state.flow = "requisitos";
      state.step = 10;
      return replyXml(
        res,
        "📋 *Requisitos generales para un crédito con garantía ACV:*\n\n" +
          "💼 Documentos del cliente:\n" +
          "- Identificación oficial vigente.\n" +
          "- Comprobante de domicilio reciente.\n" +
          "- Comprobante de ingresos o actividad.\n\n" +
          "🚗 Garantía:\n" +
          "- Auto, maquinaria o reloj en buenas condiciones.\n" +
          "- Documentos que acrediten propiedad.\n\n" +
          "💰 Condiciones:\n" +
          "- Tasa desde 3.99% mensual.\n" +
          "- Plazos flexibles.\n" +
          "- Sin penalización por pagos anticipados.\n\n" +
          "¿Te gustaría iniciar una solicitud ahora? (responde *Sí* o *No*)"
      );
    }

    if (msgLower === "3" || msgLower.includes("asesor") || msgLower.includes("humano")) {
      state.flow = "asesor";
      state.step = 20;
      return replyXml(
        res,
        "Con gusto te ponemos en contacto con un asesor 👨‍💼.\n\n" +
          "Por favor indícame tu nombre y la ciudad desde donde nos escribes."
      );
    }

    return replyXml(
      res,
      "No reconocí la opción.\n\n" +
        "Por favor responde:\n" +
        "1️⃣ Solicitar un crédito con garantía\n" +
        "2️⃣ Conocer requisitos\n" +
        "3️⃣ Hablar con un asesor"
    );
  }

  // === FLUJO 2: CONOCER REQUISITOS (step 10+) ===
  if (state.flow === "requisitos") {
    if (state.step === 10) {
      if (isAffirmative(msg)) {
        // redirigir al flujo 1 como nueva solicitud
        state.flow = "lead_calificado";
        state.step = 2;
        state.data = { celular: from };
        return replyXml(
          res,
          "Perfecto 🙌\n" +
            "Empecemos con tu solicitud.\n\n" +
            "¿Qué tipo de bien tienes para dejar como garantía?\n" +
            "1️⃣ Auto o camión\n" +
            "2️⃣ Maquinaria pesada\n" +
            "3️⃣ Reloj de alta gama\n" +
            "4️⃣ Otro"
        );
      }
      if (isNegative(msg)) {
        delete sessionState[from];
        return replyXml(
          res,
          "Gracias por tu interés en ACV 😊.\n" +
            "Si más adelante deseas iniciar una solicitud, solo escribe *crédito* o *menu*."
        );
      }
      return replyXml(
        res,
        "¿Te gustaría iniciar una solicitud ahora? (responde *Sí* o *No*)"
      );
    }
  }

  // === FLUJO 3: HABLAR CON UN ASESOR (step 20+) ===
  if (state.flow === "asesor") {
    if (state.step === 20) {
      // Guardar como lead para contacto humano
      state.data = state.data || {};
      state.data.celular = from;
      state.data.nombre = msg;
      state.data.fechaContacto = new Date().toLocaleString("es-MX");
      state.data.etapa = "Esperando contacto humano";
      state.data.responsable = "Asesor ACV";

      const row = [
        state.data.celular,
        state.data.nombre,
        "", // tipoGarantia
        "", // año
        "", // monto
        "", // ubicación
        state.data.etapa,
        "", // cita
        state.data.fechaContacto,
        state.data.responsable,
      ];
      await appendLeadRow(row);
      delete sessionState[from];

      return replyXml(
        res,
        "✅ Gracias, hemos registrado tu solicitud para hablar con un asesor.\n" +
          "En breve alguien de nuestro equipo se pondrá en contacto contigo."
      );
    }
  }

  // === FLUJO 1: LEAD CALIFICADO (step 2–8) ===
  if (state.flow === "lead_calificado") {
    // Paso 2 – Tipo de garantía
    if (state.step === 2) {
      let tipo = "";
      if (msg.startsWith("1")) tipo = "Auto";
      else if (msg.startsWith("2")) tipo = "Maquinaria";
      else if (msg.startsWith("3")) tipo = "Reloj";
      else if (msg.startsWith("4")) tipo = "Otro";
      else tipo = msg;

      if (tipo === "Otro") {
        delete sessionState[from];
        return replyXml(
          res,
          "Por el momento solo operamos con autos, maquinaria o relojes de alta gama.\n" +
            "Gracias por tu interés en ACV 🙏."
        );
      }

      if (!["Auto", "Maquinaria", "Reloj"].includes(tipo)) {
        return replyXml(
          res,
          "No reconocí el tipo de garantía.\n" +
            "Por favor elige una opción:\n" +
            "1️⃣ Auto o camión\n" +
            "2️⃣ Maquinaria pesada\n" +
            "3️⃣ Reloj de alta gama\n" +
            "4️⃣ Otro"
        );
      }

      state.data.tipoGarantia = tipo;
      state.step = 3;
      return replyXml(
        res,
        "¿De qué año es tu unidad o equipo? (Ejemplo: 2018, 2020...)"
      );
    }

    // Paso 3 – Año del bien
    if (state.step === 3) {
      const anio = parseYear(msg);
      if (!anio) {
        return replyXml(
          res,
          "No pude identificar el año.\n" +
            "Por favor indícalo en formato de 4 dígitos. Ejemplo: 2018, 2022."
        );
      }

      if (!isYearValid(state.data.tipoGarantia, anio)) {
        delete sessionState[from];
        return replyXml(
          res,
          `Lo sentimos, para este tipo de garantía trabajamos solo con unidades de modelos más recientes.\n` +
            "Gracias por tu tiempo 🙏."
        );
      }

      state.data.anioGarantia = anio;
      state.step = 4;
      return replyXml(
        res,
        "¿Cuánto dinero necesitas aproximadamente? 💰\n" +
          "Puedes responder con una cantidad, por ejemplo: 150000"
      );
    }

    // Paso 4 – Monto solicitado
    if (state.step === 4) {
      const montoNum = parseAmount(msg);
      if (!montoNum) {
        return replyXml(
          res,
          "No pude entender el monto.\n" +
            "Por favor indícalo solo con números. Ejemplo: 150000"
        );
      }

      if (!isAmountValid(state.data.tipoGarantia, montoNum)) {
        delete sessionState[from];
        return replyXml(
          res,
          "Por el momento no podemos ofrecer un crédito con ese monto para el tipo de garantía indicado.\n" +
            "Gracias por tu interés 🙏."
        );
      }

      state.data.montoSolicitado = formatCurrency(msg);
      state.step = 5;
      return replyXml(
        res,
        "¿Estás dispuesto a dejar tu garantía en resguardo durante el crédito? (responde *Sí* o *No*)"
      );
    }

    // Paso 5 – Disposición a resguardo
    if (state.step === 5) {
      if (isNegative(msg)) {
        delete sessionState[from];
        return replyXml(
          res,
          "Gracias por tu interés. Nuestros créditos requieren dejar la garantía en resguardo, por lo que no podríamos continuar con la solicitud 🙏."
        );
      }
      if (!isAffirmative(msg)) {
        return replyXml(
          res,
          "No me quedó claro.\n" +
            "Por favor responde *Sí* si estás dispuesto a dejar la garantía en resguardo, o *No* en caso contrario."
        );
      }

      state.step = 6;
      return replyXml(
        res,
        "Perfecto 🙌\n" +
          "Solo necesito algunos datos básicos.\n\n" +
          "¿Cuál es tu nombre completo?"
      );
    }

    // Paso 6 – Nombre
    if (state.step === 6) {
      state.data.nombre = msg;
      state.step = 7;
      return replyXml(
        res,
        "¿En qué ciudad o estado te encuentras?"
      );
    }

    // Paso 7 – Ubicación y guardado inicial del lead
    if (state.step === 7) {
      state.data.ubicacion = msg;
      state.data.fechaContacto = new Date().toLocaleString("es-MX");
      state.data.etapa = "Precalificado – pendiente de fotos";
      state.data.responsable = "Bot ACV";
      state.data.celular = state.data.celular || from;

      // Guardar lead precalificado sin fotos todavía
      const row = [
        state.data.celular,
        state.data.nombre,
        state.data.tipoGarantia,
        state.data.anioGarantia,
        state.data.montoSolicitado,
        state.data.ubicacion,
        state.data.etapa,
        state.data.fechaContacto,
        state.data.responsable,
        "", // fotos
      ];
      await appendLeadRow(row);

      state.step = 8;
      state.data.fotos = [];
      return replyXml(
        res,
        "Perfecto 🙌\n" +
          "Por último, envía 4 fotos de tu garantía (una por mensaje):\n" +
          "1️⃣ Exterior\n" +
          "2️⃣ Interior\n" +
          "3️⃣ Detalle identificativo (placa, serie o característica)\n" +
          "4️⃣ Vista general"
      );
    }

    // Paso 8 – Aquí se gestiona en el bloque de media (arriba)
  }

  // === RESPUESTA POR DEFECTO ===
  return replyXml(
    res,
    "No reconocí tu mensaje en el contexto actual.\n" +
      "Puedes escribir *menu* para volver al inicio."
  );
});

// Ruta de prueba
app.get("/", (req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send("✅ LeadBot ACV operativo – Flujo Lead Calificado.");
});

app.listen(PORT, () => {
  console.log(`🚀 LeadBot ACV ejecutándose en el puerto ${PORT}`);
});
