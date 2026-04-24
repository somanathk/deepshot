// Background service worker - handles all capture logic
// This persists even when the popup closes

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let lastCaptureTime = 0;
async function captureTab() {
  const now = Date.now();
  const elapsed = now - lastCaptureTime;
  if (elapsed < 550) {
    await sleep(550 - elapsed);
  }
  lastCaptureTime = Date.now();
  return chrome.tabs.captureVisibleTab(null, { format: 'png' });
}

function sendStatus(msg) {
  chrome.runtime.sendMessage({ type: 'status', msg }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'capture') {
    doCapture(msg.expandScrolls, msg.format, msg.mode).catch((err) => {
      sendStatus(`Error: ${err.message}`);
    });
    sendResponse({ ok: true });
  }
  return true;
});

async function doCapture(expandScrolls, format, mode) {
  sendStatus('Analyzing page...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    sendStatus('No active tab found');
    return;
  }

  try {
    // Step 1: Detect the page structure
    const [detectResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: detectPageStructure,
    });
    const info = detectResult.result;
    const dpr = info.dpr;

    let selection = null;
    if (mode === 'selection') {
      sendStatus('Drag a region on the page...');
      const [selResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: runSelectionOverlay,
      });
      selection = selResult && selResult.result;
      if (!selection) {
        sendStatus('Selection cancelled.');
        return;
      }
      expandScrolls = true;

      if (format === 'md') {
        await doMarkdownRegionCapture(tab, info, selection);
        return;
      }
    }

    if (!expandScrolls || info.innerScrollables.length === 0) {
      sendStatus('Simple capture...');
      await captureOuterOnly(tab, info, format, selection);
      return;
    }

    sendStatus(`Found ${info.innerScrollables.length} scrollable(s). Capturing...`);

    // Step 2: Capture the outer page
    const outerHeight = info.outerScrollable ? info.outerScrollable.scrollH : info.pageHeight;
    const outerViewH = info.outerScrollable ? info.outerScrollable.clientH : info.viewportHeight;
    const outerSteps = Math.ceil(outerHeight / outerViewH);

    const outerStrips = [];
    for (let i = 0; i < outerSteps; i++) {
      sendStatus(`Page: ${i + 1}/${outerSteps}`);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrollOuter,
        args: [i * outerViewH],
      });
      await sleep(100);
      const dataUrl = await captureTab();
      outerStrips.push({ dataUrl, scrollY: i * outerViewH });
    }

    // Step 3: Capture each inner scrollable
    const innerResults = [];

    for (let si = 0; si < info.innerScrollables.length; si++) {
      const inner = info.innerScrollables[si];
      sendStatus('Positioning table...');

      const [posResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: positionInnerInView,
        args: [si],
      });
      const pos = posResult.result;
      if (!pos) continue;

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: hideFixedElements,
        args: [si],
      });
      await sleep(100);

      const [pos2Result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: getMeasurements,
        args: [si],
      });
      const pos2 = pos2Result.result;

      const visibleW = pos2.clientW;
      const visibleH = pos2.clientH;
      const cropLeft = pos2.rect.left;
      const cropTop = pos2.rect.top;

      const vSteps = Math.ceil(inner.scrollH / visibleH);
      const hasHScroll = inner.scrollW > inner.clientW + 10;
      const hSteps = hasHScroll ? Math.ceil(inner.scrollW / visibleW) : 1;
      const totalSteps = vSteps * hSteps;
      let stepNum = 0;

      const strips = [];

      for (let vi = 0; vi < vSteps; vi++) {
        const vy = vi * visibleH;
        const actualVY = Math.min(vy, inner.scrollH - visibleH);

        for (let hi = 0; hi < hSteps; hi++) {
          const hx = hasHScroll ? hi * visibleW : 0;
          const actualHX = hasHScroll ? Math.min(hx, inner.scrollW - visibleW) : 0;

          stepNum++;
          sendStatus(`Table: ${stepNum}/${totalSteps}`);

          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: scrollInnerTo,
            args: [si, actualHX, actualVY],
          });
          await sleep(80);
          const dataUrl = await captureTab();

          strips.push({
            dataUrl,
            scrollX: actualHX,
            scrollY: actualVY,
            gridX: hi,
            gridY: vi,
            cropLeft: cropLeft * dpr,
            cropTop: cropTop * dpr,
            cropW: visibleW * dpr,
            cropH: visibleH * dpr,
          });
        }
      }

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrollInnerTo,
        args: [si, 0, 0],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: restoreFixedElements,
      });

      innerResults.push({
        index: si,
        outerScrollY: pos.outerScrollY,
        cropLeft,
        cropTop,
        visibleW,
        visibleH,
        totalW: inner.scrollW,
        totalH: inner.scrollH,
        vSteps,
        hSteps,
        strips,
      });
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollOuter,
      args: [0],
    });

    // Step 4: Stitch
    sendStatus('Stitching...');
    const pageW = info.viewportWidth;
    const cropRect = selection ? computeCropRect(selection, innerResults, dpr) : null;

    const [stitchResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: stitchFull,
      args: [outerStrips, innerResults, info, dpr, pageW, cropRect],
    });

    if (stitchResult.result) {
      await downloadResult(stitchResult.result, tab.title, tab, format, !!selection);
      sendStatus('Done! Screenshot saved.');
    } else {
      sendStatus('Stitching failed');
    }
  } catch (err) {
    sendStatus(`Error: ${err.message}`);
    console.error(err);
  }
}

async function captureOuterOnly(tab, info, format, selection) {
  const outerHeight = info.outerScrollable ? info.outerScrollable.scrollH : info.pageHeight;
  const outerViewH = info.outerScrollable ? info.outerScrollable.clientH : info.viewportHeight;
  const dpr = info.dpr;
  const steps = Math.ceil(outerHeight / outerViewH);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrollOuter,
    args: [0],
  });

  const strips = [];
  for (let i = 0; i < steps; i++) {
    sendStatus(`Capturing ${i + 1}/${steps}...`);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollOuter,
      args: [i * outerViewH],
    });
    await sleep(100);
    const dataUrl = await captureTab();
    strips.push({ dataUrl, scrollY: i * outerViewH });
  }

  sendStatus('Stitching...');
  const cropRect = selection ? computeCropRect(selection, [], dpr) : null;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: stitchSimple,
    args: [strips, outerHeight, info.viewportWidth, outerViewH, dpr, cropRect],
  });

  if (result.result) {
    await downloadResult(result.result, tab.title, tab, format, !!selection);
    sendStatus('Done!');
  }
}

