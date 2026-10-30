/* FenceCSV — in-browser document extraction engine.
 * Runs 100% client-side: the visitor's file is never uploaded (there is no server).
 * Parsers implement the Money Lab fulfillment-kit column discipline:
 * fields are transcribed as printed, computed totals are cross-checked against
 * printed totals, and mismatches are flagged in the output — never silently fixed. */
(function () {
  'use strict';
  var CFG = window.FENCE || { mode: 'invoice', doc: 'document' };

  var MONEY_RE = /(?<![\d.,])-?[$€£]?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?!\d)|(?<![\d.,])-?[$€£]\s?(?:\d{1,3}(?:,\d{3})+|\d+)\b/g;
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function moneyVal(tok) {
    if (!tok) return null;
    var neg = /^-/.test(tok.trim()) || /^\(/.test(tok.trim());
    var v = parseFloat(tok.replace(/[^0-9.]/g, ''));
    if (isNaN(v)) return null;
    return neg ? -v : v;
  }
  function moneyTokens(line) {
    var out = [], m;
    MONEY_RE.lastIndex = 0;
    while ((m = MONEY_RE.exec(line)) !== null) {
      var v = moneyVal(m[0]);
      if (v !== null) out.push({ raw: m[0], value: v, index: m.index, end: m.index + m[0].length });
    }
    return out;
  }
  function fmt(n) { return (Math.round(n * 100) / 100).toFixed(2); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function normalizeDate(s) {
    if (!s) return '';
    var m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
    if (m) {
      var y = parseInt(m[3], 10); if (y < 100) y += 2000;
      return y + '-' + pad2(parseInt(m[1], 10)) + '-' + pad2(parseInt(m[2], 10));
    }
    m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
      return m[3] + '-' + pad2(MONTHS[m[2].slice(0, 3).toLowerCase()]) + '-' + pad2(parseInt(m[1], 10));
    }
    m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
      return m[3] + '-' + pad2(MONTHS[m[1].slice(0, 3).toLowerCase()]) + '-' + pad2(parseInt(m[2], 10));
    }
    return '';
  }
  function findDate(text) {
    var m = text.match(/\d{4}-\d{2}-\d{2}/) || text.match(/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/) ||
            text.match(/\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}/) || text.match(/[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}/);
    return m ? normalizeDate(m[0]) : '';
  }

  /* ---------------- invoice mode ---------------- */
  function parseInvoice(lines, sourceFile) {
    var text = lines.join('\n');
    var invNo = '';
    var mInv = text.match(/invoice\s*(?:#|no\.?|number|num)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/\.]*)/i);
    if (mInv && !/^(date|total|to|from)$/i.test(mInv[1])) invNo = mInv[1].replace(/[\.,]$/, '');
    var date = findDate(text);
    var currency = '';
    if (/\$/.test(text)) currency = 'USD'; else if (/€/.test(text)) currency = 'EUR'; else if (/£/.test(text)) currency = 'GBP';
    var vendor = '';
    for (var i = 0; i < Math.min(lines.length, 4); i++) {
      var L = lines[i].trim();
      if (L.length >= 3 && !/invoice/i.test(L) && !findDate(L)) { vendor = L; break; }
    }

    var tax = null, shipping = null, printedTotal = null, items = [];
    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var toks = moneyTokens(line);
      if (!toks.length) return;
      var last = toks[toks.length - 1];
      var lower = line.toLowerCase();
      if (/subtotal/.test(lower)) return;
      if (/(sales\s+tax|\btax\b|\bvat\b|\bgst\b|\bhst\b)/.test(lower) && tax === null) { tax = last.value; return; }
      if (/(shipping|freight|delivery)/.test(lower) && shipping === null && !/address/.test(lower)) { shipping = last.value; return; }
      if (/(grand\s+total|total\s+due|amount\s+due|balance\s+due|^total\b|total\s*:)/.test(lower)) { printedTotal = last.value; return; }
      if (/^(description|item|qty|quantity|unit|amount|price)\b/.test(lower)) return;
      /* candidate line item: line ends with the money token */
      if (line.slice(last.end).trim().length > 0) return;
      var rest = line.slice(0, last.index).replace(/[$€£,]\s*$/, '').trim();
      var nums = [], nm, numRe = /\d+(?:\.\d+)?/g;
      while ((nm = numRe.exec(rest)) !== null) nums.push({ raw: nm[0], value: parseFloat(nm[0]), index: nm.index, end: nm.index + nm[0].length });
      var qty = '', unit = '', desc = rest, conf = 'Medium';
      if (nums.length >= 2) {
        var q = nums[nums.length - 2], u = nums[nums.length - 1];
        if (q.value === Math.floor(q.value) && q.value > 0 && q.value < 100000) {
          qty = q.raw; unit = fmt(u.value);
          desc = (rest.slice(0, q.index) + rest.slice(u.end)).replace(/\s{2,}/g, ' ').replace(/[\s\-–·x]+$/i, '').trim();
          conf = Math.abs(q.value * u.value - last.value) <= 0.011 ? 'High' : 'Check: qty x price != line total';
        }
      } else if (nums.length === 1) {
        var only = nums[0];
        desc = (rest.slice(0, only.index) + rest.slice(only.end)).replace(/\s{2,}/g, ' ').trim();
      }
      desc = desc.replace(/[$€£]\s*$/, '').trim();
      if (desc.length < 2) return;
      items.push({
        Date: date, Vendor: vendor, Invoice_No: invNo, Description: desc,
        Qty: qty, Unit_Price: unit, Line_Total: fmt(last.value), Tax: '', Total: '',
        Currency: currency, Source_File: sourceFile, Confidence: conf, Notes: ''
      });
    });

    var rows = items.slice();
    var computed = items.reduce(function (s, r) { return s + parseFloat(r.Line_Total); }, 0);
    if (tax !== null) {
      rows.push({ Date: date, Vendor: vendor, Invoice_No: invNo, Description: 'INVOICE-LEVEL: Tax', Qty: '', Unit_Price: '', Line_Total: '', Tax: fmt(tax), Total: '', Currency: currency, Source_File: sourceFile, Confidence: 'High', Notes: '' });
      computed += tax;
    }
    if (shipping !== null) {
      rows.push({ Date: date, Vendor: vendor, Invoice_No: invNo, Description: 'INVOICE-LEVEL: Shipping', Qty: '', Unit_Price: '', Line_Total: fmt(shipping), Tax: '', Total: '', Currency: currency, Source_File: sourceFile, Confidence: 'High', Notes: '' });
      computed += shipping;
    }
    var verification;
    if (!items.length) {
      verification = { status: 'no-items', message: 'No line items were detected in this document. The generic table output is shown instead — check the preview before downloading.' };
    } else if (printedTotal === null) {
      verification = { status: 'no-total', computed: fmt(computed), message: 'Line items extracted. No printed grand total was found on the document, so the totals cross-check could not run. Computed total of extracted lines: ' + fmt(computed) + '.' };
    } else if (Math.abs(printedTotal - computed) > 0.01) {
      verification = { status: 'mismatch', computed: fmt(computed), printed: fmt(printedTotal), message: '⚠ TOTAL MISMATCH FLAGGED — the extracted lines add up to ' + fmt(computed) + ' but the document prints ' + fmt(printedTotal) + ' (difference ' + fmt(Math.abs(printedTotal - computed)) + '). Both figures are in the output. Nothing was silently corrected.' };
    } else {
      verification = { status: 'ok', computed: fmt(computed), printed: fmt(printedTotal), message: '✓ Totals reconcile — the extracted lines add up to the printed total of ' + fmt(printedTotal) + '.' };
    }
    if (items.length) {
      rows.push({ Date: date, Vendor: vendor, Invoice_No: invNo, Description: 'INVOICE TOTAL (computed)', Qty: '', Unit_Price: '', Line_Total: '', Tax: '', Total: fmt(computed), Currency: currency, Source_File: sourceFile, Confidence: '', Notes: '' });
      if (printedTotal !== null) {
        rows.push({ Date: date, Vendor: vendor, Invoice_No: invNo, Description: 'INVOICE TOTAL (as printed)', Qty: '', Unit_Price: '', Line_Total: '', Tax: '', Total: fmt(printedTotal), Currency: currency, Source_File: sourceFile, Confidence: '', Notes: verification.status === 'mismatch' ? 'MISMATCH ' + fmt(Math.abs(printedTotal - computed)) + ' — flagged, not corrected' : 'Reconciles with computed total' });
      }
      if (!invNo) {
        rows.forEach(function (r) { if (!r.Notes) r.Notes = ''; });
        rows[0].Notes = (rows[0].Notes ? rows[0].Notes + ' ' : '') + 'Invoice_No not legible on the document — left blank, never invented.';
      }
    }
    var headers = ['Date', 'Vendor', 'Invoice_No', 'Description', 'Qty', 'Unit_Price', 'Line_Total', 'Tax', 'Total', 'Currency', 'Source_File', 'Confidence', 'Notes'];
    return { headers: headers, rows: rows, verification: verification, fallbackGeneric: !items.length };
  }

  /* ---------------- statement mode ---------------- */
  function parseStatement(lines, sourceFile) {
    var rows = [];
    var dateStart = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/;
    lines.forEach(function (raw) {
      var line = raw.trim();
      var dm = line.match(dateStart);
      if (!dm) return;
      var rest = line.slice(dm[0].length).trim();
      var toks = moneyTokens(rest);
      if (!toks.length) return;
      var amount = '', balance = '', desc = rest;
      if (toks.length >= 2) {
        var a = toks[toks.length - 2], b = toks[toks.length - 1];
        amount = fmt(a.value); balance = fmt(b.value);
        desc = (rest.slice(0, a.index) + rest.slice(b.end)).replace(/\s{2,}/g, ' ').trim();
      } else {
        var t = toks[0];
        amount = fmt(t.value);
        desc = (rest.slice(0, t.index) + rest.slice(t.end)).replace(/\s{2,}/g, ' ').trim();
      }
      if (desc.length < 1) desc = '(no description printed)';
      rows.push({ Date: normalizeDate(dm[0]) || dm[0], Description: desc, Amount: amount, Balance: balance, Source_File: sourceFile });
    });
    var verification = rows.length
      ? { status: 'ok', message: '✓ ' + rows.length + ' transaction rows extracted. Signs and balances are transcribed exactly as printed — verify one or two against the statement before importing.' }
      : { status: 'no-items', message: 'No date-led transaction lines were detected. The generic table output is shown instead.' };
    return { headers: ['Date', 'Description', 'Amount', 'Balance', 'Source_File'], rows: rows, verification: verification, fallbackGeneric: !rows.length };
  }

  /* ---------------- generic mode ---------------- */
  function parseGeneric(lines, sourceFile) {
    var cellRows = [], maxCols = 0;
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (!line.trim()) return;
      var cells = line.split(/\s{2,}|\t/).map(function (c) { return c.trim(); }).filter(function (c) { return c.length; });
      if (cells.length >= 2) { cellRows.push(cells); if (cells.length > maxCols) maxCols = cells.length; }
      else {
        var toks = moneyTokens(line);
        if (toks.length) {
          var t = toks[toks.length - 1];
          var head = line.slice(0, t.index).trim();
          if (head) { cellRows.push([head, t.raw]); if (2 > maxCols) maxCols = 2; }
        }
      }
    });
    var headers = [];
    for (var i = 0; i < maxCols; i++) headers.push('Column_' + (i + 1));
    headers.push('Source_File');
    var rows = cellRows.map(function (cells) {
      var r = {};
      headers.forEach(function (h, idx) { r[h] = idx === headers.length - 1 ? sourceFile : (cells[idx] || ''); });
      return r;
    });
    var verification = rows.length
      ? { status: 'ok', message: '✓ ' + rows.length + ' table rows reconstructed from the text layer. Preview before downloading — PDFs that store text out of order can jumble rows, and this tool will not pretend otherwise.' }
      : { status: 'no-items', message: 'No table structure was detected in this document.' };
    return { headers: headers, rows: rows, verification: verification, fallbackGeneric: false };
  }

  function parse(lines, sourceFile) {
    var clean = lines.map(function (l) { return l.replace(/\s+$/, ''); }).filter(function (l) { return l.trim().length; });
    var res;
    if (CFG.mode === 'statement') res = parseStatement(clean, sourceFile);
    else if (CFG.mode === 'generic') res = parseGeneric(clean, sourceFile);
    else res = parseInvoice(clean, sourceFile);
    if (res.fallbackGeneric && CFG.mode !== 'generic') {
      var g = parseGeneric(clean, sourceFile);
      g.verification = res.verification;
      return g;
    }
    return res;
  }

  /* ---------------- PDF reading (pdf.js, CDN, lazy) ---------------- */
  function linesFromPdfItems(pages) {
    var all = [];
    pages.forEach(function (items) {
      var sorted = items.slice().sort(function (a, b) {
        if (Math.abs(a.y - b.y) > 3) return b.y - a.y;
        return a.x - b.x;
      });
      var cur = null;
      sorted.forEach(function (it) {
        if (!cur || Math.abs(it.y - cur.y) > 3) { cur = { y: it.y, parts: [] }; all.push(cur); }
        cur.parts.push(it);
      });
    });
    return all.map(function (line) {
      var parts = line.parts.sort(function (a, b) { return a.x - b.x; });
      var s = '', lastEnd = null;
      parts.forEach(function (p) {
        if (lastEnd !== null) {
          var gap = p.x - lastEnd;
          s += gap > 14 ? '  ' : ' ';
        }
        s += p.str;
        lastEnd = p.x + (p.w || p.str.length * 5);
      });
      return s;
    });
  }

  function readPdf(file) {
    return import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/build/pdf.min.mjs').then(function (pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/build/pdf.worker.min.mjs';
      return file.arrayBuffer().then(function (buf) { return pdfjsLib.getDocument({ data: buf }).promise; })
        .then(function (pdf) {
          var pagePromises = [];
          for (var p = 1; p <= pdf.numPages; p++) {
            pagePromises.push(pdf.getPage(p).then(function (page) {
              return page.getTextContent().then(function (tc) {
                return tc.items.map(function (it) {
                  return { str: it.str, x: it.transform[4], y: it.transform[5], w: it.width };
                });
              });
            }));
          }
          return Promise.all(pagePromises);
        })
        .then(function (pages) { return linesFromPdfItems(pages); });
    });
  }

  /* ---------------- OCR (Tesseract.js, CDN, lazy — v1.1 tranche 1) ----------------
   * Runs only when a file has no usable text layer (scanned PDF) or is an image.
   * Still 100% client-side: Tesseract.js executes in the visitor's browser and
   * the image never leaves the device — the privacy architecture is unchanged.
   * OCR text is fed to the SAME parsers and the SAME verification pass; the
   * banner says OCR was used so the preview gets the extra check it deserves. */
  var tesseractPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js';
      s.onload = function () { window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR engine loaded without its API')); };
      s.onerror = function () { reject(new Error('the OCR engine could not be loaded (network required for the first OCR use)')); };
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }
  function ocrRecognize(source, label) {
    return loadTesseract().then(function (T) {
      return T.recognize(source, 'eng', {
        logger: function (m) {
          if (m && m.status === 'recognizing text') setStatus('OCR running in your browser on ' + label + ' — ' + Math.round((m.progress || 0) * 100) + '% …');
        }
      });
    }).then(function (res) { return (res && res.data && res.data.text) || ''; });
  }
  function ocrImageFile(file) {
    return ocrRecognize(file, file.name);
  }
  function ocrPdfFile(file) {
    return import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/build/pdf.min.mjs').then(function (pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/build/pdf.worker.min.mjs';
      return file.arrayBuffer().then(function (buf) { return pdfjsLib.getDocument({ data: buf }).promise; })
        .then(function (pdf) {
          var maxPages = Math.min(pdf.numPages, 10);
          var chain = Promise.resolve([]);
          var renderPage = function (p) {
            return pdf.getPage(p).then(function (page) {
              var viewport = page.getViewport({ scale: 2 });
              var canvas = document.createElement('canvas');
              canvas.width = viewport.width; canvas.height = viewport.height;
              var ctx = canvas.getContext('2d');
              return page.render({ canvas: canvas, canvasContext: ctx, viewport: viewport }).promise.then(function () { return canvas; });
            }).then(function (canvas) {
              return ocrRecognize(canvas, file.name + ' (page ' + p + ' of ' + maxPages + ')');
            });
          };
          for (var p = 1; p <= maxPages; p++) {
            (function (pageNo) {
              chain = chain.then(function (texts) { return renderPage(pageNo).then(function (t) { texts.push(t); return texts; }); });
            })(p);
          }
          return chain.then(function (texts) {
            if (pdf.numPages > maxPages) texts.push('[OCR note: only the first ' + maxPages + ' pages were read — the free tool caps OCR at ' + maxPages + ' pages; the Verified Batch service below has no such cap.]');
            return texts.join('\n');
          });
        });
    });
  }
  function runOcrText(text, sourceName) {
    var lines = String(text || '').split(/\r?\n/);
    if (lines.join('').trim().length < 20) {
      setStatus('OCR found too little legible text in ' + sourceName + '. A flatter, sharper, well-lit scan may work — or the Verified Batch service below can read it. Nothing was uploaded; the attempt happened entirely in your browser.', true);
      return;
    }
    run(lines, sourceName + ' (via in-browser OCR — check the preview closely)');
  }

  /* ---------------- output ---------------- */
  function csvEscape(v) {
    v = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function toCSV(res) {
    var lines = [res.headers.map(csvEscape).join(',')];
    res.rows.forEach(function (r) {
      lines.push(res.headers.map(function (h) { return csvEscape(r[h]); }).join(','));
    });
    return lines.join('\r\n');
  }

  /* ---------------- UI ---------------- */
  var state = { result: null, fileName: 'document' };
  function $(id) { return document.getElementById(id); }
  function setStatus(msg, isErr) {
    var el = $('fence-status');
    el.textContent = msg || '';
    el.className = 'status' + (isErr ? ' err' : '');
  }
  function render(res) {
    state.result = res;
    var v = $('fence-verify');
    v.style.display = 'block';
    v.className = 'verify ' + (res.verification.status === 'mismatch' ? 'warn' : res.verification.status === 'ok' ? 'ok' : 'info');
    v.textContent = res.verification.message;
    var wrap = $('fence-tablewrap');
    if (!res.rows.length) { wrap.innerHTML = '<p>No rows to show.</p>'; $('fence-actions').style.display = 'none'; return; }
    var html = '<table><thead><tr>' + res.headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    res.rows.slice(0, 500).forEach(function (r) {
      html += '<tr>' + res.headers.map(function (h) { return '<td>' + String(r[h] === undefined ? '' : r[h]).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td>'; }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    if (res.rows.length > 500) html += '<p>Preview shows the first 500 rows; the CSV contains all ' + res.rows.length + '.</p>';
    wrap.innerHTML = html;
    $('fence-actions').style.display = 'block';
  }
  function run(lines, sourceName) {
    try {
      var res = parse(lines, sourceName);
      render(res);
      var chars = lines.join('').length;
      if (chars < 20) {
        setStatus('This document produced almost no readable text, even after the OCR attempt where one applies. See the options below the tool.', true);
      } else {
        setStatus('Done — ' + res.rows.length + ' rows extracted from ' + sourceName + ', entirely in your browser.');
      }
    } catch (e) {
      setStatus('Something went wrong reading that document: ' + e.message, true);
    }
  }
  function handleFile(file) {
    if (!file) return;
    state.fileName = file.name;
    setStatus('Reading ' + file.name + ' in your browser…');
    var name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) {
      readPdf(file).then(function (lines) {
          if (lines.join('').trim().length >= 50) { run(lines, file.name); return; }
          setStatus('No text layer in ' + file.name + ' — this looks like a scan, so OCR is running in your browser instead. Nothing is uploaded; OCR is slower than a text layer…');
          return ocrPdfFile(file).then(function (text) { runOcrText(text, file.name); });
        })
        .catch(function (e) { setStatus('Could not read that PDF (' + e.message + '). The Verified Batch service below can handle files this tool cannot.', true); });
    } else if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name)) {
      setStatus('Reading ' + file.name + ' with OCR in your browser — nothing is uploaded; this takes a few seconds…');
      ocrImageFile(file).then(function (text) { runOcrText(text, file.name); })
        .catch(function (e) { setStatus('OCR could not read that image (' + e.message + '). A flatter, sharper photo may work — or the batch service below can.', true); });
    } else {
      file.text().then(function (t) { run(t.split(/\r?\n/), file.name); })
        .catch(function (e) { setStatus('Could not read that file: ' + e.message, true); });
    }
  }

  if (typeof window !== 'undefined' && window.FENCE_TEST) { window.__fenceParse = parse; }
  document.addEventListener('DOMContentLoaded', function () {
    var drop = $('fence-drop'), input = $('fence-file');
    drop.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { handleFile(input.files[0]); });
    ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { handleFile(e.dataTransfer.files[0]); });
    $('fence-paste-btn').addEventListener('click', function () {
      var t = $('fence-paste').value;
      if (t.trim().length) run(t.split(/\r?\n/), 'pasted-text');
      else setStatus('Paste some document text first — or try the sample.', true);
    });
    $('fence-sample-btn').addEventListener('click', function () {
      if (window.FENCE_SAMPLE) { setStatus('Sample invoice loaded — watch the verification banner: its printed total is wrong on purpose.'); run(window.FENCE_SAMPLE.split('\n'), 'sample-invoice.txt'); }
    });
    $('fence-download').addEventListener('click', function () {
      if (!state.result) return;
      var blob = new Blob([toCSV(state.result)], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = state.fileName.replace(/\.[^.]+$/, '') + '-extracted.csv';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    });
    $('fence-copy').addEventListener('click', function () {
      if (!state.result) return;
      var tsv = state.result.headers.join('\t') + '\n' + state.result.rows.map(function (r) {
        return state.result.headers.map(function (h) { return r[h] === undefined ? '' : r[h]; }).join('\t');
      }).join('\n');
      navigator.clipboard.writeText(tsv).then(function () { setStatus('Copied as tab-separated rows — paste straight into Excel or Google Sheets.'); });
    });
  });
})();
