import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, query, where, getDocs, orderBy, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

// Optional external data sources for higher accuracy
const NUTRITIONIX_APP_ID = "";
const NUTRITIONIX_API_KEY = "";
const USDA_API_KEY = "";

const estimationCache = new Map();

let allLogs = [];

onAuthStateChanged(auth, (user) => {
    document.getElementById('auth-view').classList.toggle('hidden', !!user);
    document.getElementById('app-view').classList.toggle('hidden', !user);
    if (user) { loadData(user.uid); loadProfile(user.uid); }
});

// --- AI LOGIC (Unified Estimation with Expert Prompt) ---

/**
 * Main entry point for AI-powered calorie estimation.
 * Uses a comprehensive prompt that parses, estimates, and summarizes in one call.
 */
async function callGemini(text) {
    const userWeightLbs = getUserWeightLbs();
    const result = await estimateWithGemini(text, userWeightLbs);
    return result;
}

/**
 * Get user weight in pounds from profile, with fallback
 */
function getUserWeightLbs() {
    const weightEl = document.getElementById("p-weight");
    const lbs = weightEl ? parseFloat(weightEl.value) : NaN;
    return !isNaN(lbs) && lbs > 0 ? lbs : 154; // Default ~70kg
}

/**
 * Unified Gemini call with expert-level prompt for accurate calorie estimation.
 * Calls secure Cloud Function instead of direct API.
 */
async function estimateWithGemini(text, userWeightLbs) {
    const cacheKey = `unified:${text.toLowerCase().trim()}:${userWeightLbs}`;
    if (estimationCache.has(cacheKey)) {
        return estimationCache.get(cacheKey);
    }

    // Call the secure Cloud Function
    const estimateCaloriesFunc = httpsCallable(functions, 'estimateCalories');
    
    try {
        const result = await estimateCaloriesFunc({
            userText: text,
            userWeightLbs: userWeightLbs
        });
        
        if (!result.data || !result.data.success) {
            throw new Error('Invalid response from server');
        }
        
        const parsed = extractJsonFromResponse(result.data.rawText);
        const validated = validateAndNormalizeResult(parsed, text);
        
        estimationCache.set(cacheKey, validated);
        return validated;
    } catch (error) {
        console.error('Cloud function error:', error);
        throw new Error(error.message || 'Failed to estimate calories');
    }
}

/**
 * Extract JSON from Gemini response (handles markdown code blocks)
 */
function extractJsonFromResponse(rawText) {
    // Remove markdown code blocks if present
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) {
        cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
        cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // Find JSON object boundaries
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    
    if (start === -1 || end === -1) {
        throw new Error("AI response did not contain valid JSON");
    }

    const jsonStr = cleaned.substring(start, end + 1);
    
    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        throw new Error("Failed to parse AI response as JSON: " + e.message);
    }
}

/**
 * Validate and normalize the parsed result
 */
function validateAndNormalizeResult(parsed, originalText) {
    // Ensure required fields exist
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid response structure from AI");
    }

    const type = parsed.type === "exercise" ? "exercise" : "meal";
    
    // Extract and validate calorie value
    let cals = parseFloat(parsed.cals);
    if (isNaN(cals) || cals < 0) {
        throw new Error("Invalid calorie value in AI response");
    }
    
    // Apply sanity checks
    cals = applySanityChecks(cals, type, originalText);
    
    // Extract macros with defaults
    const pro = Math.max(0, parseFloat(parsed.pro) || 0);
    const fib = Math.max(0, parseFloat(parsed.fib) || 0);
    const sug = Math.max(0, parseFloat(parsed.sug) || 0);
    const fat = Math.max(0, parseFloat(parsed.fat) || 0);
    
    // Build clean name
    let name = String(parsed.name || "").trim();
    if (!name) {
        name = type === "exercise" ? "Exercise" : "Food entry";
    }
    // Truncate if too long
    if (name.length > 100) {
        name = name.substring(0, 97) + "...";
    }
    
    const confidence = ["low", "medium", "high"].includes(parsed.confidence) 
        ? parsed.confidence 
        : "medium";

    return {
        type,
        name,
        cals: Math.round(cals),
        pro: Math.round(pro * 10) / 10,
        fib: Math.round(fib * 10) / 10,
        sug: Math.round(sug * 10) / 10,
        fat: Math.round(fat * 10) / 10,
        confidence,
        source: "gemini"
    };
}

/**
 * Apply sanity checks to calorie values
 */
