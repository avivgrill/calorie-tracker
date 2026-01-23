import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, query, where, getDocs, orderBy, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const GEMINI_KEY = "AIzaSyB4wv6tRcAnIzQGrBLaD5MakVIbxlurxTg";

let allLogs = [];

onAuthStateChanged(auth, (user) => {
    document.getElementById('auth-view').classList.toggle('hidden', !!user);
    document.getElementById('app-view').classList.toggle('hidden', !user);
    if (user) { loadData(user.uid); loadProfile(user.uid); }
});

// --- AI LOGIC (With Safety) ---
async function callGemini(text) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
    
    const body = {
        contents: [{
            parts: [{
                text: `You are an expert nutritionist and fitness coach. 
                User Input: "${text}"
                
                Task:
                1. Identify if this is primarily a "meal" or "exercise".
                2. If it's a complicated story, break it down into parts and sum the total calories.
                3. For "3/5 of a piece of cheese", calculate (Standard Calorie * 0.6).
                4. For "grilled with butter", add 100 calories for the fat.
                5. If exercise, use intensity to estimate burn (e.g., "heavy lifting" vs "stretching").
                
                Output ONLY valid JSON in this exact structure:
                {"type":"meal"|"exercise","name":"Short Descriptive Name","cals":number,"pro":number,"fib":number,"sug":number,"fat":number}`
            }]
        }]
    };

    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    
    if (data.error) throw new Error(data.error.message);
    
    // Clean up response: Find the first { and last } to avoid extra text
    let raw = data.candidates[0].content.parts[0].text;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    
    if (start === -1 || end === -1) throw new Error("AI could not format data.");
    
    const cleanJson = JSON.parse(raw.substring(start, end + 1));

    // Final check to ensure "Unknown Entry" isn't used if we have a real name
    return {
        type: cleanJson.type || "meal",
        name: cleanJson.name && cleanJson.name !== "string" ? cleanJson.name : "Detailed Entry",
        cals: Number(cleanJson.cals) || 0,
        pro: Number(cleanJson.pro) || 0,
        fib: Number(cleanJson.fib) || 0,
        sug: Number(cleanJson.sug) || 0,
        fat: Number(cleanJson.fat) || 0
    };
}
// --- DATA ENGINE ---
async function loadData(uid) {
    const q = query(collection(db, "logs"), where("uid", "==", uid), orderBy("timestamp", "desc"));
    const snap = await getDocs(q);
    allLogs = snap.docs.map(d => ({ id: d.id, ...d.data(), date: d.data().timestamp.toDate() }));
    renderHome(); renderMaster();
}

function renderHome() {
    const today = new Date().toLocaleDateString();
    const list = document.getElementById('log-list');
    list.innerHTML = "";
    
    let t = { in: 0, out: 0, p: 0, f: 0, s: 0, ft: 0 };
    const bmr = parseInt(document.getElementById('p-bmr-display').innerText) || 0;

    allLogs.filter(l => l.date.toLocaleDateString() === today).forEach(item => {
        list.appendChild(createLogEl(item));
        if (item.type === 'meal') {
            t.in += (item.cals || 0); t.p += (item.pro||0); t.f += (item.fib||0); t.s += (item.sug||0); t.ft += (item.fat||0);
        } else { t.out += (item.cals || 0); }
    });

    document.getElementById('d-in').innerText = Math.round(t.in);
    document.getElementById('d-out').innerText = Math.round(t.out);
    document.getElementById('d-net').innerText = Math.round(t.in - t.out - bmr);
    document.getElementById('h-pro').innerText = t.p.toFixed(0);
    document.getElementById('h-fib').innerText = t.f.toFixed(0);
    document.getElementById('h-sug').innerText = t.s.toFixed(0);
    document.getElementById('h-fat').innerText = t.ft.toFixed(0);
}

function renderMaster() {
    const list = document.getElementById('master-list');
    list.innerHTML = "";
    let lastDate = "";
    allLogs.forEach(item => {
        const dateStr = item.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        if (dateStr !== lastDate) {
            const h = document.createElement('div'); 
            h.style = "font-weight:700; color:#b2bec3; font-size:0.8rem; margin:15px 0 5px; text-transform:uppercase;";
            h.innerText = dateStr;
            list.appendChild(h); lastDate = dateStr;
        }
        list.appendChild(createLogEl(item));
    });
}

function createLogEl(item) {
    const div = document.createElement('div');
    div.className = `entry ${item.type}`;
    const sign = item.type === 'exercise' ? '-' : '+';
    div.innerHTML = `
        <div class="entry-info">
            <span class="entry-name">${item.name}</span>
            <span class="entry-cals ${item.type === 'exercise' ? 'exercise-val' : ''}">${sign}${Math.round(item.cals)} kcal</span>
        </div>
        <button class="del-btn" onclick="deleteEntry('${item.id}')">×</button>
    `;
    return div;
}

window.deleteEntry = async (id) => {
    if(confirm("Delete this log?")) {
        await deleteDoc(doc(db, "logs", id));
        loadData(auth.currentUser.uid);
    }
};

