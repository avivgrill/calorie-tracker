import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
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
let userGoal = null;
let userTDEE = 0; // Store TDEE in memory

onAuthStateChanged(auth, (user) => {
    document.getElementById('auth-view').classList.toggle('hidden', !!user);
    document.getElementById('app-view').classList.toggle('hidden', !user);
    if (user) { 
        // Load profile and goals first, then data, so TDEE and goal are available
        loadProfile(user.uid).then(async () => {
            await loadGoals(user.uid);
            loadData(user.uid);
        });
    }
});

// --- AI LOGIC (Unified Estimation with Expert Prompt) ---

/**
 * Main entry point for AI-powered calorie estimation.
 * Uses a comprehensive prompt that parses, estimates, and summarizes in one call.
 */
async function callGemini(text) {
    const userWeightLbs = getUserWeightLbs();
    const userHeightInches = getUserHeightInches();
    const userAge = getUserAge();
    const userGender = getUserGender();
    const result = await estimateWithGemini(text, userWeightLbs, userHeightInches, userAge, userGender);
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
 * Get user height in inches from profile, with fallback
 */
function getUserHeightInches() {
    const heightEl = document.getElementById("p-height");
    const inches = heightEl ? parseFloat(heightEl.value) : NaN;
    return !isNaN(inches) && inches > 0 ? inches : null;
}

/**
 * Get user age from profile, with fallback
 */
function getUserAge() {
    const ageEl = document.getElementById("p-age");
    const age = ageEl ? parseInt(ageEl.value) : NaN;
    return !isNaN(age) && age > 0 ? age : null;
}

/**
 * Get user gender from profile, with fallback
 */
function getUserGender() {
    const genderEl = document.getElementById("p-gender");
    return genderEl ? genderEl.value : null;
}

/**
 * Unified Gemini call with expert-level prompt for accurate calorie estimation.
 * Calls secure Cloud Function instead of direct API.
 */
async function estimateWithGemini(text, userWeightLbs, userHeightInches, userAge, userGender) {
    // Include relevant user data in cache key for exercises (weight affects calories)
    // For meals, weight doesn't affect calories, so we can use a simpler key
    const cacheKey = `unified:${text.toLowerCase().trim()}:${userWeightLbs}${userHeightInches ? `:${userHeightInches}` : ''}${userAge ? `:${userAge}` : ''}${userGender ? `:${userGender}` : ''}`;
    if (estimationCache.has(cacheKey)) {
        return estimationCache.get(cacheKey);
    }

    // Call the secure Cloud Function
    const estimateCaloriesFunc = httpsCallable(functions, 'estimateCalories');
    
    try {
        const result = await estimateCaloriesFunc({
            userText: text,
            userWeightLbs: userWeightLbs,
            userHeightInches: userHeightInches || null,
            userAge: userAge || null,
            userGender: userGender || null
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
    
    // Extract and validate calorie value - trust Gemini's output
    let cals = parseFloat(parsed.cals);
    if (isNaN(cals) || cals < 0) {
        throw new Error("Invalid calorie value in AI response");
    }
    
    // Extract macros - trust Gemini's output
    let pro = Math.max(0, parseFloat(parsed.pro) || 0);
    let fib = Math.max(0, parseFloat(parsed.fib) || 0);
    let sug = Math.max(0, parseFloat(parsed.sug) || 0);
    let fat = Math.max(0, parseFloat(parsed.fat) || 0);
    
    // For exercise, ensure macros are 0 (as per prompt requirement)
    if (type === "exercise") {
        pro = 0;
        fib = 0;
        sug = 0;
        fat = 0;
    }
    
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

// Removed applySanityChecks - we trust Gemini's output directly

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
    // Use stored TDEE from memory, fallback to DOM element if available
    const tdee = userTDEE || (document.getElementById('p-tdee-display') ? parseInt(document.getElementById('p-tdee-display').innerText) || 0 : 0);

    allLogs.filter(l => l.date.toLocaleDateString() === today).forEach(item => {
        list.appendChild(createLogEl(item));
        if (item.type === 'meal') {
            t.in += (item.cals || 0); t.p += (item.pro||0); t.f += (item.fib||0); t.s += (item.sug||0); t.ft += (item.fat||0);
        } else { t.out += (item.cals || 0); }
    });

    document.getElementById('d-in').innerText = Math.round(t.in);
    document.getElementById('d-out').innerText = Math.round(t.out);
    
    // Update fat burned/gained display based on calorie deficit/surplus
    if (tdee > 0) {
        const caloriePool = tdee + t.out; // TDEE + exercise = total calorie pool
        const caloriesEaten = t.in;
        const deficitSurplus = caloriesEaten - caloriePool; // Negative = deficit, Positive = surplus
        const fatChange = deficitSurplus / 3500; // 1 lb fat = 3500 calories
        
        const fatLabel = document.getElementById('d-fat-label');
        const fatValue = document.getElementById('d-fat-value');
        const fatCard = document.getElementById('fat-card');
        
        if (fatLabel && fatValue && fatCard) {
            if (deficitSurplus < 0) {
                // Deficit - show fat burned
                fatLabel.innerText = 'Fat Burned';
                fatValue.innerText = Math.abs(fatChange).toFixed(2);
                fatValue.style.color = 'var(--text-dark)';
                fatCard.style.background = '#f8f9fa';
                fatCard.style.borderColor = '#edf2f7';
            } else if (deficitSurplus > 0) {
                // Surplus - show fat gained
                fatLabel.innerText = 'Fat Gained';
                fatValue.innerText = fatChange.toFixed(2);
                fatValue.style.color = '#d63031';
                fatCard.style.background = '#ffeaea';
                fatCard.style.borderColor = '#d63031';
            } else {
                // At maintenance
                fatLabel.innerText = 'Fat Burned';
                fatValue.innerText = '0.00';
                fatValue.style.color = 'var(--text-dark)';
                fatCard.style.background = '#f8f9fa';
                fatCard.style.borderColor = '#edf2f7';
            }
        }
    } else {
        // TDEE not set
        const fatLabel = document.getElementById('d-fat-label');
        const fatValue = document.getElementById('d-fat-value');
        if (fatLabel && fatValue) {
            fatLabel.innerText = 'Fat Burned';
            fatValue.innerText = '0.00';
        }
    }
    
    // Update calorie consumption progress wheel
    // Only show if TDEE is set (greater than 0)
    if (tdee > 0) {
        const caloriePool = tdee + t.out; // TDEE + exercise = total calorie pool
        const caloriesEaten = t.in;
        const deficitSurplus = caloriesEaten - caloriePool; // Negative = deficit, Positive = surplus
        const isSurplus = deficitSurplus > 0;

        // Calculate progress: what percentage of the pool has been consumed
        const progress = caloriePool > 0 ? Math.min(1, caloriesEaten / caloriePool) : 0;
        const circumference = 2 * Math.PI * 60; // radius 60 (reduced by 30%)
        const offset = circumference * (1 - progress);

        // Update circle - red border for surplus, green for deficit
        const calorieProgressCircle = document.getElementById('calorie-progress-circle');
        if (calorieProgressCircle) {
            calorieProgressCircle.style.strokeDashoffset = offset;
            calorieProgressCircle.style.stroke = isSurplus ? '#d63031' : '#00b894'; // Red for surplus, green for deficit
        }

        // Update center display
        const deficitNumber = document.getElementById('calorie-deficit-number');
        const deficitLabel = document.getElementById('calorie-deficit-label');
        if (deficitNumber && deficitLabel) {
            // Show plus symbol for surplus
            const displayValue = isSurplus ? `+${Math.round(deficitSurplus)}` : Math.round(deficitSurplus);
            deficitNumber.innerText = displayValue;
            deficitLabel.innerText = isSurplus ? 'calorie surplus' : 'calorie deficit';
            // Color: red for surplus, default for deficit
            deficitNumber.style.color = isSurplus ? '#d63031' : 'var(--text-dark)';
        }
        
        // Update deficit goal label and calories remaining if goal is set
        const goal = userGoal?.dailyDeficitGoal || 0;
        const goalLabel = document.getElementById('calorie-goal-label');
        const goalValue = document.getElementById('calorie-goal-value');
        const remainingLabel = document.getElementById('calorie-remaining-label');
        const remainingValue = document.getElementById('calorie-remaining-value');
        
        if (goal > 0 && caloriePool > 0) {
            // Show goal label
            if (goalLabel && goalValue) {
                goalValue.innerText = `-${goal}`;
                goalLabel.style.display = 'block';
            }
            
            // Calculate calories remaining to reach goal
            // Goal means eating (caloriePool - goal) calories
            // Remaining = (caloriePool - goal) - caloriesEaten
            const goalCalories = caloriePool - goal;
            const caloriesRemaining = goalCalories - caloriesEaten;
            
            // Update remaining calories display
            if (remainingLabel && remainingValue) {
                if (caloriesRemaining > 0) {
                    remainingValue.innerText = Math.round(caloriesRemaining);
                    remainingLabel.style.display = 'block';
                    remainingValue.style.color = 'var(--text-dark)';
                } else if (caloriesRemaining <= 0 && !isSurplus) {
                    // At or past goal but not in surplus
                    remainingValue.innerText = '0';
                    remainingLabel.style.display = 'block';
                    remainingValue.style.color = '#00b894';
                } else {
                    // In surplus - exceeded goal
                    remainingLabel.style.display = 'none';
                }
            }
        } else {
            // Hide goal elements if no goal set
            if (goalLabel) goalLabel.style.display = 'none';
            if (remainingLabel) remainingLabel.style.display = 'none';
        }
    } else {
        // TDEE not set - hide or show placeholder
        const calorieProgressCircle = document.getElementById('calorie-progress-circle');
        const deficitNumber = document.getElementById('calorie-deficit-number');
        const deficitLabel = document.getElementById('calorie-deficit-label');
        if (calorieProgressCircle) {
            calorieProgressCircle.style.strokeDashoffset = 534.07; // Empty circle
        }
        if (deficitNumber && deficitLabel) {
            deficitNumber.innerText = '0';
            deficitLabel.innerText = 'Set TDEE in Profile';
        }
    }
    
    // Round macros to nearest tenth of a gram
    document.getElementById('h-pro').innerText = (Math.round(t.p * 10) / 10).toFixed(1);
    document.getElementById('h-fib').innerText = (Math.round(t.f * 10) / 10).toFixed(1);
    document.getElementById('h-sug').innerText = (Math.round(t.s * 10) / 10).toFixed(1);
    document.getElementById('h-fat').innerText = (Math.round(t.ft * 10) / 10).toFixed(1);
    
    // Update circular progress indicator for deficit goal
    const goal = userGoal?.dailyDeficitGoal || 0;
    const progressContainer = document.getElementById('deficit-progress-container');
    const progressCircle = document.getElementById('deficit-progress-circle');
    const yellowCircle = document.getElementById('deficit-yellow-circle');
    const overCircle = document.getElementById('deficit-over-circle');
    const progressNumber = document.getElementById('deficit-progress-number');
    const progressLabel = document.getElementById('deficit-progress-label');
    const goalDisplay = document.getElementById('deficit-goal-display');
    const caloriesRemaining = document.getElementById('calories-remaining');
    const goalLine = document.getElementById('deficit-goal-line');
    const warningEl = document.getElementById('deficit-warning');
    
    if (goal > 0) {
        // Calculate calories remaining (TDEE + exercise - eaten)
        const caloriesAvailable = tdee + t.out - t.in;
        caloriesRemaining.innerText = Math.max(0, Math.round(caloriesAvailable));
        goalDisplay.innerText = goal;
        
        // Calculate maximum possible deficit (if they eat 0 calories)
        // netDeficit = eaten - burned - TDEE
        // If eaten = 0: netDeficit = 0 - burned - TDEE = -(burned + TDEE)
        const maxDeficit = tdee + t.out; // e.g., 2000 (this is the maximum deficit as a positive number)
        
        // Circle mapping:
        // 12 o'clock (0° in rotated SVG) = 0 deficit (netDeficit = 0) - one full revolution
        // The circle represents total calorie deficit from 0 (12 o'clock) to maxDeficit (back to 12 o'clock)
        // Goal line position is proportional to the goal relative to maxDeficit
        // Example: goal=500, maxDeficit=2000 → goal is at 3/4 of the way = 270° (9 o'clock)
        // Example: goal=1000, maxDeficit=2000 → goal is at 1/2 of the way = 180° (6 o'clock)
        
        const circumference = 2 * Math.PI * 75; // radius 75
        
        // Calculate goal line position
        // Position from 12 o'clock: (1 - goal / maxDeficit) * 360°
        // This gives us the angle where the goal line should be placed
        const goalAngleDegrees = (1 - goal / maxDeficit) * 360;
        const goalRadians = (goalAngleDegrees - 90) * Math.PI / 180; // -90 because SVG is rotated -90deg
        const goalX = 90 + 75 * Math.cos(goalRadians);
        const goalY = 90 + 75 * Math.sin(goalRadians);
        const goalX2 = 90 + 85 * Math.cos(goalRadians);
        const goalY2 = 90 + 85 * Math.sin(goalRadians);
        
        // Show goal line
        goalLine.setAttribute('x1', goalX);
        goalLine.setAttribute('y1', goalY);
        goalLine.setAttribute('x2', goalX2);
        goalLine.setAttribute('y2', goalY2);
        goalLine.style.opacity = '1';
        
        // Reset all circles
        yellowCircle.style.opacity = '0';
        overCircle.style.opacity = '0';
        
        // Map netDeficit to circle position
        // netDeficit = 0 → 12 o'clock (0° = 360°)
        // netDeficit = maxDeficit → back to 12 o'clock (full circle)
        // Formula: (1 - netDeficit / maxDeficit) * 360° gives angle from 12 o'clock
        // Note: netDeficit can be negative when you've eaten more than TDEE + exercise (surplus)
        // But at start of day (0 eaten, 0 exercise), netDeficit = -tdee, which is not a surplus
        // actualSurplus is already calculated above
        
        // Calculate current position on circle
        // If we're in actual surplus, show full red circle
        // Otherwise, calculate position based on netDeficit (clamp to 0 if negative but not surplus)
        let displayDeficit = netDeficit;
        if (netDeficit < 0 && !actualSurplus) {
            // Negative but not surplus (e.g., start of day) - show as 0 deficit
            displayDeficit = 0;
        }
        
        const currentAngle = (1 - displayDeficit / maxDeficit) * 360;
        const currentProgress = Math.max(0, Math.min(1, currentAngle / 360)); // Clamp between 0 and 1
        const currentOffset = circumference * (1 - currentProgress);
        
        if (actualSurplus) {
            // Surplus (eaten more than TDEE + exercise) - fill entire circle red
            progressCircle.style.strokeDashoffset = 0; // Full circle
            progressCircle.style.stroke = '#d63031';
            yellowCircle.style.opacity = '0';
            overCircle.style.opacity = '0';
            progressNumber.style.color = '#d63031';
            progressLabel.innerText = 'cal surplus';
            warningEl.style.display = 'none'; // Hide warning, label already says surplus
        } else if (displayDeficit >= goal) {
            // At or above goal deficit - fill green up to current position
            progressCircle.style.strokeDashoffset = currentOffset;
            progressCircle.style.stroke = '#00b894';
            yellowCircle.style.opacity = '0';
            overCircle.style.opacity = '0';
            progressNumber.style.color = 'var(--text-dark)';
            progressLabel.innerText = 'cal deficit';
            warningEl.style.display = 'none';
        } else {
            // Between 0 and goal: 
            // - Green from 12 o'clock (0 deficit) up to goal line
            // - Yellow from goal line to current position (between goal and 0)
            const goalProgress = (1 - goal / maxDeficit); // Progress at goal line (0 to 1)
            const goalOffset = circumference * (1 - goalProgress);
            
            // Green circle: fill from 12 o'clock to goal line
            progressCircle.style.strokeDashoffset = goalOffset;
            progressCircle.style.stroke = '#00b894';
            
            // Yellow circle: fill from goal line to current position
            // Yellow portion is the distance from goal line to current position
            // Since circles start at 12 o'clock, we need to:
            // 1. Calculate yellow length: from goal to current
            // 2. Position it so it starts at goal line and ends at current
            const yellowLength = goalProgress - currentProgress; // Portion of circle to fill with yellow
            const yellowDashLength = circumference * yellowLength; // Actual dash length
            const yellowGapLength = circumference - yellowDashLength; // Gap to hide the rest
            
            if (yellowLength > 0 && maxDeficit > 0) {
                // Use stroke-dasharray to show only the yellow portion
                // Offset it so it starts at the goal line position
                yellowCircle.setAttribute('stroke-dasharray', `${yellowDashLength} ${yellowGapLength}`);
                // Offset to position yellow starting at goal line
                // Goal line is at offset = goalOffset from 12 o'clock
                // But we want yellow to start there, so we offset by the gap before it
                const yellowOffset = circumference * (1 - goalProgress); // Start at goal line
                yellowCircle.style.strokeDashoffset = yellowOffset;
                yellowCircle.style.opacity = '1';
            } else {
                yellowCircle.style.opacity = '0';
            }
            
            overCircle.style.opacity = '0';
            progressNumber.style.color = '#d63031';
            progressLabel.innerText = 'cal deficit';
            warningEl.style.display = 'block';
            warningEl.innerText = 'Below deficit goal';
        }
        
        // Display the actual netDeficit value (not the clamped displayDeficit)
        // Show absolute value when in surplus
        if (actualSurplus) {
            progressNumber.innerText = Math.abs(Math.round(netDeficit));
        } else {
            progressNumber.innerText = Math.round(netDeficit);
        }
        progressContainer.style.display = 'block';
    } else {
        progressContainer.style.display = 'none';
    }
    
    // Reset delete button
    updateDeleteButton();
}

window.renderMaster = function() {
    console.log("renderMaster() called, allLogs length:", allLogs ? allLogs.length : 0);
    
    const list = document.getElementById('master-list');
    if (!list) {
        console.error("master-list element not found");
        return;
    }
    
    list.innerHTML = "";
    
    if (!allLogs || allLogs.length === 0) {
        console.log("No logs to display in master list");
        return;
    }
    
    let lastDate = "";
    allLogs.forEach(item => {
        try {
            if (!item.date) {
                console.warn("Log item missing date:", item);
                return;
            }
            
            // Ensure date is a Date object
            const date = item.date instanceof Date ? item.date : new Date(item.date);
            const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            
            if (dateStr !== lastDate) {
                const h = document.createElement('div'); 
                h.style = "font-weight:700; color:#b2bec3; font-size:0.8rem; margin:15px 0 5px; text-transform:uppercase;";
                h.innerText = dateStr;
                list.appendChild(h); 
                lastDate = dateStr;
            }
            list.appendChild(createLogEl(item));
        } catch (error) {
            console.error("Error rendering log item:", error, item);
        }
    });
    
    console.log("renderMaster() completed, rendered", list.children.length, "elements");
    
    // Reset delete button
    updateDeleteButton();
};

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
        // Uncheck all checkboxes before reloading
        document.querySelectorAll('.entry-checkbox').forEach(cb => cb.checked = false);
        // Update delete button immediately
        updateDeleteButton();
        // Then reload data
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
        <div style="background: #e3fcef; padding: 20px; border-radius: 6px; text-align: center; margin-bottom: 20px;">
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
    try {
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) {
            const d = snap.data();
            // Store TDEE in memory
            userTDEE = d.tdee || 0;
            // Load profile data into form fields
            if (document.getElementById('p-weight')) {
                document.getElementById('p-weight').value = d.weight || "";
            }
            if (document.getElementById('p-height')) {
                document.getElementById('p-height').value = d.height || "";
            }
            if (document.getElementById('p-age')) {
                document.getElementById('p-age').value = d.age || "";
            }
            if (document.getElementById('p-gender')) {
                document.getElementById('p-gender').value = d.gender || "male";
            }
            if (document.getElementById('p-activity')) {
                document.getElementById('p-activity').value = d.activityLevel || "1.2";
            }
            // Always update TDEE display if it exists in the document
            if (document.getElementById('p-tdee-display')) {
                document.getElementById('p-tdee-display').innerText = userTDEE;
            }
        }
    } catch (error) {
        console.error('Error loading profile:', error);
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
    // Update stored TDEE in memory
    userTDEE = tdee;
    document.getElementById('p-tdee-display').innerText = tdee;
    alert("Profile Updated!"); loadData(auth.currentUser.uid);
    // Update goals tab if weight changed
    if (document.getElementById('g-current-weight')) {
        document.getElementById('g-current-weight').value = w || "";
        updateDaysEstimate();
    }
};

// --- GOALS ---
window.updateGoalsTab = function() {
    const currentWeightEl = document.getElementById('g-current-weight');
    if (currentWeightEl) {
        const currentWeight = parseFloat(document.getElementById('p-weight').value) || 0;
        currentWeightEl.value = currentWeight || "";
        updateDaysEstimate();
    }
};

async function loadGoals(uid) {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
        const d = snap.data();
        userGoal = {
            targetWeight: d.targetWeight || null,
            dailyDeficitGoal: d.dailyDeficitGoal || null
        };
        
        // Update goals tab if it exists
        if (document.getElementById('g-current-weight')) {
            const currentWeight = parseFloat(document.getElementById('p-weight').value) || 0;
            document.getElementById('g-current-weight').value = currentWeight || "";
            
            if (userGoal.targetWeight) {
                document.getElementById('g-target-weight').value = userGoal.targetWeight;
            }
            
            if (userGoal.dailyDeficitGoal) {
                document.getElementById('g-deficit-slider').value = userGoal.dailyDeficitGoal;
                document.getElementById('g-deficit-value').innerText = userGoal.dailyDeficitGoal;
            }
            
            updateDaysEstimate();
        }
    }
}

function calculateDaysToTarget(currentWeight, targetWeight, dailyDeficit) {
    if (!currentWeight || !targetWeight || !dailyDeficit || dailyDeficit <= 0) {
        return null;
    }
    
    if (targetWeight >= currentWeight) {
        return null; // Invalid target (not losing weight)
    }
    
    const weightDiff = currentWeight - targetWeight;
    const totalCaloriesNeeded = weightDiff * 3500; // 1 lb = 3500 calories
    const days = totalCaloriesNeeded / dailyDeficit;
    
    return Math.ceil(days);
}

function updateDaysEstimate() {
    // Only calculate if we have all required values
    const currentWeightEl = document.getElementById('g-current-weight');
    const targetWeightEl = document.getElementById('g-target-weight');
    const deficitSliderEl = document.getElementById('g-deficit-slider');
    
    if (!currentWeightEl || !targetWeightEl || !deficitSliderEl) {
        return; // Elements don't exist yet
    }
    
    const currentWeight = parseFloat(currentWeightEl.value) || 0;
    const targetWeight = parseFloat(targetWeightEl.value) || 0;
    const deficit = parseInt(deficitSliderEl.value) || 0;
    
    // Ensure we're using the goal deficit from slider, not actual deficit
    if (!currentWeight || !targetWeight || !deficit || deficit <= 0) {
        document.getElementById('g-estimated-days').style.display = 'none';
        return;
    }
    
    const days = calculateDaysToTarget(currentWeight, targetWeight, deficit);
    const daysBox = document.getElementById('g-estimated-days');
    
    if (days !== null && days > 0) {
        document.getElementById('g-days-display').innerText = days;
        const deficitDisplay = document.getElementById('g-days-deficit-display');
        if (deficitDisplay) {
            deficitDisplay.innerText = deficit;
        }
        daysBox.style.display = 'block';
    } else {
        daysBox.style.display = 'none';
    }
}


// Slider event handler (set up when DOM is ready)
const sliderEl = document.getElementById('g-deficit-slider');
if (sliderEl) {
    sliderEl.addEventListener('input', (e) => {
        const deficit = parseInt(e.target.value);
        document.getElementById('g-deficit-value').innerText = deficit;
        updateDaysEstimate();
    });
}

// Target weight input handler (set up when DOM is ready)
const targetWeightEl = document.getElementById('g-target-weight');
if (targetWeightEl) {
    targetWeightEl.addEventListener('input', () => {
        updateDaysEstimate();
    });
}

// Save goal button handler (set up when DOM is ready)
const saveGoalEl = document.getElementById('save-goal');
if (saveGoalEl) {
    saveGoalEl.onclick = async () => {
        const targetWeight = parseFloat(document.getElementById('g-target-weight').value);
        const dailyDeficit = parseInt(document.getElementById('g-deficit-slider').value);
        const currentWeight = parseFloat(document.getElementById('g-current-weight').value);
        
        if (!currentWeight) {
            alert("Please set your current weight in the Profile tab first.");
            return;
        }
        
        if (!targetWeight || targetWeight <= 0) {
            alert("Please enter a valid target weight.");
            return;
        }
        
        if (targetWeight >= currentWeight) {
            alert("Target weight must be less than current weight.");
            return;
        }
        
        if (!dailyDeficit || dailyDeficit <= 0) {
            alert("Please set a daily calorie deficit.");
            return;
        }
        
        userGoal = {
            targetWeight: targetWeight,
            dailyDeficitGoal: dailyDeficit
        };
        
        await setDoc(doc(db, "users", auth.currentUser.uid), {
            targetWeight: targetWeight,
            dailyDeficitGoal: dailyDeficit
        }, { merge: true });
        
        alert("Goal saved! Your daily calorie deficit target is set to " + dailyDeficit + " calories below your TDEE.");
        loadData(auth.currentUser.uid); // Refresh home screen to show progress
    };
}

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
    const magicLinkForm = document.getElementById('magic-link-form');
    const passwordForm = document.getElementById('password-form');
    const forgotPasswordForm = document.getElementById('forgot-password-form');
    const errorEl = document.getElementById('login-error');
    const successEl = document.getElementById('login-success');
    
    // Clear messages
    errorEl.innerText = "";
    successEl.style.display = 'none';
    
    if (tab === 'magic-link') {
        magicLinkForm.style.display = 'block';
        passwordForm.style.display = 'none';
        forgotPasswordForm.style.display = 'none';
    } else if (tab === 'forgot-password') {
        magicLinkForm.style.display = 'none';
        passwordForm.style.display = 'none';
        forgotPasswordForm.style.display = 'block';
    } else {
        magicLinkForm.style.display = 'none';
        passwordForm.style.display = 'block';
        forgotPasswordForm.style.display = 'none';
    }
};

// Link click handlers
document.getElementById('switch-to-magic').onclick = (e) => {
    e.preventDefault();
    switchAuthTab('magic-link');
};

document.getElementById('switch-to-password').onclick = (e) => {
    e.preventDefault();
    switchAuthTab('password');
};

document.getElementById('forgot-password-link').onclick = (e) => {
    e.preventDefault();
    // Pre-fill email if entered
    const emailPassword = document.getElementById('email-password').value.trim();
    if (emailPassword) {
        document.getElementById('email-reset').value = emailPassword;
    }
    switchAuthTab('forgot-password');
};

document.getElementById('back-to-login').onclick = (e) => {
    e.preventDefault();
    switchAuthTab('password');
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

// Password Reset
document.getElementById('reset-btn').onclick = async () => {
    const email = document.getElementById('email-reset').value.trim();
    const errorEl = document.getElementById('login-error');
    const successEl = document.getElementById('login-success');
    const btn = document.getElementById('reset-btn');
    
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
        await sendPasswordResetEmail(auth, email);
        successEl.innerText = `✓ Password reset link sent to ${email}! Check your inbox.`;
        successEl.style.display = 'block';
        document.getElementById('email-reset').value = "";
        
        // Return to login after 3 seconds
        setTimeout(() => {
            switchAuthTab('password');
        }, 3000);
    } catch (err) {
        console.error('Password reset error:', err);
        let errorMessage = "Error: " + err.message;
        
        if (err.code === 'auth/user-not-found') {
            // Don't reveal if user exists for security
            successEl.innerText = `✓ If an account exists with ${email}, a password reset link has been sent.`;
            successEl.style.display = 'block';
            document.getElementById('email-reset').value = "";
            setTimeout(() => {
                switchAuthTab('password');
            }, 3000);
        } else if (err.code === 'auth/invalid-email') {
            errorMessage = "Invalid email address";
            errorEl.innerText = errorMessage;
        } else {
            errorEl.innerText = errorMessage;
        }
    } finally {
        btn.disabled = false;
        btn.innerText = "Send Reset Link";
    }
};

document.getElementById('logout-btn').onclick = () => signOut(auth);