function applySanityChecks(cals, type, originalText) {
    const lowerText = originalText.toLowerCase();
    
    if (type === "meal") {
        // Check for small portions mentioned
        const isSmallPortion = /\b(bite|sip|taste|nibble|tiny|small)\b/.test(lowerText);
        const isLargeMeal = /\b(feast|buffet|all you can eat|huge|massive|large)\b/.test(lowerText);
        
        // Minimum sanity: even a bite should be at least 5 calories
        if (cals < 5 && !isSmallPortion) {
            console.warn("Calorie value suspiciously low, adjusting minimum");
            cals = Math.max(cals, 50);
        }
        
        // Maximum sanity: single meal rarely exceeds 3000 cal unless specified
        if (cals > 3000 && !isLargeMeal) {
            console.warn("Calorie value very high for single entry:", cals);
            // Don't cap, but log warning - the AI might be right for multiple items
        }
        
        // Very small portions check
        if (isSmallPortion && cals > 500) {
            console.warn("High calories for described small portion");
        }
    } else {
        // Exercise: rarely burns more than 1500 cal in a single session
        if (cals > 1500) {
            console.warn("Very high exercise calorie burn:", cals);
        }
        
        // Minimum: even light activity burns something
        if (cals < 10) {
            cals = Math.max(cals, 20);
        }
    }
    
    return cals;
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

    const netDeficit = t.in - t.out - tdee;
    const fatBurned = netDeficit / 3500; // 1 lb fat = 3500 calories

    document.getElementById('d-in').innerText = Math.round(t.in);
    document.getElementById('d-out').innerText = Math.round(t.out);
    document.getElementById('d-net').innerText = Math.round(netDeficit);
    document.getElementById('d-fat-burned').innerText = fatBurned.toFixed(2);
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

        // Validate result before saving
        if (!result || typeof result !== "object") {
            throw new Error("Invalid response from AI");
        }
        if (typeof result.cals !== "number" || isNaN(result.cals)) {
            throw new Error("Invalid calorie value received");
        }

        await addDoc(collection(db, "logs"), {
            uid: auth.currentUser.uid,
            timestamp: new Date(),
            ...result
        });

        input.value = "";
        const sourceLabel = result.source ? ` (${result.source})` : "";
        status.innerText = `✓ Entry added successfully${sourceLabel}!`;
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

// ===============================
// AUTH - Login Handlers
// ===============================

// Tab switcher for auth methods
window.switchAuthTab = (tab) => {
    const magicLinkTab = document.getElementById('tab-magic-link');
    const passwordTab = document.getElementById('tab-password');
    const magicLinkForm = document.getElementById('magic-link-form');
    const passwordForm = document.getElementById('password-form');
    const errorEl = document.getElementById('login-error');
    const successEl = document.getElementById('login-success');
    
    // Clear messages
    errorEl.innerText = "";
    successEl.style.display = 'none';
    
    if (tab === 'magic-link') {
        magicLinkTab.classList.add('active');
        passwordTab.classList.remove('active');
        magicLinkForm.style.display = 'block';
        passwordForm.style.display = 'none';
    } else {
        magicLinkTab.classList.remove('active');
        passwordTab.classList.add('active');
        magicLinkForm.style.display = 'none';
        passwordForm.style.display = 'block';
    }
};

// Magic Link Login
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

// Password Sign In
document.getElementById('signin-btn').onclick = async () => {
    const email = document.getElementById('email-password').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('login-error');
    const successEl = document.getElementById('login-success');
    const btn = document.getElementById('signin-btn');
    
    if (!email || !password) {
        errorEl.innerText = "Please enter both email and password";
        successEl.style.display = 'none';
        return;
    }
    
    errorEl.innerText = "";
    successEl.style.display = 'none';
    btn.disabled = true;
    btn.innerText = "Signing in...";
    
    try {
        await signInWithEmailAndPassword(auth, email, password);
        // User will be automatically redirected by onAuthStateChanged
    } catch (err) {
        console.error('Sign in error:', err);
        let errorMessage = "Error: " + err.message;
        
        if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
            errorMessage = "Incorrect email or password";
        } else if (err.code === 'auth/user-not-found') {
            errorMessage = "No account found with this email. Try creating an account first.";
        } else if (err.code === 'auth/invalid-email') {
            errorMessage = "Invalid email address";
        }
        
        errorEl.innerText = errorMessage;
    } finally {
        btn.disabled = false;
        btn.innerText = "Sign In";
    }
};

// Password Sign Up
document.getElementById('signup-btn').onclick = async () => {
    const email = document.getElementById('email-password').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('login-error');
    const successEl = document.getElementById('login-success');
    const btn = document.getElementById('signup-btn');
    
    if (!email || !password) {
        errorEl.innerText = "Please enter both email and password";
        successEl.style.display = 'none';
        return;
    }
    
    if (password.length < 6) {
        errorEl.innerText = "Password must be at least 6 characters";
        successEl.style.display = 'none';
        return;
    }
    
    errorEl.innerText = "";
    successEl.style.display = 'none';
    btn.disabled = true;
    btn.innerText = "Creating account...";
    
    try {
        await createUserWithEmailAndPassword(auth, email, password);
        // User will be automatically redirected by onAuthStateChanged
        successEl.innerText = "✓ Account created successfully!";
        successEl.style.display = 'block';
    } catch (err) {
        console.error('Sign up error:', err);
        let errorMessage = "Error: " + err.message;
        
        if (err.code === 'auth/email-already-in-use') {
            errorMessage = "An account with this email already exists. Try signing in instead.";
        } else if (err.code === 'auth/invalid-email') {
            errorMessage = "Invalid email address";
        } else if (err.code === 'auth/weak-password') {
            errorMessage = "Password is too weak. Please use a stronger password.";
        }
        
        errorEl.innerText = errorMessage;
    } finally {
        btn.disabled = false;
        btn.innerText = "Create Account";
    }
};

document.getElementById('logout-btn').onclick = () => signOut(auth);