async function doMarkdownRegionCapture(tab, info, selection) {
  const selPageRect = selection.pageRect;
  const originalOuterScrollY = selection.originalOuterScrollY || 0;

  try {
    // Reset outer scroll to 0 so DOM rects map directly to page coords.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollOuter,
      args: [0],
    });
    await sleep(150);

    const [rectsResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: getInnerScrollablePageRects,
    });
    const rects = rectsResult.result || [];

    const scrollInfo = info.innerScrollables.map((ir) => ({
      scrollH: ir.scrollH,
      clientH: ir.clientH,
    }));

    const preExtractedGrids = await extractInnerGridsAsMarkdown(tab, scrollInfo, {
      statusPrefix: 'Region table',
      shouldInclude: (si) => {
        const r = rects[si];
        if (!r) return false;
        return rectsIntersect(
          { x: r.pageX, y: r.pageY, w: r.pageW, h: r.pageH },
          selPageRect
        );
      },
    });

    sendStatus('Extracting region text...');
    const [textResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractRegionText,
      args: [selPageRect, preExtractedGrids],
    });

    const markdown = textResult.result || '# Region\n\n(Empty region)';
    await downloadMarkdown(markdown, tab.title, true);
    sendStatus('Done! Markdown saved.');
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollOuter,
      args: [originalOuterScrollY],
    }).catch(() => {});
  }
}

async function downloadResult(dataUrl, title, tab, format, isRegion) {
  const safeTitle = sanitizeTitle(title);
  const ts = Date.now();
  const prefix = isRegion ? 'region' : 'screenshot';

  if (format === 'png') {
    await downloadDataUrl(`${prefix}_${safeTitle}_${ts}.png`, dataUrl);
    return;
  }
  if (format === 'pdf') {
    sendStatus('Generating PDF...');
    const [pdfResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: generatePDFInPage,
      args: [dataUrl],
    });
    if (pdfResult.result) {
      await downloadDataUrl(`${prefix}_${safeTitle}_${ts}.pdf`, pdfResult.result);
    }
    return;
  }
  if (format === 'md') {
    sendStatus('Extracting text...');

    const [scrollInfoResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: getInnerScrollInfo,
    });
    const scrollInfo = scrollInfoResult.result || [];

    const preExtractedGrids = await extractInnerGridsAsMarkdown(tab, scrollInfo);

    const [textResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageText,
      args: [preExtractedGrids],
    });

    const markdown = textResult.result || '# Screenshot\n\nFailed to extract text.';
    await downloadMarkdown(markdown, title, isRegion);
  }
}

async function downloadDataUrl(filename, dataUrl) {
  await chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: false,
  });
}

function sanitizeTitle(title) {
  return (title || 'page').replace(/[^a-z0-9]/gi, '_').substring(0, 50);
}

async function downloadMarkdown(markdown, title, isRegion) {
  const prefix = isRegion ? 'region' : 'screenshot';
  const url = 'data:text/markdown;base64,' + btoa(unescape(encodeURIComponent(markdown)));
  await chrome.downloads.download({
    url,
    filename: `${prefix}_${sanitizeTitle(title)}_${Date.now()}.md`,
    saveAs: false,
  });
}

function rectsIntersect(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

// Assembles a markdown table from extracted rows. Dedupes virtual-scroll
// overlap and prefers `header` row if its column count is close to the data.
function rowsToMarkdownTable(rows, header, colCountHint) {
  const seen = new Set();
  const unique = rows.filter((row) => {
    const k = row.join('||');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) return null;
  const colCount = colCountHint || unique[0].length;
  let md = '';
  if (header && header.texts && header.texts.length >= colCount - 3) {
    const hdr = header.texts.slice(0, colCount);
    while (hdr.length < colCount) hdr.push('');
    md += '| ' + hdr.join(' | ') + ' |\n';
    md += '| ' + hdr.map(() => '---').join(' | ') + ' |\n';
  } else {
    md += '| ' + unique[0].join(' | ') + ' |\n';
    md += '| ' + unique[0].map(() => '---').join(' | ') + ' |\n';
    unique.shift();
  }
  for (const row of unique) md += '| ' + row.join(' | ') + ' |\n';
  return md;
}

// Scrolls through each inner scrollable and collects its rows into a
// markdown table. `shouldInclude(si)` skips containers (e.g. outside a
// selection); `statusPrefix` prefixes progress updates.
async function extractInnerGridsAsMarkdown(tab, scrollInfo, { shouldInclude = () => true, statusPrefix = 'Extracting table' } = {}) {
  const grids = new Array(scrollInfo.length).fill(null);

  for (let si = 0; si < scrollInfo.length; si++) {
    if (!shouldInclude(si)) continue;
    const { scrollH, clientH } = scrollInfo[si];
    if (clientH < 1 || scrollH <= clientH + 10) continue;
    const vSteps = Math.ceil(scrollH / clientH);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollInnerTo,
      args: [si, 0, 0],
    });
    await sleep(200);

    const [headerResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractGridHeader,
      args: [si],
    });
    const header = headerResult.result;

    const allRows = [];
    let detectedColCount = 0;

    for (let vi = 0; vi < vSteps; vi++) {
      const scrollY = Math.min(vi * clientH, scrollH - clientH);
      sendStatus(`${statusPrefix} ${si + 1}: ${vi + 1}/${vSteps}...`);

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrollInnerTo,
        args: [si, 0, scrollY],
      });
      await sleep(150);

      const [rowsResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractVisibleGridRows,
        args: [si],
      });
      if (rowsResult.result) {
        detectedColCount = rowsResult.result.colCount;
        allRows.push(...rowsResult.result.rows);
      }
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollInnerTo,
      args: [si, 0, 0],
    });

    grids[si] = rowsToMarkdownTable(allRows, header, detectedColCount);
  }

  return grids;
}

// Compute crop rectangle (in DPR pixels) in the stitched image for a given
// viewport selection. Expands the crop to fully cover any inner scrollable
// that intersects the selection, since the stitched image renders those
// scrollables in expanded form.
function computeCropRect(selection, innerResults, dpr) {
  const px = selection.pageRect.x;
  const pyTop = selection.pageRect.y;
  const pyBot = pyTop + selection.pageRect.h;
  const pw = selection.pageRect.w;

  function expansionAtY(y) {
    let exp = 0;
    for (const ir of innerResults) {
      if (ir.outerScrollY + ir.visibleH <= y) exp += (ir.totalH - ir.visibleH);
    }
    return exp;
  }

  let stitchedTop = pyTop + expansionAtY(pyTop);
  let stitchedBot = pyBot + expansionAtY(pyBot);
  let stitchedLeft = px;
  let stitchedRight = px + pw;

  for (const ir of innerResults) {
    const irTop = ir.outerScrollY;
    const irVisBot = irTop + ir.visibleH;
    const intersects = irTop < pyBot && irVisBot > pyTop;
    if (!intersects) continue;
    const irStartStitched = irTop + expansionAtY(irTop);
    const irEndStitched = irStartStitched + ir.totalH;
    if (irStartStitched < stitchedTop) stitchedTop = irStartStitched;
    if (irEndStitched > stitchedBot) stitchedBot = irEndStitched;
    if (ir.totalW > ir.visibleW) {
      const irLeft = ir.cropLeft || 0;
      const irRight = irLeft + ir.totalW;
      if (irLeft < stitchedLeft) stitchedLeft = irLeft;
      if (irRight > stitchedRight) stitchedRight = irRight;
    }
  }

  return {
    x: Math.max(0, Math.round(stitchedLeft * dpr)),
    y: Math.max(0, Math.round(stitchedTop * dpr)),
    w: Math.round((stitchedRight - stitchedLeft) * dpr),
    h: Math.round((stitchedBot - stitchedTop) * dpr),
  };
}

