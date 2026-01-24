const functions = require('firebase-functions');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const fetch = require('node-fetch');

// Define the Gemini API key as a secret
const geminiApiKey = defineSecret('GEMINI_API_KEY');

/**
 * Cloud Function to estimate calories using Gemini API.
 * This keeps the API key secure on the backend.
 */
exports.estimateCalories = onCall(
  { secrets: [geminiApiKey] },
  async (request) => {
    // Require authentication
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'User must be authenticated to use this function'
      );
    }

    const { userText, userWeightLbs, userHeightInches, userAge, userGender } = request.data;

    // Validate input
    if (!userText || typeof userText !== 'string') {
      throw new HttpsError(
        'invalid-argument',
        'userText is required and must be a string'
      );
    }

    if (!userWeightLbs || typeof userWeightLbs !== 'number') {
      throw new HttpsError(
        'invalid-argument',
        'userWeightLbs is required and must be a number'
      );
    }

    // Get API key from secret
    const GEMINI_KEY = geminiApiKey.value();
    
    if (!GEMINI_KEY) {
      console.error('Gemini API key not configured');
      throw new HttpsError(
        'failed-precondition',
        'API key not configured'
      );
    }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;

  // Build the expert prompt
  const prompt = buildExpertPrompt(userText, userWeightLbs, userHeightInches, userAge, userGender);

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1 }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers: { 'Content-Type': 'application/json' }
    });

    const result = await response.json();
    
    if (result.error) {
      console.error('Gemini API error:', result.error);
      throw new HttpsError('internal', result.error.message);
    }

    // Extract the raw text response
    const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    if (!rawText) {
      throw new HttpsError('internal', 'Empty response from Gemini API');
    }

    // Return the raw text - let client handle parsing
    return { success: true, rawText };
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    throw new HttpsError(
      'internal',
      error.message || 'Failed to process request'
    );
  }
});

/**
 * Build an enhanced prompt for accurate calorie/exercise estimation with METs guidance
 */
function buildExpertPrompt(userText, userWeightLbs, userHeightInches, userAge, userGender) {
  const userWeightKg = (userWeightLbs * 0.453592).toFixed(1);
  const userInfo = `User weight: ${userWeightLbs} lbs (${userWeightKg} kg)${userHeightInches ? `, Height: ${userHeightInches} inches` : ''}${userAge ? `, Age: ${userAge} years` : ''}${userGender ? `, Gender: ${userGender}` : ''}`;

  return `User input: "${userText}"
${userInfo}

Analyze this and respond with ONLY this JSON format (no markdown, no backticks):
{
  "type": "meal" or "exercise",
  "name": "clear description",
  "cals": number,
  "pro": protein_grams,
  "fib": fiber_grams,
  "sug": sugar_grams,
  "fat": fat_grams,
  "confidence": "low" or "medium" or "high"
}

FOR EXERCISES:
1. Parse the input to extract: exercise type, duration, intensity level, and pace/speed if mentioned.
   - Duration can be in minutes, hours, or distance-based (e.g., "ran 3 miles", "30 min jog", "cycling 45 min")
   - Intensity keywords: light/easy, moderate/medium, vigorous/hard/intense, sprint
   - Common formats: "ran 5 miles", "30 min moderate cycling", "1 hour yoga", "45 min swimming"

2. Use METs (Metabolic Equivalent of Task) values for accurate calorie calculation:
   - Formula: Calories = METs × weight(kg) × duration(hours)
   - Example METs values:
     * Running 5 mph (8 km/h): 8.3 METs
     * Running 6 mph (9.7 km/h): 9.8 METs
     * Running 7.5 mph (12 km/h): 11.5 METs
     * Jogging: 7.0 METs
     * Walking 3.5 mph: 4.3 METs
     * Cycling moderate (12-14 mph): 6.8 METs
     * Cycling vigorous (14-16 mph): 8.0 METs
     * Swimming moderate: 6.0 METs
     * Swimming vigorous: 10.0 METs
     * Yoga: 3.0 METs
     * Weight lifting: 5.0 METs
     * HIIT: 8.5 METs
     * Elliptical moderate: 5.0 METs
     * Rowing moderate: 7.0 METs
   
3. For exercises not in the list above, estimate METs based on:
   - Exercise type and typical intensity
   - User's described intensity level
   - Pace/speed if provided
   - Use standard METs tables as reference

4. Calculate calories using the METs formula, converting duration to hours.
   - For distance-based entries (e.g., "ran 3 miles"), estimate duration based on typical pace for that exercise type and intensity, or use average pace if not specified.

5. Set confidence based on:
   - "high": Well-known exercise with clear duration and intensity
   - "medium": Recognizable exercise but some ambiguity in duration/intensity
   - "low": Unclear exercise type or missing key details

6. Always set pro/fib/sug/fat to 0 for exercises.

FOR MEALS:
Estimate calories and macros based on your training data. Be accurate and use standard nutrition databases when possible.`;
}
