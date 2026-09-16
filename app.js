import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const supabase = createClient('https://xxvxmefrrkuurlnxyxsn.supabase.co', 'sb_publishable_sb_FFicGYl7AZS8wxL8GvA_ev8j0Btp');
const $ = (s) => document.querySelector(s);
const form = $('#food-form'), authForm = $('#auth-form'), email = $('#email');
const foodCard = $('#food-card'), signedIn = $('#signed-in'), signedInEmail = $('#signed-in-email');
const authMessage = $('#auth-message'), nameInput = $('#food-name'), dateInput = $('#food-date');
const barcodeInput = $('#barcode'), locationInput = $('#food-location'), quantityInput = $('#food-quantity'), unitInput = $('#food-unit');
const lookupButton = $('#lookup-barcode'), scanButton = $('#start-scan'), scannerElement = $('#scanner'), scanMessage = $('#scan-message');
const foods = $('#foods'), empty = $('#empty-state'), clearAll = $('#clear-all'), template = $('#food-template');
let entries = [], scanner, isScanning = false;

function message(target, text, error = false) { target.textContent = text; target.style.color = error ? '#9a3d31' : ''; }
function daysUntil(date) { const t = new Date(`${date}T12:00:00`), n = new Date(); n.setHours(12, 0, 0, 0); return Math.round((t - n) / 86400000); }
function status(days) {
  if (days < 0) return ['expired', `Périmé depuis ${Math.abs(days)} jour${days === -1 ? '' : 's'}`];
  if (days === 0) return ['today', 'À consommer aujourd’hui'];
  if (days === 1) return ['soon', 'À consommer demain'];
  return days <= 3 ? ['soon', `À consommer dans ${days} jours`] : ['later', `À consommer dans ${days} jours`];
}
function quantityLabel(item) { const q = Number(item.quantity || 1), u = item.unit || 'unité'; return `${q} ${u}${u === 'unité' && q > 1 ? 's' : ''} · ${item.location || 'Frigo'}`; }

function render() {
  entries.sort((a, b) => a.date.localeCompare(b.date)); foods.innerHTML = '';
  empty.hidden = Boolean(entries.length); clearAll.hidden = !entries.length;
  for (const item of entries) {
    const node = template.content.cloneNode(true), row = node.querySelector('li'), [kind, label] = status(daysUntil(item.date));
    row.classList.add(kind); node.querySelector('strong').textContent = item.name;
    node.querySelector('.food-meta').textContent = quantityLabel(item); node.querySelector('.food-date').textContent = label;
    node.querySelector('.delete-button').addEventListener('click', () => removeFood(item.id)); foods.append(node);
  }
}
async function loadFoods() {
  const { data, error } = await supabase.from('food_items').select('*').order('expires_on');
  if (error) return message(authMessage, 'Impossible de charger ton frigo. Réessaie dans un instant.', true);
  entries = data.map((item) => ({ ...item, date: item.expires_on })); render();
}
async function setSession(session) {
  const user = session?.user, connected = Boolean(user); foodCard.hidden = !connected; authForm.hidden = connected; signedIn.hidden = !connected;
  if (connected) { signedInEmail.textContent = `Connecté avec ${user.email}`; message(authMessage, 'Ton frigo est synchronisé.'); await loadFoods(); }
  else { entries = []; render(); message(authMessage, ''); }
}

async function lookupProduct(code) {
  const clean = code.replace(/\D/g, '');
  if (clean.length < 8) return message(scanMessage, 'Entre un code-barres valide, ou utilise le scan.', true);
  barcodeInput.value = clean; lookupButton.disabled = true; lookupButton.textContent = '…'; message(scanMessage, 'Recherche du produit…');
  try {
    const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json?fields=product_name,product_name_fr,brands`);
    const data = await response.json(), product = data.product, productName = product?.product_name_fr || product?.product_name;
    if (!response.ok || !productName) { message(scanMessage, 'Produit introuvable : tu peux saisir son nom à la main.', true); return nameInput.focus(); }
    nameInput.value = product.brands ? `${productName} — ${product.brands}` : productName; message(scanMessage, 'Produit trouvé. Il ne reste plus que la date.'); dateInput.focus();
  } catch { message(scanMessage, 'Impossible de contacter la base produits. Tu peux ajouter le nom à la main.', true); }
  finally { lookupButton.disabled = false; lookupButton.textContent = 'Chercher'; }
}
async function stopScanner() { if (scanner && isScanning) await scanner.stop(); isScanning = false; scannerElement.hidden = true; scanButton.textContent = 'Scanner un code-barres'; }
async function startScanner() {
  if (isScanning) return stopScanner();
  if (!window.Html5Qrcode) return message(scanMessage, 'Le lecteur de code-barres n’a pas pu se charger. Utilise le champ ci-dessous.', true);
  scannerElement.hidden = false; scanButton.textContent = 'Arrêter le scan'; message(scanMessage, 'Cadre le code-barres dans l’image.'); scanner = scanner || new Html5Qrcode('scanner');
  try {
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 280, height: 130 }, formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E] }, async (code) => { await stopScanner(); barcodeInput.value = code; lookupProduct(code); }, () => {}); isScanning = true;
  } catch { await stopScanner(); message(scanMessage, 'La caméra est inaccessible. Autorise-la dans le navigateur, ou saisis le code à la main.', true); }
}
async function removeFood(id) { const { error } = await supabase.from('food_items').delete().eq('id', id); if (error) return message(authMessage, 'Impossible de supprimer cet aliment.', true); loadFoods(); }

authForm.addEventListener('submit', async (event) => {
  event.preventDefault(); const { error } = await supabase.auth.signInWithOtp({ email: email.value.trim(), options: { emailRedirectTo: window.location.href } });
  message(authMessage, error ? 'Impossible d’envoyer le lien. Réessaie.' : 'Lien envoyé : ouvre ton e-mail puis reviens ici.', Boolean(error));
});
$('#sign-out').addEventListener('click', () => supabase.auth.signOut());
form.addEventListener('submit', async (event) => {
  event.preventDefault(); const { error } = await supabase.from('food_items').insert({ name: nameInput.value.trim(), expires_on: dateInput.value, barcode: barcodeInput.value || null, location: locationInput.value, quantity: quantityInput.value, unit: unitInput.value });
  if (error) return message(authMessage, 'Impossible d’ajouter cet aliment. Réessaie.', true);
  form.reset(); quantityInput.value = 1; await loadFoods(); nameInput.focus();
});
clearAll.addEventListener('click', async () => {
  if (!confirm('Supprimer tous les aliments ?')) return;
  const { error } = await supabase.from('food_items').delete().in('id', entries.map((item) => item.id));
  if (error) return message(authMessage, 'Impossible de vider le frigo.', true); loadFoods();
});
lookupButton.addEventListener('click', () => lookupProduct(barcodeInput.value));
barcodeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); lookupProduct(barcodeInput.value); } });
scanButton.addEventListener('click', startScanner); dateInput.min = new Date().toISOString().slice(0, 10);
const { data: { session } } = await supabase.auth.getSession(); await setSession(session); supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