// ========== Page-context functions ==========

function detectPageStructure() {
  const all = document.querySelectorAll('*');
  const scrollables = [];

  for (const el of all) {
    if (el === document.documentElement || el === document.body) continue;
    const s = getComputedStyle(el);
    const sY = el.scrollHeight > el.clientHeight + 5 &&
      (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowY === 'overlay');
    const sX = el.scrollWidth > el.clientWidth + 5 &&
      (s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'overlay');

    if (sY || sX) {
      const r = el.getBoundingClientRect();
      scrollables.push({
        el, rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        sY, sX,
      });
    }
  }

  let outerScrollable = null;
  let outerIdx = -1;
  let maxArea = 0;
  for (let i = 0; i < scrollables.length; i++) {
    const s = scrollables[i];
    if (!s.sY) continue;
    if (s.rect.w < window.innerWidth * 0.5) continue;
    if (s.rect.h < window.innerHeight * 0.4) continue;
    if (s.rect.x < -50) continue;
    
    const area = s.clientW * s.clientH;
    if (area > maxArea) {
      outerScrollable = s;
      outerIdx = i;
      maxArea = area;
    }
  }

  const innerScrollables = [];
  window.__innerScrollEls = [];

  for (let i = 0; i < scrollables.length; i++) {
    if (i === outerIdx) continue;
    const s = scrollables[i];
    if (s.rect.x < -50) continue;
    if (s.rect.w < 150) continue;
    const hiddenV = s.scrollH - s.clientH;
    const hiddenH = s.scrollW - s.clientW;
    if (hiddenV <= 10 && hiddenH <= 10) continue;

    window.__innerScrollEls.push(s.el);
    innerScrollables.push({
      index: innerScrollables.length,
      scrollH: s.scrollH, clientH: s.clientH,
      scrollW: s.scrollW, clientW: s.clientW,
    });
  }

  window.__outerScrollEl = outerScrollable ? outerScrollable.el : null;

  return {
    dpr: window.devicePixelRatio || 1,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    outerScrollable: outerScrollable
      ? { scrollH: outerScrollable.scrollH, clientH: outerScrollable.clientH, clientW: outerScrollable.clientW }
      : null,
    innerScrollables,
  };
}

function scrollOuter(y) {
  if (window.__outerScrollEl) {
    window.__outerScrollEl.scrollTop = y;
  } else {
    window.scrollTo(0, y);
  }
}

function positionInnerInView(index) {
  const el = window.__innerScrollEls[index];
  if (!el) return null;

  const rect = el.getBoundingClientRect();
  let outerScrollY = 0;

  if (window.__outerScrollEl) {
    const outerRect = window.__outerScrollEl.getBoundingClientRect();
    const elTopInOuter = rect.top - outerRect.top + window.__outerScrollEl.scrollTop;
    window.__outerScrollEl.scrollTop = elTopInOuter;
    outerScrollY = elTopInOuter;
  } else {
    const absTop = rect.top + window.scrollY;
    window.scrollTo(0, absTop);
    outerScrollY = absTop;
  }

  const newRect = el.getBoundingClientRect();
  return {
    outerScrollY,
    rect: { top: newRect.top, left: newRect.left, width: newRect.width, height: newRect.height },
  };
}

function hideFixedElements(innerIndex) {
  window.__hiddenFixedEls = [];
  const innerEl = window.__innerScrollEls[innerIndex];

  document.querySelectorAll('*').forEach((el) => {
    if (el.contains(innerEl) || innerEl.contains(el)) return;
    const s = getComputedStyle(el);
    if (s.position === 'fixed' || s.position === 'sticky') {
      window.__hiddenFixedEls.push({ el, visibility: el.style.visibility });
      el.style.visibility = 'hidden';
    }
  });
}

function restoreFixedElements() {
  if (window.__hiddenFixedEls) {
    for (const item of window.__hiddenFixedEls) {
      item.el.style.visibility = item.visibility;
    }
    window.__hiddenFixedEls = null;
  }
}

function getMeasurements(index) {
  const el = window.__innerScrollEls[index];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    rect: { top: r.top, left: r.left, width: r.width, height: r.height },
    clientW: el.clientWidth,
    clientH: el.clientHeight,
  };
}

function scrollInnerTo(index, x, y) {
  const el = window.__innerScrollEls[index];
  if (el) {
    el.scrollLeft = x;
    el.scrollTop = y;
  }
}

