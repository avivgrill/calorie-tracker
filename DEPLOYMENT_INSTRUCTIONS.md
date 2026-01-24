# API Security Implementation - Next Steps

## Status: Code Updated ✓

All code changes are complete. The Gemini API key has been removed from client-side code and moved to a secure Cloud Function.

---

## CRITICAL: Manual Steps Required

### Step 1: Regenerate Compromised API Keys

**You must do this immediately:**

1. Go to [Google Cloud Console - API Credentials](https://console.cloud.google.com/apis/credentials)
2. Find and **DELETE** the exposed Gemini API key: `AIzaSyACPV9P_a7zXj2plhtwobPGobaaCILcCWQ`
3. Create a **new API key** for backend use
4. Restrict the new key to only allow "Generative Language API"

### Step 2: Install Firebase CLI

If you don't have Firebase CLI installed:

```bash
sudo npm install -g firebase-tools
```

Or install without sudo:
```bash
npm install -g firebase-tools
```

### Step 3: Login to Firebase

```bash
firebase login
```

### Step 4: Initialize Firebase (if not already)

```bash
cd /Users/aviv/Desktop/calorie-tracker
firebase init
```

Select:
- Functions (already set up in this repo)
- Use existing project: calorie-tracker-app-1a441

### Step 5: Set the Gemini API Key in Cloud Functions

Replace `YOUR_NEW_API_KEY` with the key you generated in Step 1:

```bash
cd /Users/aviv/Desktop/calorie-tracker
firebase functions:config:set gemini.key="YOUR_NEW_API_KEY"
```

### Step 6: Install Function Dependencies

```bash
cd /Users/aviv/Desktop/calorie-tracker/functions
npm install
```

### Step 7: Deploy the Cloud Function

```bash
cd /Users/aviv/Desktop/calorie-tracker
firebase deploy --only functions
```

This will deploy the `estimateCalories` function to Firebase.

### Step 8: Force Push to Remove Keys from Remote

**WARNING:** This rewrites history. Only do this if you're the only one working on this repo.

```bash
cd /Users/aviv/Desktop/calorie-tracker
git push origin main --force
```

If others are collaborating, notify them first.

---

## What Changed

### Files Created:
- `functions/index.js` - Cloud Function with Gemini API logic
- `functions/package.json` - Node dependencies
- `.gitignore` - Excludes sensitive files

### Files Modified:
- `auth.js` - Removed API key, now calls Cloud Function
- Git history - All API keys replaced with "REMOVED_*_KEY"

### How It Works Now:

1. User enters food/exercise in the app
2. Client calls `estimateWithGemini(text, weight)`
3. Function calls Firebase Cloud Function (secure backend)
4. Cloud Function calls Gemini API with secure key
5. Result returned to client
6. Client displays result

---

## Testing After Deployment

1. Open your app in a browser
2. Try entering: "2 eggs and toast"
3. Check the browser console for any errors
4. Check Firebase Console → Functions → Logs for function execution

---

## Costs

Firebase Cloud Functions:
- **Free tier:** 2 million invocations/month
- **After free tier:** $0.40 per million invocations

For personal use, you'll stay well within the free tier.

---

## Security Verification

✓ Gemini API key removed from client code
✓ Git history cleaned (keys replaced)
✓ .gitignore prevents future key exposure
✓ Cloud Function requires authentication
✓ API key stored in Firebase environment config (never in code)

---

## If You Run Into Issues

Common problems:

1. **"firebase: command not found"**
   - Install Firebase CLI: `sudo npm install -g firebase-tools`

2. **"API key not configured"**
   - Run: `firebase functions:config:set gemini.key="YOUR_KEY"`

3. **"Function not found" or CORS errors**
   - Make sure you deployed: `firebase deploy --only functions`
   - Check Firebase Console → Functions to see if it's deployed

4. **Permission errors during deploy**
   - Run: `firebase login` and ensure you're logged in with the correct account

---

## Firebase API Key Note

The Firebase API key in `firebase-config.js` is **safe to leave public**. It's designed for client-side use. Security is enforced through:
- Firestore security rules (already configured)
- Firebase Authentication
- Cloud Function authentication checks

Only the Gemini key needed to be secured.
