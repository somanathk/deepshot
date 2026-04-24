const statusEl = document.getElementById('status');
let selectedFormat = 'png';

// Format selection
document.querySelectorAll('.format-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.format-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedFormat = btn.dataset.format;
  });
});

// Listen for status updates from background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    statusEl.textContent = msg.msg;
  }
});

// Capture buttons - send message to background worker and close popup
document.getElementById('captureExpanded').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'capture',
    expandScrolls: true,
    format: selectedFormat,
  });
  statusEl.textContent = 'Capturing... (you can close this popup)';
});

document.getElementById('captureNormal').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'capture',
    expandScrolls: false,
    format: selectedFormat,
  });
  statusEl.textContent = 'Capturing... (you can close this popup)';
});

document.getElementById('captureSelection').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'capture',
    mode: 'selection',
    expandScrolls: true,
    format: selectedFormat,
  });
  statusEl.textContent = 'Drag a region on the page...';
  window.close();
});