function stitchFull(outerStrips, innerResults, info, dpr, pageW, cropRect) {
  const outerViewH = info.outerScrollable ? info.outerScrollable.clientH : info.viewportHeight;
  const outerTotalH = info.outerScrollable ? info.outerScrollable.scrollH : info.pageHeight;

  let maxBottom = outerTotalH;
  let extraWidth = 0;

  for (const ir of innerResults) {
    if (!ir.strips) continue;
    const expandedBottom = ir.outerScrollY + ir.totalH;
    const vExpansion = ir.totalH - ir.visibleH;
    maxBottom = Math.max(maxBottom + vExpansion, expandedBottom);
    const hExp = ir.totalW - ir.visibleW;
    if (hExp > extraWidth) extraWidth = hExp;
  }

  const canvasW = Math.round((pageW + extraWidth) * dpr);
  const canvasH = Math.round(maxBottom * dpr);

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  return new Promise((resolve) => {
    const allUrls = new Set();
    for (const s of outerStrips) allUrls.add(s.dataUrl);
    for (const ir of innerResults) {
      for (const s of ir.strips) allUrls.add(s.dataUrl);
    }

    const imgMap = new Map();
    let loaded = 0;
    const urlArr = [...allUrls];

    for (const url of urlArr) {
      const img = new Image();
      img.onload = () => {
        imgMap.set(url, img);
        loaded++;
        if (loaded === urlArr.length) compose();
      };
      img.src = url;
    }

    function compose() {
      for (const strip of outerStrips) {
        const img = imgMap.get(strip.dataUrl);
        const remaining = outerTotalH - strip.scrollY;
        const drawH = Math.min(outerViewH, remaining);
        const srcY = drawH < outerViewH ? (outerViewH - drawH) * dpr : 0;
        ctx.drawImage(
          img, 0, srcY, img.width, drawH * dpr,
          0, strip.scrollY * dpr, img.width, drawH * dpr
        );
      }

      const sorted = [...innerResults].sort((a, b) => b.outerScrollY - a.outerScrollY);

      for (const ir of sorted) {
        const containerTopInPage = ir.outerScrollY;
        const vExpansion = ir.totalH - ir.visibleH;

        if (vExpansion > 0) {
          const belowY = Math.round((containerTopInPage + ir.visibleH) * dpr);
          const shiftAmount = Math.round(vExpansion * dpr);
          const belowH = canvasH - belowY - shiftAmount;
          if (belowH > 0) {
            const belowData = ctx.getImageData(0, belowY, canvasW, belowH);
            ctx.putImageData(belowData, 0, belowY + shiftAmount);
          }
        }

        const cropL = Math.round(ir.cropLeft * dpr);
        const cropT = Math.round(ir.cropTop * dpr);

        for (const strip of ir.strips) {
          const img = imgMap.get(strip.dataUrl);
          const isLastRow = strip.gridY === ir.vSteps - 1;
          const isLastCol = strip.gridX === ir.hSteps - 1 && ir.hSteps > 1;

          const uniqueY = isLastRow ? ir.totalH - strip.gridY * ir.visibleH : ir.visibleH;
          const uniqueX = isLastCol ? ir.totalW - strip.gridX * ir.visibleW : ir.visibleW;

          const srcX = cropL + Math.round((ir.visibleW - uniqueX) * dpr);
          const srcY = cropT + Math.round((ir.visibleH - uniqueY) * dpr);
          const srcW = Math.round(uniqueX * dpr);
          const srcH = Math.round(uniqueY * dpr);

          const dstX = Math.round((ir.cropLeft + strip.gridX * ir.visibleW) * dpr);
          const dstY = Math.round((containerTopInPage + strip.gridY * ir.visibleH) * dpr);

          ctx.drawImage(img, srcX, srcY, srcW, srcH, dstX, dstY, srcW, srcH);
        }
      }

      if (cropRect && cropRect.w > 0 && cropRect.h > 0) {
        const cx = Math.max(0, Math.min(canvasW, cropRect.x));
        const cy = Math.max(0, Math.min(canvasH, cropRect.y));
        const cw = Math.max(1, Math.min(canvasW - cx, cropRect.w));
        const ch = Math.max(1, Math.min(canvasH - cy, cropRect.h));
        const out = document.createElement('canvas');
        out.width = cw;
        out.height = ch;
        out.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
        resolve(out.toDataURL('image/png'));
        return;
      }
      resolve(canvas.toDataURL('image/png'));
    }
  });
}

function stitchSimple(strips, totalH, totalW, viewH, dpr, cropRect) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(totalW * dpr);
  canvas.height = Math.round(totalH * dpr);
  const ctx = canvas.getContext('2d');

  return new Promise((resolve) => {
    let loaded = 0;
    const images = [];
    strips.forEach((s, i) => {
      const img = new Image();
      img.onload = () => {
        images[i] = { img, scrollY: s.scrollY };
        loaded++;
        if (loaded === strips.length) {
          for (const { img, scrollY } of images) {
            const rem = totalH - scrollY;
            const dH = Math.min(viewH, rem);
            const sY = dH < viewH ? (viewH - dH) * dpr : 0;
            ctx.drawImage(img, 0, sY, img.width, dH * dpr, 0, scrollY * dpr, img.width, dH * dpr);
          }
          if (cropRect && cropRect.w > 0 && cropRect.h > 0) {
            const cx = Math.max(0, Math.min(canvas.width, cropRect.x));
            const cy = Math.max(0, Math.min(canvas.height, cropRect.y));
            const cw = Math.max(1, Math.min(canvas.width - cx, cropRect.w));
            const ch = Math.max(1, Math.min(canvas.height - cy, cropRect.h));
            const out = document.createElement('canvas');
            out.width = cw;
            out.height = ch;
            out.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
            resolve(out.toDataURL('image/png'));
            return;
          }
          resolve(canvas.toDataURL('image/png'));
        }
      };
      img.src = s.dataUrl;
    });
  });
}

