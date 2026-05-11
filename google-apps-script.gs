// ============================================================
//  BUSINESS MASTERMIND — Google Apps Script Backend
//  STEP-BY-STEP SETUP (takes ~5 minutes):
//
//  1. Go to sheets.google.com → create a NEW blank spreadsheet
//     Name it "Business Mastermind"
//
//  2. In the spreadsheet menu: Extensions → Apps Script
//     (a new tab opens with a code editor)
//
//  3. Delete ALL the existing code in the editor
//     then PASTE this entire file
//
//  4. Click "Deploy" → "New deployment"
//     - Type: "Web app"
//     - Execute as: "Me"
//     - Who has access: "Anyone"
//     Click "Deploy" → copy the URL it gives you
//
//  5. Open BusinessMastermind/app.js in a text editor
//     Find the line:  let SCRIPT_URL = '';
//     Replace it with: let SCRIPT_URL = 'PASTE_YOUR_URL_HERE';
//     Save app.js
//
//  Done! Now your web app and Google Sheet stay in sync.
//  Every entry you add in the web app appears in the Sheet.
//  Every row you add/edit/delete in the Sheet appears in the
//  web app when you click the ↻ Sync button (or on page load).
// ============================================================

const INCOME_HEADERS  = ['id','clientId','subClient','service','amount','vatAmount','paymentType','date','status','notes','createdAt'];
const EXPENSE_HEADERS = ['id','category','vendor','description','amount','vatAmount','paymentMethod','recurring','date','createdAt'];

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'getData';
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    ensureSheets(ss);

    if (action === 'getData') {
      const income   = sheetToObjects(ss.getSheetByName('Income'));
      const expenses = sheetToObjects(ss.getSheetByName('Expenses'));
      return respond({ income: income, expenses: expenses });
    }

    if (action === 'addIncome') {
      const entry = JSON.parse(decodeURIComponent(e.parameter.data || '{}'));
      const sheet = ss.getSheetByName('Income');
      sheet.appendRow(INCOME_HEADERS.map(function(h) {
        return entry[h] !== undefined ? entry[h] : '';
      }));
      return respond({ ok: true });
    }

    if (action === 'addExpense') {
      const entry = JSON.parse(decodeURIComponent(e.parameter.data || '{}'));
      const sheet = ss.getSheetByName('Expenses');
      sheet.appendRow(EXPENSE_HEADERS.map(function(h) {
        return entry[h] !== undefined ? entry[h] : '';
      }));
      return respond({ ok: true });
    }

    if (action === 'deleteIncome') {
      deleteById(ss.getSheetByName('Income'), e.parameter.id);
      return respond({ ok: true });
    }

    if (action === 'deleteExpense') {
      deleteById(ss.getSheetByName('Expenses'), e.parameter.id);
      return respond({ ok: true });
    }

    return respond({ error: 'Unknown action: ' + action });

  } catch (err) {
    return respond({ error: err.toString() });
  }
}

// ── Helpers ──────────────────────────────────────────────────

function sheetToObjects(sheet) {
  if (!sheet) return [];
  var range = sheet.getDataRange();
  var values = range.getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var result = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue; // skip empty rows
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[i][j];
    }
    result.push(obj);
  }
  return result;
}

function deleteById(sheet, id) {
  if (!sheet || !id) return;
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

function ensureSheets(ss) {
  if (!ss.getSheetByName('Income'))   createSheet(ss, 'Income',   INCOME_HEADERS);
  if (!ss.getSheetByName('Expenses')) createSheet(ss, 'Expenses', EXPENSE_HEADERS);
}

function createSheet(ss, name, headers) {
  var existing = ss.getSheetByName(name);
  if (existing) return existing;
  var sheet = ss.insertSheet(name);
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#1a1a2e')
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  return sheet;
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
