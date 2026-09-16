const form = document.querySelector('#food-form');
const nameInput = document.querySelector('#food-name');
const dateInput = document.querySelector('#food-date');
const barcodeInput = document.querySelector('#barcode');
const locationInput = document.querySelector('#food-location');
const quantityInput = document.querySelector('#food-quantity');
const unitInput = document.querySelector('#food-unit');
const lookupButton = document.querySelector('#lookup-barcode');
const scanButton = document.querySelector('#start-scan');
const scannerElement = document.querySelector('#scanner');
const scanMessage = document.querySelector('#scan-message');
const foods = document.querySelector('#foods');
const empty = document.querySelector('#empty-state');
const clearAll = document.querySelector('#clear-all');
const template = document.querySelector('#food-template');
const storageKey = 'frigo-solo-foods';

let entries = JSON.parse(localStorage.getItem(storageKey) || '[]');
let scanner;
let isScanning = false;

function barcodeError(message) {
  scanMessage.textContent = message;
  scanMessage.style.color = '#9a3d31';
}

function barcodeInfo(message) {
  scanMessage.textContent = message;
  scanMessage.style.color = '';
}

async function lookupProduct(code) {
  const cleanCode = code.replace(/\D/g, '');
  if (cleanCode.length < 8) {
    barcodeError('Entre un code-barres valide, ou utilise le scan.');
    return false;
  }
  barcodeInput.value = cleanCode;
  lookupButton.disabled = true;
  lookupButton.textContent = '…';
  barcodeInfo('Recherche du produit…');
  try {
    const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(cleanCode)}.json?fields=product_name,product_name_fr,brands`);
    if (!response.ok) throw new Error('network');
    const data = await response.json();
    const product = data.product;
    const productName = product?.product_name_fr || product?.product_name;
    if (!productName) {
      barcodeError('Produit introuvable : tu peux saisir son nom à la main.');
      nameInput.focus();
      return false;
    }
    nameInput.value = product.brands ? `${productName} — ${product.brands}` : productName;
    barcodeInfo('Produit trouvé. Il ne reste plus que la date.');
    dateInput.focus();
    return true;
  } catch {
    barcodeError('Impossible de contacter la base produits. Tu peux ajouter le nom à la main.');
    return false;
  } finally {
    lookupButton.disabled = false;
    lookupButton.textContent = 'Chercher';
  }
}

async function stopScanner() {
  if (scanner && isScanning) await scanner.stop();
  isScanning = false;
  scannerElement.hidden = true;
  scanButton.textContent = 'Scanner un code-barres';
}

async function startScanner() {
  if (isScanning) { await stopScanner(); return; }
  if (!window.Html5Qrcode) {
    barcodeError('Le lecteur de code-barres n’a pas pu se charger. Utilise le champ ci-dessous.');
    return;
  }
  scannerElement.hidden = false;
  scanButton.textContent = 'Arrêter le scan';
  barcodeInfo('Cadre le code-barres dans l’image.');
  scanner = scanner || new Html5Qrcode('scanner');
  try {
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 280, height: 130 }, formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E] }, async (decodedText) => {
      await stopScanner();
      barcodeInput.value = decodedText;
      await lookupProduct(decodedText);
    }, () => {});
    isScanning = true;
  } catch {
    await stopScanner();
    barcodeError('La caméra est inaccessible. Autorise-la dans le navigateur, ou saisis le code à la main.');
  }
}

function daysUntil(dateString) {
  const target = new Date(`${dateString}T12:00:00`);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function status(days) {
  if (days < 0) return ['expired', `Périmé depuis ${Math.abs(days)} jour${days === -1 ? '' : 's'}`];
  if (days === 0) return ['today', 'À consommer aujourd’hui'];
  if (days === 1) return ['soon', 'À consommer demain'];
  if (days <= 3) return ['soon', `À consommer dans ${days} jours`];
  return ['later', `À consommer dans ${days} jours`];
}

function save() { localStorage.setItem(storageKey, JSON.stringify(entries)); }

function quantityLabel(entry) {
  const quantity = Number(entry.quantity || 1);
  const unit = entry.unit || 'unité';
  return `${quantity} ${unit}${unit === 'unité' && quantity > 1 ? 's' : ''} · ${entry.location || 'Frigo'}`;
}

function render() {
  entries.sort((a, b) => a.date.localeCompare(b.date));
  foods.innerHTML = '';
  empty.hidden = entries.length > 0;
  clearAll.hidden = entries.length === 0;
  for (const entry of entries) {
    const node = template.content.cloneNode(true);
    const item = node.querySelector('li');
    const [kind, message] = status(daysUntil(entry.date));
    item.classList.add(kind);
    node.querySelector('strong').textContent = entry.name;
    node.querySelector('.food-meta').textContent = quantityLabel(entry);
    node.querySelector('.food-date').textContent = message;
    node.querySelector('.delete-button').addEventListener('click', () => {
      entries = entries.filter((item) => item.id !== entry.id);
      save(); render();
    });
    foods.append(node);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  entries.push({
    id: crypto.randomUUID(), name: nameInput.value.trim(), date: dateInput.value,
    barcode: barcodeInput.value, location: locationInput.value,
    quantity: quantityInput.value, unit: unitInput.value,
  });
  save(); render(); form.reset(); nameInput.focus();
});

lookupButton.addEventListener('click', () => lookupProduct(barcodeInput.value));
barcodeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); lookupProduct(barcodeInput.value); } });
scanButton.addEventListener('click', startScanner);

clearAll.addEventListener('click', () => {
  if (confirm('Supprimer tous les aliments ?')) { entries = []; save(); render(); }
});

dateInput.min = new Date().toISOString().slice(0, 10);
render();