function generatePDFInPage(imageDataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const imgW = img.width;
      const imgH = img.height;

      const canvas = document.createElement('canvas');
      canvas.width = imgW;
      canvas.height = imgH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const jpegBase64 = jpegDataUrl.split(',')[1];
      const jpegBinary = atob(jpegBase64);
      const jpegBytes = new Uint8Array(jpegBinary.length);
      for (let i = 0; i < jpegBinary.length; i++) {
        jpegBytes[i] = jpegBinary.charCodeAt(i);
      }

      const pageW = 595;
      const scale = pageW / imgW;
      const fullImgH = imgH * scale;
      const maxPageH = 842;

      const pages = [];
      let remainH = fullImgH;
      let srcY = 0;
      while (remainH > 0) {
        const thisPageH = Math.min(remainH, maxPageH);
        pages.push({ srcY, srcHeight: thisPageH / scale, pageH: thisPageH });
        srcY += thisPageH / scale;
        remainH -= thisPageH;
      }

      // Build PDF
      const enc = new TextEncoder();
      const parts = [];
      function write(str) { parts.push(enc.encode(str)); }
      function writeBytes(bytes) { parts.push(bytes); }

      write('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');
      const offsets = [];
      function startObj(n) {
        let offset = 0;
        for (const p of parts) offset += p.length;
        offsets[n] = offset;
        write(`${n} 0 obj\n`);
      }

      startObj(1);
      write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

      startObj(2);
      const pageRefs = pages.map((_, i) => `${3 + i} 0 R`).join(' ');
      write(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>\nendobj\n`);

      const imgObjNum = 3 + pages.length;
      const resourceStr = `<< /XObject << /Img ${imgObjNum} 0 R >> >>`;

      for (let i = 0; i < pages.length; i++) {
        const contentNum = imgObjNum + 1 + i;
        startObj(3 + i);
        write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pages[i].pageH.toFixed(2)}] /Contents ${contentNum} 0 R /Resources ${resourceStr} >>\nendobj\n`);
      }

      startObj(imgObjNum);
      write(`<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
      writeBytes(jpegBytes);
      write('\nendstream\nendobj\n');

      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const contentNum = imgObjNum + 1 + i;
        const yOffset = -(fullImgH - p.pageH - (p.srcY * scale));
        const stream = `q ${pageW.toFixed(2)} 0 0 ${fullImgH.toFixed(2)} 0 ${yOffset.toFixed(2)} cm /Img Do Q`;
        startObj(contentNum);
        write(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
      }

      let xrefOffset = 0;
      for (const p of parts) xrefOffset += p.length;

      const totalObjs = imgObjNum + pages.length + 1;
      write('xref\n');
      write(`0 ${totalObjs}\n`);
      write('0000000000 65535 f \n');
      for (let i = 1; i < totalObjs; i++) {
        const off = (offsets[i] || 0).toString().padStart(10, '0');
        write(`${off} 00000 n \n`);
      }
      write('trailer\n');
      write(`<< /Size ${totalObjs} /Root 1 0 R >>\n`);
      write('startxref\n');
      write(`${xrefOffset}\n`);
      write('%%EOF\n');

      const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
      const result = new Uint8Array(totalLen);
      let offset = 0;
      for (const p of parts) { result.set(p, offset); offset += p.length; }

      // Convert to data URL
      let binary = '';
      for (let i = 0; i < result.length; i++) {
        binary += String.fromCharCode(result[i]);
      }
      resolve('data:application/pdf;base64,' + btoa(binary));
    };
    img.src = imageDataUrl;
  });
}

function forceRenderInnerScrolls() {
  const els = window.__innerScrollEls || [];
  for (const el of els) {
    const step = el.clientHeight;
    for (let y = 0; y < el.scrollHeight; y += step) {
      el.scrollTop = y;
    }
    el.scrollTop = 0;
  }
}

function getInnerScrollInfo() {
  const els = window.__innerScrollEls || [];
  return els.map(el => ({
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
  }));
}

function extractVisibleGridRows(containerIndex) {
  const container = window.__innerScrollEls[containerIndex];
  if (!container) return null;

  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','CANVAS','IFRAME',
    'VIDEO','AUDIO','INPUT','TEXTAREA','SELECT','BUTTON','IMG','PICTURE']);

  function esc(t) { return t.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim(); }

  const cRect = container.getBoundingClientRect();
  const items = [];

  for (const el of container.querySelectorAll('*')) {
    if (el.children.length > 0) continue;
    const text = el.textContent.trim();
    if (!text) continue;
    if (SKIP.has(el.tagName)) continue;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
    } catch (e) { continue; }
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // Only elements visible within the scroll container viewport
    if (r.bottom < cRect.top - 5 || r.top > cRect.bottom + 5) continue;
    items.push({ text, x: r.left, y: r.top });
  }

  if (items.length < 3) return null;

  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  let cur = [items[0]];
  for (let i = 1; i < items.length; i++) {
    if (Math.abs(items[i].y - cur[0].y) <= 8) cur.push(items[i]);
    else { rows.push(cur.sort((a, b) => a.x - b.x)); cur = [items[i]]; }
  }
  rows.push(cur.sort((a, b) => a.x - b.x));

  const freq = {};
  for (const r of rows) freq[r.length] = (freq[r.length] || 0) + 1;
  let best = 0, bestF = 0;
  for (const [c, f] of Object.entries(freq)) {
    const n = parseInt(c);
    if (n >= 3 && f > bestF) { best = n; bestF = f; }
  }
  if (best < 3) return null;

  const tableRows = rows.filter(r => r.length >= best - 2 && r.length <= best + 2);
  return {
    colCount: best,
    rows: tableRows.map(row => {
      const cells = row.map(i => esc(i.text));
      while (cells.length < best) cells.push('');
      return cells.slice(0, best);
    }),
  };
}

function extractGridHeader(containerIndex) {
  const container = window.__innerScrollEls[containerIndex];
  if (!container) return null;

  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','CANVAS','IFRAME',
    'VIDEO','AUDIO','INPUT','TEXTAREA','SELECT','BUTTON','IMG','PICTURE']);

  function esc(t) { return t.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim(); }

  const cRect = container.getBoundingClientRect();
  const parent = container.parentElement;
  if (!parent) return null;

  const candidates = [];
  for (const el of parent.querySelectorAll('*')) {
    if (container.contains(el)) continue;
    if (el.children.length > 0) continue;
    const text = el.textContent.trim();
    if (!text) continue;
    if (SKIP.has(el.tagName)) continue;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
    } catch (e) { continue; }
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.top >= cRect.top || r.top < cRect.top - 150) continue;
    if (r.right < cRect.left - 30 || r.left > cRect.right + 30) continue;
    candidates.push({ text, x: r.left, y: r.top });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.y - a.y || a.x - b.x);
  const row = [candidates[0]];
  for (let i = 1; i < candidates.length; i++) {
    if (Math.abs(candidates[i].y - row[0].y) <= 8) row.push(candidates[i]);
    else break;
  }
  row.sort((a, b) => a.x - b.x);

  return { texts: row.map(h => esc(h.text)) };
}

function extractPageText(preExtractedGrids) {
  const title = document.title;
  const url = window.location.href;
  let md = `# ${title}\n\n`;
  md += `> Source: ${url}\n`;
  md += `> Captured: ${new Date().toISOString()}\n\n`;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME',
    'VIDEO', 'AUDIO', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON',
    'IMG', 'PICTURE',
  ]);
  const NAV_TAGS = new Set(['NAV', 'ASIDE', 'FOOTER', 'HEADER']);
  const SKIP_ROLES = new Set([
    'navigation', 'banner', 'complementary', 'menu', 'menubar',
    'toolbar', 'search', 'dialog', 'alertdialog', 'tooltip',
    'tablist', 'switch', 'slider', 'progressbar', 'scrollbar',
  ]);

  const renderedEls = new WeakSet();
  const scrollEls = window.__innerScrollEls || [];

  function esc(text) {
    return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  }

  // --- Pre-scan: detect chart containers (elements that parent an SVG) ---
  const chartContainers = new Set();
  (function detectCharts() {
    for (const svg of document.querySelectorAll('svg')) {
      const svgRect = svg.getBoundingClientRect();
      if (svgRect.width < 100 || svgRect.height < 50) continue; // skip icon SVGs
      let el = svg.parentElement;
      for (let d = 0; d < 4 && el; d++) {
        const r = el.getBoundingClientRect();
        if (r.width > 200 && r.height > 100) { chartContainers.add(el); break; }
        el = el.parentElement;
      }
    }
  })();

  function isInChart(el) {
    for (const c of chartContainers) { if (c.contains(el)) return true; }
    return false;
  }

  // --- Pre-scan: detect sidebars by position (narrow + left + tall) ---
  const sidebarEls = new WeakSet();
  (function detectSidebars() {
    const vh = window.innerHeight;
    const queue = [...document.body.children].map(c => ({ el: c, depth: 0 }));
    while (queue.length) {
      const { el, depth } = queue.shift();
      if (!el || !el.tagName || depth > 5) continue;
      try {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width < 300 && r.left < 20 && r.height > vh * 0.4) {
          sidebarEls.add(el);
          continue; // don't recurse into sidebar
        }
        if (r.width >= 300 && depth < 5) {
          for (const child of el.children) queue.push({ el: child, depth: depth + 1 });
        }
      } catch (e) {}
    }
  })();

  // --- Phase 1: Extract grids from scroll containers using bounding-rect positions ---
  const gridTables = new Map();

  function collectLeafItems(root) {
    const items = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const text = el.textContent.trim();
      if (!text) continue;
      if (SKIP_TAGS.has(el.tagName)) continue;
      try {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
      } catch (e) { continue; }
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      items.push({ text, x: rect.left, y: rect.top, el });
    }
    return items;
  }

  function clusterIntoRows(items) {
    if (items.length === 0) return [];
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    let curRow = [items[0]];
    for (let i = 1; i < items.length; i++) {
      if (Math.abs(items[i].y - curRow[0].y) <= 8) {
        curRow.push(items[i]);
      } else {
        rows.push(curRow.sort((a, b) => a.x - b.x));
        curRow = [items[i]];
      }
    }
    rows.push(curRow.sort((a, b) => a.x - b.x));
    return rows;
  }

  function findModalColCount(rows) {
    const freq = {};
    for (const r of rows) freq[r.length] = (freq[r.length] || 0) + 1;
    let best = 0, bestF = 0;
    for (const [cnt, f] of Object.entries(freq)) {
      const n = parseInt(cnt);
      if (n >= 3 && f > bestF) { best = n; bestF = f; }
    }
    return { count: best, freq: bestF };
  }

  function findHeaderRow(container, colCount, firstDataY) {
    // Search the container's parent for leaf text elements just above the data
    const parent = container.parentElement;
    if (!parent) return null;
    const cRect = container.getBoundingClientRect();
    const candidates = [];

    for (const el of parent.querySelectorAll('*')) {
      if (container.contains(el)) continue;
      if (el.children.length > 0) continue;
      const text = el.textContent.trim();
      if (!text) continue;
      if (SKIP_TAGS.has(el.tagName)) continue;
      try {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
      } catch (e) { continue; }
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      // Must be above the first data row but within 150px
      if (rect.top >= firstDataY || rect.top < firstDataY - 150) continue;
      // Must overlap horizontally with the container
      if (rect.right < cRect.left - 30 || rect.left > cRect.right + 30) continue;
      candidates.push({ text, x: rect.left, y: rect.top, el });
    }
    if (candidates.length === 0) return null;

    // Sort by Y descending — closest row to the data first
    candidates.sort((a, b) => b.y - a.y || a.x - b.x);
    const row = [candidates[0]];
    for (let i = 1; i < candidates.length; i++) {
      if (Math.abs(candidates[i].y - row[0].y) <= 8) row.push(candidates[i]);
      else break;
    }
    row.sort((a, b) => a.x - b.x);

    if (row.length >= colCount - 3 && row.length <= colCount + 3) {
      return { texts: row.map(h => esc(h.text)), elements: row.map(h => h.el) };
    }
    return null;
  }

  function extractGridByPosition(container) {
    const items = collectLeafItems(container);
    if (items.length < 6) return null;

    const rows = clusterIntoRows(items);
    if (rows.length < 2) return null;

    const { count: bestCount, freq: bestFreq } = findModalColCount(rows);
    if (bestCount < 3 || bestFreq < 2) return null;

    const tableRows = rows.filter(r => r.length >= bestCount - 2 && r.length <= bestCount + 2);
    if (tableRows.length < 2) return null;

    const firstDataY = tableRows[0][0].y;
    const header = findHeaderRow(container, bestCount, firstDataY);

    let tmd = '';
    if (header) {
      // Mark header elements as rendered so walk() won't duplicate them
      for (const el of header.elements) renderedEls.add(el);
      const hdr = header.texts.slice(0, bestCount);
      while (hdr.length < bestCount) hdr.push('');
      tmd += '| ' + hdr.join(' | ') + ' |\n';
      tmd += '| ' + hdr.map(() => '---').join(' | ') + ' |\n';
      for (const row of tableRows) {
        const cells = row.map(i => esc(i.text));
        while (cells.length < bestCount) cells.push('');
        tmd += '| ' + cells.slice(0, bestCount).join(' | ') + ' |\n';
      }
    } else {
      tableRows.forEach((row, ri) => {
        const cells = row.map(i => esc(i.text));
        while (cells.length < bestCount) cells.push('');
        const final = cells.slice(0, bestCount);
        tmd += '| ' + final.join(' | ') + ' |\n';
        if (ri === 0) tmd += '| ' + final.map(() => '---').join(' | ') + ' |\n';
      });
    }
    return tmd;
  }

  if (preExtractedGrids && preExtractedGrids.length > 0) {
    // Use pre-extracted grid markdown from incremental scroll extraction
    for (let i = 0; i < scrollEls.length && i < preExtractedGrids.length; i++) {
      if (preExtractedGrids[i]) {
        gridTables.set(scrollEls[i], preExtractedGrids[i]);
        renderedEls.add(scrollEls[i]);
        // Mark header-area elements above the container as rendered to prevent duplication
        const cRect = scrollEls[i].getBoundingClientRect();
        const parent = scrollEls[i].parentElement;
        if (parent) {
          for (const el of parent.querySelectorAll('*')) {
            if (scrollEls[i].contains(el)) continue;
            if (el.children.length > 0) continue;
            if (!el.textContent.trim()) continue;
            try {
              const rect = el.getBoundingClientRect();
              if (rect.width < 1 || rect.height < 1) continue;
              if (rect.top >= cRect.top || rect.top < cRect.top - 150) continue;
              if (rect.right < cRect.left - 30 || rect.left > cRect.right + 30) continue;
              renderedEls.add(el);
            } catch (e) {}
          }
        }
      }
    }
  } else {
    // Fallback: single-shot extraction (non-virtual grids or no pre-extraction)
    for (const container of scrollEls) {
      const grid = extractGridByPosition(container);
      if (grid) {
        gridTables.set(container, grid);
        renderedEls.add(container);
      }
    }
  }

  // --- Phase 2: Walk DOM for remaining text, inserting tables in document order ---

  function isHidden(el) {
    if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
      const t = el.tagName;
      if (t === 'THEAD' || t === 'TBODY' || t === 'TFOOT' || t === 'TR' || t === 'TH' || t === 'TD') return false;
      return true;
    }
    try {
      const style = getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden';
    } catch (e) { return true; }
  }

  function shouldSkip(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (NAV_TAGS.has(el.tagName)) return true;
    if (sidebarEls.has(el)) return true;
    if (chartContainers.has(el)) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (SKIP_ROLES.has(role)) return true;
    const cls = (el.className || '').toString().toLowerCase();
    if (/\b(sidebar|side-bar|sidenav|side-nav|nav-menu|navigation|breadcrumb)\b/.test(cls)) return true;
    return false;
  }

  function walk(el) {
    if (!el || !el.tagName) return '';
    if (gridTables.has(el)) return gridTables.get(el) + '\n';
    if (renderedEls.has(el)) return '';
    if (isHidden(el)) return '';
    if (shouldSkip(el)) return '';

    const tag = el.tagName;
    let text = '';

    // Native HTML table
    if (tag === 'TABLE') {
      const rows = el.querySelectorAll('tr');
      if (rows.length > 0) {
        let headerDone = false;
        rows.forEach(row => {
          const cells = row.querySelectorAll('th, td');
          if (cells.length === 0) return;
          text += '| ' + [...cells].map(c => esc(c.textContent)).join(' | ') + ' |\n';
          if (!headerDone) {
            text += '| ' + [...cells].map(() => '---').join(' | ') + ' |\n';
            headerDone = true;
          }
        });
        text += '\n';
      }
      return text;
    }

    if (/^H[1-6]$/.test(tag)) {
      const content = el.textContent.trim();
      if (content) text += `${'#'.repeat(parseInt(tag[1]))} ${content}\n\n`;
      return text;
    }

    if (tag === 'UL' || tag === 'OL') {
      const items = el.querySelectorAll(':scope > li');
      if (items.length > 0) {
        items.forEach((li, i) => {
          text += (tag === 'OL' ? `${i + 1}. ` : '- ') + li.textContent.trim() + '\n';
        });
        text += '\n';
        return text;
      }
    }

    if (tag === 'P') {
      const content = el.textContent.trim();
      if (content) text += content + '\n\n';
      return text;
    }

    // Leaf text — suppress chart labels
    if (el.children.length === 0 && el.textContent.trim()) {
      if (isInChart(el)) return '';
      text += el.textContent.trim() + '\n';
      return text;
    }

    for (const child of el.children) text += walk(child);
    return text;
  }

  md += walk(document.body);

  // Safety net: append tables not encountered during walk
  for (const [, table] of gridTables) {
    if (!md.includes(table)) md += '\n' + table + '\n';
  }

  return md.replace(/\n{3,}/g, '\n\n');
}

