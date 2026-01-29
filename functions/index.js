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
    systemInstruction: {
      parts: [{
        text: "Act as a Nutritional Data Parser. When analyzing meals, first identify individual ingredients, " +
              "then assign standard USDA-based portion sizes for any missing quantities. For vague inputs " +
              "(e.g., 'a burrito'), use standard references (e.g., 10-inch flour tortilla, beans, rice, cheese, salsa). " +
              "Return valid JSON only - no conversational text, no explanations."
      }]
    },
    generationConfig: {
      temperature: 0.1,
      response_mime_type: "application/json"
    }
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
 * Build a simple, direct prompt for accurate calorie/exercise estimation
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

For exercises, estimate calories burned accurately based on exercise type, duration, intensity, and user characteristics. Use your training data on exercise physiology and calorie burn rates. Set pro/fib/sug/fat to 0.

For meals, follow this logic:
1. Identify all individual ingredients in the meal description.
2. For each ingredient, if quantity is missing, assign a standard USDA-based portion size.
3. Pay careful attention to quantities and multipliers. If the user says "2 coffee" or "3 eggs", multiply the calories and macros by that number (e.g., "2 coffee with a splash of milk" should be approximately double the calories of "1 coffee with a splash of milk").
4. For vague inputs without specific quantities, use typical reference serving sizes from standard nutrition databases (e.g., one sandwich, one cup of coffee, one standard burrito).
5. Use standard nutrition databases (USDA, nutrition labels) to estimate calories and macros. Be accurate and realistic—do not overestimate. Use typical serving sizes and common preparation methods.`;
}
