const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const axios = require('axios');
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- YOUR CONFIGURATION (loaded from .env) ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Initialize the Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// --- OUR "FAKE DATABASE" ---
// In a real startup, this would be MongoDB or PostgreSQL
const fakeDB = {};



// ==========================================
// 1. GENERATE THE GOOGLE LOGIN LINK
// ==========================================
app.get('/api/auth/url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [ // FIX: "scope" singular so Google doesn't block it
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  });
  res.json({ url });
});

// ==========================================
// 2. GOOGLE SENDS THE USER BACK HERE AFTER LOGIN
// ==========================================
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  try {
    // Exchange the code for the tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get the user's email address to identify them
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    // SAVE TO DATABASE: Save their refresh token next to their email
    if (tokens.refresh_token) {
      fakeDB[email] = tokens.refresh_token;
      console.log(`✅ Saved new user to DB: ${email}`);
    }

    // Redirect the user back to the frontend website
    res.redirect(`http://localhost:5500/index.html?userEmail=${email}`);
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).send("Authentication failed");
  }
});

// ==========================================
// 3. THE MAGIC ENDPOINT (Voice to Sheet)
// ==========================================
app.post('/api/update-task', async (req, res) => {
  let { email, spreadsheetId, spokenText } = req.body;

  // FIX: If the user pastes the full URL instead of the ID, extract just the ID!
  if (spreadsheetId && spreadsheetId.includes('/d/')) {
    spreadsheetId = spreadsheetId.split('/d/')[1].split('/')[0];
  }

  // Check if we know this user
  const userRefreshToken = fakeDB[email];
  if (!userRefreshToken) {
    return res.status(401).json({ success: false, error: "User not logged in or token expired. Please login again." });
  }

  try {
    console.log(`🎙️ Processing voice command: "${spokenText}"`);

    // 1. Send the text to OpenRouter (Llama 3.1 8B Free)
    const aiResponse = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: "poolside/laguna-m.1:free",
      messages: [{
        role: "system",
        content: `You manage a project tracker. Extract the Task Name and Status from the user's text. 
        Allowed statuses MUST ONLY BE: "Not Yet Started", "In Progress", "Complete", "On Hold".
        Return ONLY a raw JSON object: {"taskName": "extracted task", "status": "extracted status"}`
      }, {
        role: "user",
        content: spokenText
      }]
    }, {
      headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}` }
    });

    let jsonText = aiResponse.data.choices[0].message.content;
    jsonText = jsonText.replace(/```json/g, "").replace(/```/g, "").trim();
    const aiData = JSON.parse(jsonText);
    console.log("🤖 AI Extracted:", aiData);

    // 2. Connect to Google Sheets AS THE USER
    const userAuthClient = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    userAuthClient.setCredentials({ refresh_token: userRefreshToken });
    const sheets = google.sheets({ version: 'v4', auth: userAuthClient });

    // 3. FIX: GET THE EXACT TAB NAME DYNAMICALLY (So it doesn't break if it's not "Sheet1")
    const sheetMetadata = await sheets.spreadsheets.get({
      spreadsheetId: spreadsheetId,
    });
    const actualTabName = sheetMetadata.data.sheets[0].properties.title;

    // 4. Fetch the spreadsheet data using the real tab name
    const getRows = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: `'${actualTabName}'!A1:K100`,
    });

    const rows = getRows.data.values;
    let rowToUpdate = -1;

    // 5. Search for the task (Column G[6], I[8], J[9])
    // 5. SMARTER Search for the task (Column G[6], I[8], J[9])
    const aiTask = aiData.taskName.toLowerCase().trim();
    
    for (let i = 10; i < rows.length; i++) { // Start at Row 11
      if (!rows[i]) continue;
      
      let taskCol = rows[i][6] ? rows[i][6].toLowerCase().trim() : "";
      let descCol = rows[i][8] ? rows[i][8].toLowerCase().trim() : "";
      let delivCol = rows[i][9] ? rows[i][9].toLowerCase().trim() : "";

      // Condition 1: The Sheet contains the AI's exact phrase
      let normalMatch = (taskCol.includes(aiTask) || descCol.includes(aiTask) || delivCol.includes(aiTask));
      
      // Condition 2: The AI phrase contains the Sheet's phrase (e.g. AI: "UI mockups development", Sheet: "UI mockups")
      // We check length > 4 so we don't accidentally match tiny words or blank cells
      let reverseMatch = (taskCol.length > 4 && aiTask.includes(taskCol)) || 
                         (delivCol.length > 4 && aiTask.includes(delivCol));

      if (normalMatch || reverseMatch) {
        rowToUpdate = i + 1; // Google Sheets is 1-indexed
        break;
      }
    }

    if (rowToUpdate === -1) throw new Error(`Could not find task matching: "${aiData.taskName}"`);

    // 6. Update Status (Column B)
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: `'${actualTabName}'!B${rowToUpdate}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[aiData.status]] }
    });

    // 7. Update % Done (Column K) dynamically based on status
    let percentageValue = null;

    if (aiData.status === "Complete") {
      percentageValue = 1; // 1 equals 100% in Sheets
    } else if (aiData.status === "Not Yet Started") {
      percentageValue = 0; // 0 equals 0% in Sheets
    }

    // Only update the percentage column if it is Complete or Not Yet Started
    if (percentageValue !== null) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: `'${actualTabName}'!K${rowToUpdate}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[percentageValue]] } 
      });
    }

    res.json({ success: true, message: `Updated "${aiData.taskName}" to ${aiData.status}` });

  } catch (error) {
    console.log("=========================================");
    console.error("❌ CRASH DETAILS:");
    
    // If OpenRouter or Google Sheets sends a specific error message, this reveals it!
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else if (error.errors) {
      console.error(error.errors);
    } else {
      console.error(error.message);
    }
    console.log("=========================================");
    
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. TEXT-TO-SPEECH (Tracey's voice)
// ==========================================
app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata("en-US-AnaNeural", OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    const { audioStream } = tts.toStream(text);

    res.set({
      "Content-Type": "audio/webm",
      "Transfer-Encoding": "chunked"
    });

    audioStream.pipe(res);
  } catch (error) {
    console.error("TTS Error:", error);
    res.status(500).json({ error: "TTS generation failed" });
  }
});

app.listen(3000, () => console.log('✅ Backend Server running on http://localhost:3000'));