// Renders a rubber-band selection overlay and resolves with the selected
// viewport rect plus the current outer scroll offset. Resolves with null if
// the user cancels (ESC) or releases without a meaningful drag.
function runSelectionOverlay() {
  return new Promise((resolve) => {
    const OVERLAY_ID = '__fps_selection_overlay';
    const DIM_STYLE = 'position:absolute;background:rgba(0,0,0,0.4);pointer-events:none;';
    const EDGE_PX = 40;
    const MAX_SCROLL_SPEED = 25;

    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    function outerEl() { return window.__outerScrollEl; }
    function getScrollY() {
      const el = outerEl();
      return el ? el.scrollTop : (window.scrollY || 0);
    }
    function getScrollX() {
      const el = outerEl();
      return el ? el.scrollLeft : (window.scrollX || 0);
    }
    function setScrollY(y) {
      const el = outerEl();
      if (el) el.scrollTop = y;
      else window.scrollTo(window.scrollX || 0, y);
    }
    function getMaxScrollY() {
      const el = outerEl();
      if (el) return Math.max(0, el.scrollHeight - el.clientHeight);
      const docH = Math.max(
        document.documentElement.scrollHeight || 0,
        document.body ? document.body.scrollHeight : 0
      );
      return Math.max(0, docH - window.innerHeight);
    }

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;user-select:none;touch-action:none;';

    const dimTop = document.createElement('div');
    const dimBot = document.createElement('div');
    const dimLeft = document.createElement('div');
    const dimRight = document.createElement('div');
    for (const d of [dimTop, dimBot, dimLeft, dimRight]) {
      d.style.cssText = DIM_STYLE;
      overlay.appendChild(d);
    }

    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;border:2px solid #2563eb;background:transparent;pointer-events:none;box-shadow:0 0 0 1px rgba(255,255,255,0.5);display:none;';
    overlay.appendChild(box);

    const hint = document.createElement('div');
    hint.textContent = 'Drag to select. Drag past the edge to auto-scroll. ESC to cancel.';
    hint.style.cssText = 'position:absolute;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:white;padding:10px 16px;border-radius:6px;font:500 13px -apple-system,sans-serif;pointer-events:none;z-index:1;';
    overlay.appendChild(hint);

    let pageStart = null;
    let pageRect = null;
    let lastPointer = null;
    let pointerId = null;
    let startScrollY = 0;
    let startScrollX = 0;
    let scrollFrame = null;
    let resolved = false;

    function setRect(el, x, y, w, h) {
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.style.display = w > 0 && h > 0 ? '' : 'none';
    }

    function paint() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (!pageRect || pageRect.w <= 0 || pageRect.h <= 0) {
        setRect(dimTop, 0, 0, vw, vh);
        dimBot.style.display = 'none';
        dimLeft.style.display = 'none';
        dimRight.style.display = 'none';
        box.style.display = 'none';
        return;
      }
      const vx = pageRect.x - getScrollX();
      const vy = pageRect.y - getScrollY();
      const vxEnd = vx + pageRect.w;
      const vyEnd = vy + pageRect.h;
      const topClip = Math.max(0, vy);
      const botClip = Math.max(0, vyEnd);
      const leftClip = Math.max(0, vx);
      const rightClip = Math.max(0, vxEnd);
      setRect(dimTop, 0, 0, vw, topClip);
      setRect(dimBot, 0, botClip, vw, Math.max(0, vh - botClip));
      setRect(dimLeft, 0, topClip, leftClip, Math.max(0, Math.min(botClip, vh) - topClip));
      setRect(dimRight, rightClip, topClip, Math.max(0, vw - rightClip), Math.max(0, Math.min(botClip, vh) - topClip));
      setRect(box, vx, vy, pageRect.w, pageRect.h);
    }

    function updateRectFromPointer(vx, vy) {
      const curX = vx + getScrollX();
      const curY = vy + getScrollY();
      pageRect = {
        x: Math.min(pageStart.x, curX),
        y: Math.min(pageStart.y, curY),
        w: Math.abs(curX - pageStart.x),
        h: Math.abs(curY - pageStart.y),
      };
    }

    function autoScrollTick() {
      scrollFrame = null;
      if (!pageStart || !lastPointer) return;
      const vh = window.innerHeight;
      let delta = 0;
      if (lastPointer.y < EDGE_PX) {
        delta = -Math.ceil(((EDGE_PX - lastPointer.y) / EDGE_PX) * MAX_SCROLL_SPEED);
      } else if (lastPointer.y > vh - EDGE_PX) {
        delta = Math.ceil(((lastPointer.y - (vh - EDGE_PX)) / EDGE_PX) * MAX_SCROLL_SPEED);
      }
      if (delta !== 0) {
        const cur = getScrollY();
        const next = Math.max(0, Math.min(getMaxScrollY(), cur + delta));
        if (next !== cur) {
          setScrollY(next);
          updateRectFromPointer(lastPointer.x, lastPointer.y);
          paint();
        }
      }
      if (lastPointer.y < EDGE_PX || lastPointer.y > window.innerHeight - EDGE_PX) {
        scrollFrame = requestAnimationFrame(autoScrollTick);
      }
    }

    function maybeStartAutoScroll() {
      if (scrollFrame !== null || !lastPointer) return;
      const vh = window.innerHeight;
      if (lastPointer.y < EDGE_PX || lastPointer.y > vh - EDGE_PX) {
        scrollFrame = requestAnimationFrame(autoScrollTick);
      }
    }

    function stopAutoScroll() {
      if (scrollFrame !== null) {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = null;
      }
    }

    function finish(value) {
      if (resolved) return;
      resolved = true;
      stopAutoScroll();
      document.removeEventListener('keydown', onKey, true);
      if (pointerId !== null && overlay.hasPointerCapture?.(pointerId)) {
        try { overlay.releasePointerCapture(pointerId); } catch (_) {}
      }
      overlay.remove();
      resolve(value);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    }

    overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    overlay.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      finish(null);
    });

    overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      startScrollY = getScrollY();
      startScrollX = getScrollX();
      pageStart = { x: e.clientX + startScrollX, y: e.clientY + startScrollY };
      pageRect = { x: pageStart.x, y: pageStart.y, w: 0, h: 0 };
      lastPointer = { x: e.clientX, y: e.clientY };
      pointerId = e.pointerId;
      try { overlay.setPointerCapture(e.pointerId); } catch (_) {}
      hint.style.display = 'none';
      paint();
    });

    overlay.addEventListener('pointermove', (e) => {
      if (!pageStart) return;
      lastPointer = { x: e.clientX, y: e.clientY };
      updateRectFromPointer(e.clientX, e.clientY);
      paint();
      maybeStartAutoScroll();
    });

    overlay.addEventListener('pointerup', () => {
      stopAutoScroll();
      if (!pageStart || !pageRect || pageRect.w < 5 || pageRect.h < 5) {
        finish(null);
        return;
      }
      finish({
        pageRect: {
          x: Math.max(0, pageRect.x),
          y: Math.max(0, pageRect.y),
          w: pageRect.w,
          h: pageRect.h,
        },
        originalOuterScrollX: startScrollX,
        originalOuterScrollY: startScrollY,
      });
    });

    overlay.addEventListener('pointercancel', () => finish(null));

    try {
      document.addEventListener('keydown', onKey, true);
      document.documentElement.appendChild(overlay);
      paint();
    } catch (err) {
      finish(null);
    }
  });
}