// --- SMART STATS (Ignore Empty Days) ---
function runAdvancedStats(days) {
    const cutoff = new Date(); cutoff.setDate(new Date().getDate() - days);
    const filtered = allLogs.filter(l => l.date >= cutoff);
    const bmr = parseInt(document.getElementById('p-bmr-display').innerText) || 0;

    // Count unique active days
    const uniqueDays = new Set(filtered.map(l => l.date.toDateString())).size || 1; 

    let t = { cIn: 0, cOut: 0, p: 0, f: 0, s: 0, ft: 0 };
    filtered.forEach(l => {
        if(l.type === 'meal') {
            t.cIn += (l.cals||0); t.p += (l.pro||0); t.f += (l.fib||0); t.s += (l.sug||0); t.ft += (l.fat||0);
        } else { t.cOut += (l.cals||0); }
    });

    // Fat Loss = (Total Burn + (BMR * Active Days) - Total Eaten) / 3500
    const deficit = (t.cOut + (bmr * uniqueDays)) - t.cIn;
    const lbs = (deficit / 3500).toFixed(2);

    document.getElementById('stats-output').innerHTML = `
        <div style="background: #e3fcef; padding: 20px; border-radius: 16px; text-align: center; margin-bottom: 20px;">
            <small style="color:#00b894; font-weight:700;">EST. FAT LOSS (${uniqueDays} ACTIVE DAYS)</small><br>
            <b style="font-size: 1.8rem; color: #2d3436;">${lbs} lbs</b>
        </div>
        <div class="advanced-grid">
            <div class="adv-card"><small>AVG CALORIES</small><b>${Math.round(t.cIn/uniqueDays)}</b></div>
            <div class="adv-card"><small>AVG PROTEIN</small><b>${(t.p/uniqueDays).toFixed(0)}g</b></div>
            <div class="adv-card"><small>AVG FIBER</small><b>${(t.f/uniqueDays).toFixed(0)}g</b></div>
            <div class="adv-card"><small>AVG SUGAR</small><b>${(t.s/uniqueDays).toFixed(0)}g</b></div>
            <div class="adv-card"><small>AVG FAT</small><b>${(t.ft/uniqueDays).toFixed(0)}g</b></div>
            <div class="adv-card"><small>TOTAL BURN</small><b>${Math.round(t.cOut)}</b></div>
        </div>
    `;
}

document.getElementById('btn-7').onclick = (e) => { 
    document.querySelectorAll('#tab-stats .nav-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active'); runAdvancedStats(7); 
};
document.getElementById('btn-30').onclick = (e) => { 
    document.querySelectorAll('#tab-stats .nav-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active'); runAdvancedStats(30); 
};

// --- INPUTS & PROFILE ---
document.getElementById('ai-btn').onclick = async () => {
    const input = document.getElementById('ai-input');
    const status = document.getElementById('status-msg');
    if(!input.value) return;
    status.innerText = "Consulting AI Nutritionist...";
    try {
        const result = await callGemini(input.value);
        await addDoc(collection(db, "logs"), { uid: auth.currentUser.uid, timestamp: new Date(), ...result });
        input.value = ""; status.innerText = "";
        loadData(auth.currentUser.uid);
    } catch (err) { status.innerText = "Error: " + err.message; }
};
document.getElementById('ai-input').onkeypress = (e) => { if (e.key === 'Enter') document.getElementById('ai-btn').click(); };

async function loadProfile(uid) {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
        const d = snap.data();
        document.getElementById('p-weight').value = d.weight || "";
        document.getElementById('p-height').value = d.height || "";
        document.getElementById('p-age').value = d.age || "";
        document.getElementById('p-gender').value = d.gender || "male";
        document.getElementById('p-bmr-display').innerText = d.bmr || 0;
    }
}
document.getElementById('save-profile').onclick = async () => {
    const w = parseFloat(document.getElementById('p-weight').value);
    const h = parseFloat(document.getElementById('p-height').value);
    const a = parseInt(document.getElementById('p-age').value);
    const g = document.getElementById('p-gender').value;
    if(!w || !h || !a) return alert("Fill all fields");
    
    // Mifflin-St Jeor Equation
    const kg = w * 0.453592; const cm = h * 2.54;
    let bmr = (10 * kg) + (6.25 * cm) - (5 * a);
    bmr = Math.round(g === 'male' ? bmr + 5 : bmr - 161);

    await setDoc(doc(db, "users", auth.currentUser.uid), { weight:w, height:h, age:a, gender:g, bmr:bmr }, { merge: true });
    document.getElementById('p-bmr-display').innerText = bmr;
    alert("Profile Updated!"); loadData(auth.currentUser.uid);
};

// --- AUTH ---
document.getElementById('login-btn').onclick = async () => {
    const email = document.getElementById('email').value;
    const pass = document.getElementById('password').value;
    try { await signInWithEmailAndPassword(auth, email, pass); } 
    catch (err) { document.getElementById('login-error').innerText = err.message; }
};
document.getElementById('logout-btn').onclick = () => signOut(auth);