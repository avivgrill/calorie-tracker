import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
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
                text: `You are an expert nutritionist with access to accurate brand food nutrition databases. Your task is to analyze user input and extract precise nutrition information.

User Input: "${text}"

CRITICAL INSTRUCTIONS:
1. Identify if this is primarily a "meal" or "exercise".
2. For BRAND-SPECIFIC FOODS (e.g., "Pringles", "McDonald's Big Mac", "Coca-Cola", "Oreos", "Cheerios"):
   - Use your knowledge of actual nutrition facts for these specific branded products
   - Look up standard serving sizes and nutrition values for the brand mentioned
   - If a quantity is mentioned (e.g., "2 Pringles", "a can of Coke"), calculate accordingly
   - Be precise with brand-specific data, not generic estimates
3. For RAMBLING or STORY-LIKE INPUTS:
   - Extract all food items mentioned, even if scattered throughout the text
   - Break down complex narratives into individual food components
   - Sum all calories and macros from all mentioned foods
   - Ignore irrelevant details, focus on food/exercise mentions
   - Example: "So I was at the store and then I had like 3 Pringles and also some water and then later I ate a sandwich" → extract: 3 Pringles + sandwich
4. For PORTIONS and FRACTIONS:
   - "3/5 of a piece of cheese" = (Standard Calorie * 0.6)
   - "half a pizza" = (Full Pizza Calories * 0.5)
   - Always calculate precise portions
5. For COOKING METHODS:
   - "grilled with butter" → add ~100 calories for butter
   - "fried" → add ~50-150 calories depending on amount
   - "with olive oil" → add ~120 calories per tablespoon
6. For EXERCISE:
   - Use intensity and duration to estimate burn accurately
   - "heavy lifting for 30 min" vs "stretching for 10 min" have very different burns
7. ALWAYS OUTPUT NUMBERS:
   - If uncertain, make your best educated estimate based on similar foods
   - Never return null, undefined, or non-numeric values
   - All numbers must be integers or decimals (e.g., 250, 12.5, 0)
   - If you cannot determine a value, use 0 but still provide other accurate values

Output ONLY valid JSON in this exact structure (no markdown, no code blocks, just pure JSON):
{"type":"meal"|"exercise","name":"Short Descriptive Name","cals":number,"pro":number,"fib":number,"sug":number,"fat":number}

IMPORTANT: 
- "cals", "pro", "fib", "sug", "fat" must ALL be numbers (not strings, not null)
- "name" should be a concise description (e.g., "3 Pringles Original", "Big Mac", "30 min heavy lifting")
- Extract the essence even from rambling text - focus on actionable nutrition data`
            }]
        }]
    };

    try {
        const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
        const data = await res.json();
        
        if (data.error) throw new Error(data.error.message);
        
        // Clean up response: Find the first { and last } to avoid extra text
        let raw = data.candidates[0].content.parts[0].text;
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        
        if (start === -1 || end === -1) throw new Error("AI could not format data.");
        
        const cleanJson = JSON.parse(raw.substring(start, end + 1));

        // Robust number parsing with fallbacks
        const parseNumber = (val, fallback = 0) => {
            if (val === null || val === undefined || val === '') return fallback;
            const num = Number(val);
            return isNaN(num) ? fallback : Math.max(0, num); // Ensure non-negative
        };

        // Final check to ensure all values are valid numbers
        const result = {
            type: (cleanJson.type === "exercise" || cleanJson.type === "meal") ? cleanJson.type : "meal",
            name: (cleanJson.name && typeof cleanJson.name === "string" && cleanJson.name.trim() !== "" && cleanJson.name !== "string") 
                ? cleanJson.name.trim() 
                : "Food Entry",
            cals: parseNumber(cleanJson.cals, 0),
            pro: parseNumber(cleanJson.pro, 0),
            fib: parseNumber(cleanJson.fib, 0),
            sug: parseNumber(cleanJson.sug, 0),
            fat: parseNumber(cleanJson.fat, 0)
        };

        return result;
    } catch (err) {
        // Enhanced error handling - return a safe default instead of crashing
        console.error("Gemini API Error:", err);
        return {
            type: "meal",
            name: "Error - Please try rephrasing",
            cals: 0,
            pro: 0,
            fib: 0,
            sug: 0,
            fat: 0
        };
    }
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
    const tdee = parseInt(document.getElementById('p-tdee-display').innerText) || 0;

    allLogs.filter(l => l.date.toLocaleDateString() === today).forEach(item => {
        list.appendChild(createLogEl(item));
        if (item.type === 'meal') {
            t.in += (item.cals || 0); t.p += (item.pro||0); t.f += (item.fib||0); t.s += (item.sug||0); t.ft += (item.fat||0);
        } else { t.out += (item.cals || 0); }
    });

    document.getElementById('d-in').innerText = Math.round(t.in);
    document.getElementById('d-out').innerText = Math.round(t.out);
    document.getElementById('d-net').innerText = Math.round(t.in - t.out - tdee);
    document.getElementById('h-pro').innerText = t.p.toFixed(0);
    document.getElementById('h-fib').innerText = t.f.toFixed(0);
    document.getElementById('h-sug').innerText = t.s.toFixed(0);
    document.getElementById('h-fat').innerText = t.ft.toFixed(0);
    
    // Reset delete button
    updateDeleteButton();
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
    
    // Reset delete button
    updateDeleteButton();
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
        <input type="checkbox" class="entry-checkbox" data-id="${item.id}" onchange="updateDeleteButton()">
    `;
    return div;
}

window.updateDeleteButton = () => {
    const checkboxes = document.querySelectorAll('.entry-checkbox:checked');
    const deleteSelectedBtnHome = document.getElementById('delete-selected-btn-home');
    const deleteSelectedBtnMaster = document.getElementById('delete-selected-btn-master');
    
    const updateButton = (btn) => {
        if (btn) {
            if (checkboxes.length > 0) {
                btn.style.display = 'block';
                btn.innerText = `Delete Selected (${checkboxes.length})`;
            } else {
                btn.style.display = 'none';
            }
        }
    };
    
    updateButton(deleteSelectedBtnHome);
    updateButton(deleteSelectedBtnMaster);
};

window.deleteSelected = async () => {
    const checkboxes = document.querySelectorAll('.entry-checkbox:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.dataset.id);
    
    if (selectedIds.length === 0) return;
    
    const count = selectedIds.length;
    if (confirm(`Delete ${count} selected item${count > 1 ? 's' : ''}?`)) {
        // Delete all selected items
        await Promise.all(selectedIds.map(id => deleteDoc(doc(db, "logs", id))));
        loadData(auth.currentUser.uid);
    }
};

window.downloadData = () => {
    if (allLogs.length === 0) {
        alert("No data to download.");
        return;
    }
    
    // Create CSV headers
    const headers = ['Date', 'Time', 'Type', 'Name', 'Calories', 'Protein (g)', 'Fiber (g)', 'Sugar (g)', 'Fat (g)'];
    
    // Convert logs to CSV rows
    const rows = allLogs.map(log => {
        const date = log.date.toLocaleDateString('en-US');
        const time = log.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        return [
            date,
            time,
            log.type || '',
            `"${(log.name || '').replace(/"/g, '""')}"`, // Escape quotes in CSV
            log.cals || 0,
            log.pro || 0,
            log.fib || 0,
            log.sug || 0,
            log.fat || 0
        ];
    });
    
    // Combine headers and rows
    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.join(','))
    ].join('\n');
    
    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    // Generate filename with current date
    const today = new Date().toISOString().split('T')[0];
    link.setAttribute('href', url);
    link.setAttribute('download', `calorie-tracker-export-${today}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

// --- SMART STATS (Ignore Empty Days) ---
function runAdvancedStats(days) {
    const cutoff = new Date(); cutoff.setDate(new Date().getDate() - days);
    const filtered = allLogs.filter(l => l.date >= cutoff);
    const tdee = parseInt(document.getElementById('p-tdee-display').innerText) || 0;

    // Count unique active days
    const uniqueDays = new Set(filtered.map(l => l.date.toDateString())).size || 1; 

    let t = { cIn: 0, cOut: 0, p: 0, f: 0, s: 0, ft: 0 };
    filtered.forEach(l => {
        if(l.type === 'meal') {
            t.cIn += (l.cals||0); t.p += (l.pro||0); t.f += (l.fib||0); t.s += (l.sug||0); t.ft += (l.fat||0);
        } else { t.cOut += (l.cals||0); }
    });

    // Fat Loss = (Total Burn + (TDEE * Active Days) - Total Eaten) / 3500
    const deficit = (t.cOut + (tdee * uniqueDays)) - t.cIn;
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
    if(!input.value.trim()) return;
    
    const originalValue = input.value;
    status.innerText = "Consulting AI Nutritionist...";
    
    try {
        const result = await callGemini(originalValue);
        
        // Check if we got an error placeholder result
        if (result.name === "Error - Please try rephrasing") {
            status.innerText = "Could not parse entry. Try being more specific (e.g., '2 Pringles' or 'grilled chicken breast').";
            return;
        }
        
        // Always save the result - even if calories are 0, the AI made its best estimate
        await addDoc(collection(db, "logs"), { uid: auth.currentUser.uid, timestamp: new Date(), ...result });
        input.value = ""; 
        status.innerText = "✓ Entry added successfully!";
        setTimeout(() => { status.innerText = ""; }, 2000);
        loadData(auth.currentUser.uid);
    } catch (err) { 
        console.error("Error adding entry:", err);
        status.innerText = "Error: " + (err.message || "Failed to process entry. Please try again.");
    }
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
        document.getElementById('p-activity').value = d.activityLevel || "1.2";
        document.getElementById('p-tdee-display').innerText = d.tdee || 0;
    }
}
document.getElementById('save-profile').onclick = async () => {
    const w = parseFloat(document.getElementById('p-weight').value);
    const h = parseFloat(document.getElementById('p-height').value);
    const a = parseInt(document.getElementById('p-age').value);
    const g = document.getElementById('p-gender').value;
    const activityMultiplier = parseFloat(document.getElementById('p-activity').value);
    if(!w || !h || !a) return alert("Fill all fields");
    
    // Mifflin-St Jeor Equation for BMR
    const kg = w * 0.453592; const cm = h * 2.54;
    let bmr = (10 * kg) + (6.25 * cm) - (5 * a);
    bmr = g === 'male' ? bmr + 5 : bmr - 161;
    
    // Calculate TDEE = BMR * Activity Multiplier
    const tdee = Math.round(bmr * activityMultiplier);

    await setDoc(doc(db, "users", auth.currentUser.uid), { 
        weight:w, 
        height:h, 
        age:a, 
        gender:g, 
        activityLevel: activityMultiplier,
        bmr: Math.round(bmr),
        tdee: tdee 
    }, { merge: true });
    document.getElementById('p-tdee-display').innerText = tdee;
    alert("Profile Updated!"); loadData(auth.currentUser.uid);
};

// --- AUTH ---
// Check if user is coming from email link (run after DOM is ready)
function handleEmailLinkSignIn() {
    if (isSignInWithEmailLink(auth, window.location.href)) {
        let email = window.localStorage.getItem('emailForSignIn');
        if (!email) {
            email = window.prompt('Please provide your email for confirmation');
        }
        if (email) {
            signInWithEmailLink(auth, email, window.location.href)
                .then(() => {
                    window.localStorage.removeItem('emailForSignIn');
                    // Clear the URL parameters
                    window.history.replaceState({}, document.title, window.location.pathname);
                })
                .catch((err) => {
                    console.error('Error signing in with email link:', err);
                    const errorEl = document.getElementById('login-error');
                    if (errorEl) {
                        errorEl.innerText = err.message;
                    }
                });
        }
    }
}

// Run email link check when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handleEmailLinkSignIn);
} else {
    handleEmailLinkSignIn();
}

document.getElementById('login-btn').onclick = async () => {
    const email = document.getElementById('email').value.trim();
    const errorEl = document.getElementById('login-error');
    const successEl = document.getElementById('login-success');
    const btn = document.getElementById('login-btn');
    
    if (!email) {
        errorEl.innerText = "Please enter your email address";
        successEl.style.display = 'none';
        return;
    }
    
    if (!email.includes('@')) {
        errorEl.innerText = "Please enter a valid email address";
        successEl.style.display = 'none';
        return;
    }
    
    errorEl.innerText = "";
    successEl.style.display = 'none';
    btn.disabled = true;
    btn.innerText = "Sending...";
    
    try {
        // Get the current URL - use full URL including hash if needed
        const currentUrl = window.location.href.split('#')[0]; // Remove hash if present
        const actionCodeSettings = {
            url: currentUrl,
            handleCodeInApp: true,
        };
        
        console.log('Sending email link to:', email);
        console.log('Action code URL:', currentUrl);
        
        await sendSignInLinkToEmail(auth, email, actionCodeSettings);
        
        // Store email in localStorage for when they click the link
        window.localStorage.setItem('emailForSignIn', email);
        
        successEl.innerText = `✓ Login link sent to ${email}! Check your inbox (and spam folder) and click the link to sign in.`;
        successEl.style.display = 'block';
        document.getElementById('email').value = "";
        
        console.log('Email link sent successfully');
    } catch (err) {
        console.error('Error sending email link:', err);
        console.error('Error code:', err.code);
        console.error('Error message:', err.message);
        
        let errorMessage = "Error: " + err.message;
        
        // Provide more helpful error messages
        if (err.code === 'auth/unauthorized-domain') {
            errorMessage = "Error: This domain is not authorized. Please add " + window.location.hostname + " to Firebase authorized domains.";
        } else if (err.code === 'auth/invalid-email') {
            errorMessage = "Error: Invalid email address. Please check and try again.";
        } else if (err.code === 'auth/operation-not-allowed') {
            errorMessage = "Error: Email link authentication is not enabled. Please enable it in Firebase Console under Authentication > Sign-in method.";
        } else if (err.message) {
            errorMessage = "Error: " + err.message;
        }
        
        errorEl.innerText = errorMessage;
        successEl.style.display = 'none';
    } finally {
        btn.disabled = false;
        btn.innerText = "Send Login Link";
    }
};

document.getElementById('logout-btn').onclick = () => signOut(auth);