function getInnerScrollablePageRects() {
  const outerEl = window.__outerScrollEl;
  const outerScrollY = outerEl ? outerEl.scrollTop : (window.scrollY || 0);
  const outerScrollX = outerEl ? outerEl.scrollLeft : (window.scrollX || 0);
  const els = window.__innerScrollEls || [];
  return els.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      pageX: r.left + outerScrollX,
      pageY: r.top + outerScrollY,
      pageW: r.width,
      pageH: r.height,
    };
  });
}

// Region-aware markdown extractor. Assumes the caller has reset outer scroll
// to 0, so getBoundingClientRect() returns page-coord positions directly.
function extractRegionText(selPageRect, preExtractedGrids) {
  const title = document.title;
  const url = window.location.href;
  let md = `# ${title} (region)\n\n`;
  md += `> Source: ${url}\n`;
  md += `> Captured: ${new Date().toISOString()}\n`;
  md += `> Region: x=${Math.round(selPageRect.x)}, y=${Math.round(selPageRect.y)}, w=${Math.round(selPageRect.w)}, h=${Math.round(selPageRect.h)}\n\n`;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME',
    'VIDEO', 'AUDIO', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON',
    'IMG', 'PICTURE',
  ]);

  const outerEl = window.__outerScrollEl;
  const outerScrollY = outerEl ? outerEl.scrollTop : (window.scrollY || 0);
  const outerScrollX = outerEl ? outerEl.scrollLeft : (window.scrollX || 0);

  function pageRect(el) {
    const r = el.getBoundingClientRect();
    return {
      x: r.left + outerScrollX,
      y: r.top + outerScrollY,
      w: r.width,
      h: r.height,
    };
  }

  function intersects(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }

  const scrollEls = window.__innerScrollEls || [];
  const gridEls = [];
  for (let i = 0; i < scrollEls.length; i++) {
    if (!preExtractedGrids[i]) continue;
    gridEls.push({ el: scrollEls[i], md: preExtractedGrids[i], y: pageRect(scrollEls[i]).y });
  }

  function insideAnyGrid(el) {
    for (const g of gridEls) {
      if (g.el.contains(el)) return true;
    }
    return false;
  }

  const texts = [];
  const all = document.body ? document.body.getElementsByTagName('*') : [];
  for (const el of all) {
    if (el.children.length > 0) continue;
    if (SKIP_TAGS.has(el.tagName)) continue;
    const text = el.textContent.trim();
    if (!text) continue;
    if (insideAnyGrid(el)) continue;
    try {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
    } catch (e) { continue; }
    const r = pageRect(el);
    if (r.w < 1 || r.h < 1) continue;
    if (!intersects(r, selPageRect)) continue;
    texts.push({ y: r.y, x: r.x, text });
  }

  texts.sort((a, b) => a.y - b.y || a.x - b.x);

  // Group into lines (same Y within tolerance)
  const lines = [];
  let curLine = null;
  for (const t of texts) {
    if (!curLine || Math.abs(t.y - curLine.y) > 6) {
      if (curLine) lines.push(curLine);
      curLine = { y: t.y, parts: [t.text] };
    } else {
      curLine.parts.push(t.text);
    }
  }
  if (curLine) lines.push(curLine);

  const entries = lines.map((l) => ({ y: l.y, type: 'text', data: l.parts.join(' ') }));
  for (const g of gridEls) {
    entries.push({ y: g.y, type: 'grid', data: g.md });
  }
  entries.sort((a, b) => a.y - b.y);

  for (const e of entries) {
    if (e.type === 'grid') md += '\n' + e.data + '\n';
    else md += e.data + '\n';
  }

  return md.replace(/\n{3,}/g, '\n\n');
}
